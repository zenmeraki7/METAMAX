import { graphql as requestGraphql } from "../../integrations/shopify/graphql.js";

import { mapCurrentProduct } from "./products.mapper.js";
import { replaceVariantProjection } from "./products.projection.js";

import {
  GET_PRODUCT,
  GET_PRODUCT_VARIANTS,
  GET_PRODUCT_VERSION,
  PRODUCT_VARIANT_PAGE_SIZE,
} from "./products.queries.js";

const PRODUCT_ID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;

const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;

const SHOP = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

const PAGE_SIZE = PRODUCT_VARIANT_PAGE_SIZE;
const MAX_VARIANTS = 2048;
const MAX_PAGES = Math.ceil(MAX_VARIANTS / PAGE_SIZE);

function failure(code, message) {
  const error = new Error(message);

  error.code = code;
  error.retryable = true;

  return error;
}

function requireIdentity(shop, productId) {
  if (typeof shop !== "string" || !SHOP.test(shop)) {
    throw new TypeError("Invalid canonical shop domain");
  }

  if (typeof productId !== "string" || !PRODUCT_ID.test(productId)) {
    throw new TypeError("Invalid product GID");
  }
}

/**
 * Support either a normalized data object or
 * a standard GraphQL { data, errors } envelope.
 *
 * Do not interpret a missing product field
 * as proof that the product was deleted.
 */
function readProduct(response, operation) {
  if (!response || typeof response !== "object") {
    throw failure(
      "INVALID_SHOPIFY_RESPONSE",
      `${operation}: missing GraphQL response`
    );
  }

  if (
    response.errors != null &&
    (!Array.isArray(response.errors) || response.errors.length > 0)
  ) {
    throw failure(
      "SHOPIFY_GRAPHQL_ERRORS",
      `${operation}: GraphQL errors returned`
    );
  }

  const data = Object.hasOwn(response, "data") ? response.data : response;

  if (!data || typeof data !== "object" || !Object.hasOwn(data, "product")) {
    throw failure(
      "INVALID_SHOPIFY_RESPONSE",
      `${operation}: missing product field`
    );
  }

  if (
    data.product !== null &&
    (typeof data.product !== "object" || Array.isArray(data.product))
  ) {
    throw failure(
      "INVALID_SHOPIFY_RESPONSE",
      `${operation}: malformed product`
    );
  }

  return data.product;
}

function requireProductVersion(product, productId) {
  if (
    product.id !== productId ||
    typeof product.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(product.updatedAt))
  ) {
    throw failure(
      "INCONSISTENT_PRODUCT_READ",
      "Shopify returned an invalid product identity or version"
    );
  }
}

/**
 * A Count can report EXACT or AT_LEAST.
 *
 * A complete variant replacement requires
 * an exact expected count.
 */
function readExactVariantCount(product) {
  const count = product.variantsCount;

  if (
    !count ||
    count.precision !== "EXACT" ||
    !Number.isSafeInteger(count.count) ||
    count.count < 0 ||
    count.count > MAX_VARIANTS
  ) {
    throw failure(
      "INVALID_VARIANT_COUNT",
      "Unable to verify the full product variant count"
    );
  }

  return count.count;
}

function readConnection(product) {
  const connection = product.variants;

  if (
    !connection ||
    !Array.isArray(connection.edges) ||
    !connection.pageInfo ||
    typeof connection.pageInfo.hasNextPage !== "boolean" ||
    connection.edges.length > PAGE_SIZE
  ) {
    throw failure(
      "INVALID_VARIANT_PAGE",
      "Shopify returned an invalid variant connection"
    );
  }

  return connection;
}

/**
 * Fetch an authoritative product representation
 * for the fields covered by our mirror.
 *
 * Returns:
 *
 *   null
 *
 * or:
 *
 *   {
 *     product,
 *     variants: [...]
 *   }
 *
 * Inconsistent reads throw so BullMQ/Neon
 * recovery can retry the reconciliation.
 */
export function createProductsService({ graphql = requestGraphql } = {}) {
  async function fetchCurrentProduct(shop, productId, context = {}) {
    requireIdentity(shop, productId);
    context = {
      ...context,
      installation: { generation: context.generation },
      signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(180000),
    };

    let firstProduct = null;
    let expectedCount = null;
    let after = null;

    const seenIds = new Set();
    const seenPositions = new Set();
    const seenCursors = new Set();
    const variants = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await graphql(
        shop,
        page === 0 ? GET_PRODUCT : GET_PRODUCT_VARIANTS,
        {
          id: productId,
          after,
        },
        { ...context, requestedCost: 400 }
      );

      const current = readProduct(response, "product pagination");

      if (current === null) {
        if (page > 0) {
          throw failure(
            "INCONSISTENT_PRODUCT_READ",
            "Product disappeared during pagination"
          );
        }

        // Confirm absence before treating the
        // product as deleted.
        const confirmed = readProduct(
          await graphql(
            shop,
            GET_PRODUCT_VERSION,
            { id: productId },
            { ...context, requestedCost: 10 }
          ),
          "product absence confirmation"
        );

        if (confirmed !== null) {
          throw failure(
            "INCONSISTENT_PRODUCT_READ",
            "Product appeared while confirming deletion"
          );
        }

        return null;
      }

      requireProductVersion(current, productId);

      if (page === 0) {
        firstProduct = current;
        expectedCount = readExactVariantCount(current);
      } else if (firstProduct.updatedAt !== current.updatedAt) {
        throw failure(
          "INCONSISTENT_PRODUCT_READ",
          "Product changed during variant pagination"
        );
      }

      const connection = readConnection(current);

      const edges = connection.edges;

      for (const edge of edges) {
        const node = edge?.node;

        if (
          !node ||
          typeof node.id !== "string" ||
          !VARIANT_ID.test(node.id) ||
          !Number.isInteger(node.position) ||
          node.position < 1 ||
          seenIds.has(node.id) ||
          seenPositions.has(node.position)
        ) {
          throw failure(
            "INVALID_VARIANT_PAGE",
            "Invalid or repeated variant in Shopify response"
          );
        }

        seenIds.add(node.id);
        seenPositions.add(node.position);

        variants.push({
          ...node,
          __parentId: productId,
        });
      }

      if (variants.length > MAX_VARIANTS || variants.length > expectedCount) {
        throw failure(
          "INVALID_VARIANT_COUNT",
          "Variant count exceeds the expected count"
        );
      }

      if (!connection.pageInfo.hasNextPage) {
        if (variants.length !== expectedCount) {
          throw failure(
            "INCOMPLETE_VARIANT_PAGE",
            "Variant pagination did not return every variant"
          );
        }

        // Validate the product after all pages
        // have been fetched.
        const last = readProduct(
          await graphql(
            shop,
            GET_PRODUCT_VERSION,
            { id: productId },
            { ...context, requestedCost: 10 }
          ),
          "final version verification"
        );

        if (last === null) {
          throw failure(
            "INCONSISTENT_PRODUCT_READ",
            "Product disappeared before final verification"
          );
        }

        requireProductVersion(last, productId);

        if (
          last.updatedAt !== firstProduct.updatedAt ||
          readExactVariantCount(last) !== expectedCount
        ) {
          throw failure(
            "INCONSISTENT_PRODUCT_READ",
            "Product changed while collecting variants"
          );
        }

        // Pagination uses ID order, but preserve
        // Shopify's original variant positions
        // in the product mirror.
        variants.sort(
          (a, b) => a.position - b.position || a.id.localeCompare(b.id)
        );

        return {
          product: firstProduct,
          variants,
        };
      }

      const cursor = connection.pageInfo.endCursor;

      if (
        edges.length === 0 ||
        typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor === after ||
        seenCursors.has(cursor) ||
        variants.length === expectedCount
      ) {
        throw failure(
          "INVALID_VARIANT_CURSOR",
          "Shopify variant cursor did not advance"
        );
      }

      seenCursors.add(cursor);

      after = cursor;
    }

    throw failure(
      "VARIANT_PAGE_LIMIT",
      "Variant pagination exceeded the supported page limit"
    );
  }
  return { fetchCurrentProduct };
}

export const { fetchCurrentProduct } = createProductsService();

// Published reads follow the pointer in one database statement. ProductMirror
// remains a compatibility cache; it is not copied or consulted at publication.
export async function readPublishedProduct(shop, productId, { db } = {}) {
  requireIdentity(shop, productId);
  db ??= (await import("../../db/client.js")).prisma;
  const rows =
    await db.$queryRaw`SELECT s."domain" AS shop, p."productId", p."data",
    p."runId" AS "snapshotId", COALESCE(c."appliedRevision",0) AS revision
    FROM "Shop" s JOIN "SnapshotRun" r ON r."id"=s."activeSnapshotId" AND r."shop"=s."domain"
      AND r."generation"=s."generation" AND r."status"='COMPLETED'
    JOIN "SnapshotProduct" p ON p."runId"=r."id"
    LEFT JOIN "CatalogChange" c ON c."shop"=s."domain" AND c."productId"=p."productId"
    WHERE s."domain"=${shop} AND s."status"='ACTIVE' AND p."productId"=${productId}`;
  return rows[0] || null;
}

export async function writeActiveSnapshotProduct(
  tx,
  shop,
  snapshotId,
  productId,
  data,
  generation
) {
  requireIdentity(shop, productId);
  const run = await tx.snapshotRun.findUnique({
    where: { id: snapshotId },
    select: { shop: true, status: true, generation: true },
  });
  if (
    run?.shop !== shop ||
    run.status !== "COMPLETED" ||
    run.generation !== generation
  )
    throw TypeError(
      "Active snapshot does not belong to the current installation"
    );
  if (data === null) {
    await tx.snapshotProduct.deleteMany({
      where: { runId: snapshotId, productId },
    });
    return;
  }
  if (typeof data !== "object" || data.id !== productId)
    throw TypeError("Invalid product identity");
  await tx.snapshotProduct.upsert({
    where: { runId_productId: { runId: snapshotId, productId } },
    create: { runId: snapshotId, productId, data },
    update: { data },
  });
  await replaceVariantProjection(tx, shop, snapshotId, productId, data);
}

// Staged snapshot replacement. The caller owns the Shop -> SnapshotRun ->
// SnapshotChange locks and acknowledges the exact revision in this transaction.
export async function writeProductSnapshot(
  tx,
  shop,
  snapshotId,
  productId,
  current
) {
  requireIdentity(shop, productId);
  const run = await tx.snapshotRun.findUnique({
    where: { id: snapshotId },
    select: { shop: true },
  });
  if (run?.shop !== shop)
    throw TypeError("Snapshot does not belong to this shop");
  if (current === null) {
    await tx.snapshotProduct.deleteMany({
      where: { runId: snapshotId, productId },
    });
    return;
  }
  const data = mapCurrentProduct(productId, current);
  await tx.snapshotProduct.upsert({
    where: { runId_productId: { runId: snapshotId, productId } },
    create: { runId: snapshotId, productId, data },
    update: { data },
  });
  await replaceVariantProjection(tx, shop, snapshotId, productId, data);
}

// The actual repository has ProductMirror JSON, not relational Product/Variant
// snapshot tables. Keep the entire verified variant set in one atomic row write.
// Call only from the revision-fenced completion transaction.
export async function writeCurrentProduct(
  tx,
  shop,
  productId,
  revision,
  current,
  context = {}
) {
  requireIdentity(shop, productId);
  if (current === null) {
    if (context.snapshotId)
      await writeActiveSnapshotProduct(
        tx,
        shop,
        context.snapshotId,
        productId,
        null,
        context.generation
      );
    await tx.productMirror.deleteMany({ where: { shop, productId } });
    return;
  }
  const data = mapCurrentProduct(productId, current);
  if (context.snapshotId)
    await writeActiveSnapshotProduct(
      tx,
      shop,
      context.snapshotId,
      productId,
      data,
      context.generation
    );
  await tx.productMirror.upsert({
    where: { shop_productId: { shop, productId } },
    create: { shop, productId, revision, data },
    update: { revision, data },
  });
}
