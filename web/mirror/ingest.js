/**
 * METAMAX — Catalog ingestion
 *
 * Caller requirements:
 * - Verified shop context
 * - Existing BUILDING generation
 * - A completed Shopify bulk query
 * - One owning ingestion worker per sync run
 *
 * Each batch runs in a transaction.
 */

export const PRODUCT_PREFIX = "gid://shopify/Product/";
export const VARIANT_PREFIX = "gid://shopify/ProductVariant/";

export function assertId(value, prefix) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix)
  ) {
    throw new Error(`Invalid Shopify resource ID`);
  }

  return value;
}

/**
 * Resolves option1 value by comparing selectedOptions against option definitions if available.
 * Selected options in Shopify bulk exports are not guaranteed to be ordered by option position.
 *
 * @param {object} node - Variant node
 * @param {Array<{ name: string, position: number }>} [optionDefinitions]
 * @returns {string|null}
 */
export function resolveOption1(node, optionDefinitions) {
  const selectedOptions = node?.selectedOptions;
  if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
    return null;
  }

  if (Array.isArray(optionDefinitions) && optionDefinitions.length > 0) {
    const firstOptionDef =
      optionDefinitions.find((def) => def.position === 1) ||
      optionDefinitions[0];
    if (firstOptionDef?.name) {
      const match = selectedOptions.find(
        (opt) => opt.name === firstOptionDef.name
      );
      if (match && match.value !== undefined) {
        return match.value;
      }
    }
  }

  return selectedOptions[0]?.value ?? null;
}

export function productRow(node) {
  return {
    id: assertId(node.id, PRODUCT_PREFIX),
    title: node.title,
    handle: node.handle,
    vendor: node.vendor ?? null,
    productType: node.productType ?? null,
    status: node.status,
    tags: node.tags ?? [],
    inventoryTotal: node.totalInventory ?? null,
    updatedAt: node.updatedAt ?? null,
  };
}

export function variantRow(node, optionDefinitions) {
  return {
    id: assertId(node.id, VARIANT_PREFIX),
    productId: assertId(node.__parentId, PRODUCT_PREFIX),
    sku: node.sku ?? null,
    barcode: node.barcode ?? null,
    price: node.price,
    compareAtPrice: node.compareAtPrice ?? null,
    option1: resolveOption1(node, optionDefinitions),
    inventoryItemId: node.inventoryItem?.id ?? null,
  };
}

async function transaction(db, fn) {
  if (typeof db?.connect === "function") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  } else if (typeof db?.query === "function") {
    await db.query("BEGIN");
    try {
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } else {
    throw new TypeError(
      "A PostgreSQL client or connection pool supporting query() is required"
    );
  }
}

/**
 * Ingests a bounded batch of catalog nodes into mirror tables inside a single transaction.
 * Products are written before variants so foreign key constraints remain valid.
 *
 * @param {object} db - pg Pool or Client instance
 * @param {object} params
 * @param {string} params.shopId - Unique shop identifier
 * @param {string} params.generationId - Active generation ID (must be BUILDING)
 * @param {Array<object>} params.nodes - Raw or parsed catalog records (<= 500)
 * @returns {Promise<{ products: number, variants: number }>}
 */
export async function ingestCatalogBatch(
  db,
  { shopId, generationId, nodes }
) {
  if (!shopId || !generationId) {
    throw new Error("Shop and generation are required");
  }

  if (!Array.isArray(nodes) || nodes.length > 500) {
    throw new Error("Invalid ingestion batch");
  }

  const products = [];
  const variants = [];
  const productOptionsMap = new Map();

  for (const node of nodes) {
    if (node.id?.startsWith(PRODUCT_PREFIX)) {
      if (Array.isArray(node.options)) {
        productOptionsMap.set(node.id, node.options);
      }
      products.push(productRow(node));
    } else if (node.id?.startsWith(VARIANT_PREFIX)) {
      const optionDefs = node.__parentId
        ? productOptionsMap.get(node.__parentId)
        : undefined;
      variants.push(variantRow(node, optionDefs));
    } else {
      throw new Error("Unexpected catalog record");
    }
  }

  return transaction(db, async (client) => {
    const guard = await client.query(
      `SELECT status
       FROM mirror_generations
       WHERE shop_id = $1 AND id = $2
       FOR SHARE`,
      [shopId, generationId]
    );

    if (guard.rows[0]?.status !== "BUILDING") {
      throw new Error("Generation is not writable");
    }

    if (products.length) {
      await client.query(
        `INSERT INTO mirror_products (
           shop_id, generation_id, product_id,
           title, handle, vendor, product_type,
           status, tags, inventory_total, updated_at
         )
         SELECT
           $1, $2, x.id, x.title, x.handle,
           x.vendor, x."productType", x.status,
           x.tags, x."inventoryTotal", x."updatedAt"
         FROM jsonb_to_recordset($3::jsonb) AS x(
           id text, title text, handle text,
           vendor text, "productType" text,
           status text, tags text[],
           "inventoryTotal" integer,
           "updatedAt" timestamptz
         )
         ON CONFLICT (
           shop_id, generation_id, product_id
         ) DO UPDATE SET
           title = EXCLUDED.title,
           handle = EXCLUDED.handle,
           vendor = EXCLUDED.vendor,
           product_type = EXCLUDED.product_type,
           status = EXCLUDED.status,
           tags = EXCLUDED.tags,
           inventory_total = EXCLUDED.inventory_total,
           updated_at = EXCLUDED.updated_at`,
        [shopId, generationId, JSON.stringify(products)]
      );
    }

    if (variants.length) {
      await client.query(
        `INSERT INTO mirror_variants (
           shop_id, generation_id, variant_id,
           product_id, sku, barcode, price,
           compare_at_price, option1, inventory_item_id
         )
         SELECT
           $1, $2, x.id, x."productId", x.sku,
           x.barcode, x.price::numeric,
           x."compareAtPrice"::numeric,
           x.option1, x."inventoryItemId"
         FROM jsonb_to_recordset($3::jsonb) AS x(
           id text, "productId" text, sku text,
           barcode text, price text,
           "compareAtPrice" text, option1 text,
           "inventoryItemId" text
         )
         ON CONFLICT (
           shop_id, generation_id, variant_id
         ) DO UPDATE SET
           product_id = EXCLUDED.product_id,
           sku = EXCLUDED.sku,
           barcode = EXCLUDED.barcode,
           price = EXCLUDED.price,
           compare_at_price = EXCLUDED.compare_at_price,
           option1 = EXCLUDED.option1,
           inventory_item_id = EXCLUDED.inventory_item_id`,
        [shopId, generationId, JSON.stringify(variants)]
      );
    }

    return {
      products: products.length,
      variants: variants.length,
    };
  });
}
