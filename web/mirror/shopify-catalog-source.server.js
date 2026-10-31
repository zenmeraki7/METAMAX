import { invalid, shop } from "./transactions.server.js";
import { validateProducts } from "./catalog-writer.server.js";

export const PRODUCT_SNAPSHOT_QUERY = `query MirrorProductSnapshot($id: ID!, $after: String) {
  product(id: $id) {
    id title handle descriptionHtml vendor productType status tags templateSuffix
    seo { title description } category { id } createdAt updatedAt publishedAt
    variants(first: 250, after: $after) {
      nodes { id title sku barcode price compareAtPrice inventoryPolicy inventoryQuantity
        requiresComponents taxable position createdAt updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function assertCatalogSession(session, shopId) {
  shop(shopId);
  if (!session || session.shop !== shopId || !session.accessToken ||
      (session.expires && (!Number.isFinite(new Date(session.expires).getTime()) || new Date(session.expires).getTime() <= Date.now())) ||
      !String(session.scope ?? "").split(",").some(scope => ["read_products", "write_products"].includes(scope.trim()))) {
    invalid("Current product-read session required");
  }
  return session;
}

export function createShopifyCatalogClient({ shopify, database, shopId, installationVersion, signal: clientSignal }) {
  shop(shopId);
  async function authorize(signal = clientSignal) {
    signal?.throwIfAborted();
    const installed = (await database.query(
      "SELECT 1 FROM mirror.shops WHERE id=$1 AND installation_version=$2 AND uninstalled_at IS NULL",
      [shopId, installationVersion],
    )).rowCount;
    if (!installed) invalid("Import installation is unavailable or superseded");
    const sessions = await shopify.config.sessionStorage.findSessionsByShop(shopId);
    const session = sessions.find(candidate => candidate.isOnline === false && candidate.shop === shopId);
    signal?.throwIfAborted();
    return assertCatalogSession(session, shopId);
  }
  return Object.freeze({
    authorize,
    async request(query, options = {}) {
      const requestSignal = options?.signal ?? clientSignal;
      const session = await authorize(requestSignal);
      const client = new shopify.api.clients.Graphql({ session });
      return client.request(query, options);
    },
  });
}

export async function readCompleteProduct({ client, productId, signal }) {
  if (!/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(productId)) invalid("Product identity required");
  let product, after;
  const cursors = new Set();
  do {
    signal?.throwIfAborted();
    const response = await client.request(PRODUCT_SNAPSHOT_QUERY, { variables: { id: productId, after: after ?? null } });
    if (response.errors || !response.data || !Object.hasOwn(response.data, "product")) invalid("Incomplete product response");
    const current = response.data.product;
    if (current === null && !product) return { complete: true, product: null };
    if (!current || current.id !== productId || !Array.isArray(current.variants?.nodes) ||
        typeof current.variants?.pageInfo?.hasNextPage !== "boolean") invalid("Incomplete product response");
    const { variants, ...scalars } = current;
    if (product && JSON.stringify(scalars) !== JSON.stringify(product.scalars)) invalid("Product changed during paginated read");
    product ??= { scalars, variants: [] };
    product.variants.push(...variants.nodes);
    if (product.variants.length > 2048) invalid("Variant count limit exceeded");
    after = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : undefined;
    if (after !== undefined) {
      if (typeof after !== "string" || !after || cursors.has(after) || !variants.nodes.length) invalid("Variant pagination did not advance");
      cursors.add(after);
    }
  } while (after !== undefined);
  const result = { ...product.scalars, variants: product.variants };
  validateProducts([result]);
  return { complete: true, product: result };
}

export async function openBulkExport(op, { fetchImpl = fetch, signal } = {}) {
  if (op.status !== "COMPLETED" || !/^(0|[1-9][0-9]*)$/.test(String(op.objectCount)) ||
      (typeof op.objectCount === "number" && !Number.isSafeInteger(op.objectCount))) invalid("Completed export required");
  if (String(op.objectCount) === "0" && op.url == null) return [];
  const url = new URL(op.url);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !(url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".shopify.com") ||
        url.hostname.endsWith(".shopifycloud.com") || url.hostname.endsWith(".s3.amazonaws.com"))) {
    invalid("Untrusted bulk export URL");
  }
  const response = await fetchImpl(url.href, { redirect: "error", signal });
  if (!response.ok || !response.body) invalid("Bulk export download failed");
  return response.body;
}
