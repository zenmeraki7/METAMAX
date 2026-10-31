/** Fixed catalog projection. Called only inside the authorized executor transaction. */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";

export function catalogCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new FieldError(
      C.CONTRACT_MISMATCH,
      "Catalog count exceeds response contract",
    );
  return count;
}

const summaryCache = new Map();
const MAX_SUMMARY_CACHE_ENTRIES = 500;

export function clearCatalogSummaryCache(shopId = null) {
  if (shopId) {
    for (const key of summaryCache.keys()) {
      if (key.startsWith(`${shopId}:`)) summaryCache.delete(key);
    }
  } else {
    summaryCache.clear();
  }
}

export async function readCatalogPage(
  client,
  { shopId, generationId, productIds },
) {
  const products = (
    await client.query(
      `SELECT p.shopify_id AS id, p.title, p.handle, p.vendor,
    p.product_type AS "productType", p.status, p.tags,
    (SELECT count(*)::text FROM mirror.variants v WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.deleted_at IS NULL) AS "variantCount",
    (SELECT COALESCE(sum(v.inventory_quantity),0)::text FROM mirror.variants v WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.deleted_at IS NULL) AS "totalInventory"
    FROM mirror.products p WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.id=ANY($3::bigint[]) AND p.deleted_at IS NULL
    ORDER BY p.id`,
      [shopId, generationId, productIds],
    )
  ).rows.map((row) => ({
    ...row,
    variantCount: catalogCount(row.variantCount),
    image: null,
  }));
  if (products.length !== productIds.length)
    throw new FieldError(
      C.CONTRACT_MISMATCH,
      "Catalog projection lost selected rows",
    );
  const cacheKey = `${shopId}:${generationId}`;
  let summary = summaryCache.get(cacheKey);
  if (!summary) {
    const row = (
      await client.query(
        `SELECT
      (SELECT count(*)::text FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL) AS "productCount",
      (SELECT count(*)::text FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL AND status='ACTIVE') AS "activeCount",
      (SELECT count(*)::text FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL) AS "variantCount"`,
        [shopId, generationId],
      )
    ).rows[0];
    summary = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, catalogCount(value)]),
    );
    if (summaryCache.size >= MAX_SUMMARY_CACHE_ENTRIES) {
      const oldestKey = summaryCache.keys().next().value;
      if (oldestKey) summaryCache.delete(oldestKey);
    }
    summaryCache.set(cacheKey, summary);
  }
  return {
    products,
    summary,
  };
}
