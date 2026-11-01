/** Fixed catalog projection. Input: trusted shop/generation/product IDs and the
 * authorized executor transaction. Output: rows plus fresh persisted counts.
 * Requires publication protection held until completion; no durable side effects
 * or process-local count reuse across commits, rollbacks or installations. */
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

// Compatibility hook for older callers. Summaries are no longer cached across
// transactions: incremental/recovery writes can change a published generation.
export function clearCatalogSummaryCache() {}

export async function readCatalogPage(
  client,
  { shopId, generationId, productIds },
) {
  const products = (
    await client.query(
      `SELECT p.shopify_id AS id, p.title, p.handle, p.vendor,
    p.product_type AS "productType", p.status, p.tags,
    (SELECT count(*)::text FROM mirror.variants v WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.deleted_at IS NULL) AS "variantCount",
    (SELECT COALESCE(sum(v.inventory_quantity),0)::text FROM mirror.variants v WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.deleted_at IS NULL) AS "totalInventory",
    COALESCE(p.attributes->'featuredImage'->>'url', p.attributes->'image'->>'url', p.attributes->>'image', NULL) AS "image",
    COALESCE(
      (p.attributes->>'tracksInventory')::boolean,
      (
        SELECT bool_or(COALESCE(ii.tracked, (v.attributes->'inventoryItem'->>'tracked')::boolean))
        FROM mirror.variants v
        LEFT JOIN mirror.inventory_items ii
          ON ii.shop_id=v.shop_id AND ii.generation_id=v.generation_id AND ii.id=v.inventory_item_id
        WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.deleted_at IS NULL
      ),
      true
    ) AS "tracksInventory"
    FROM mirror.products p WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.id=ANY($3::bigint[]) AND p.deleted_at IS NULL
    ORDER BY p.id`,
      [shopId, generationId, productIds],
    )
  ).rows.map((row) => ({
    ...row,
    variantCount: catalogCount(row.variantCount),
    image:
      typeof row.image === "string" && row.image.trim()
        ? row.image.trim()
        : null,
    tracksInventory:
      typeof row.tracksInventory === "boolean"
        ? row.tracksInventory
        : row.tracksInventory === "false"
          ? false
          : Boolean(row.tracksInventory ?? true),
  }));
  if (products.length !== productIds.length)
    throw new FieldError(
      C.CONTRACT_MISMATCH,
      "Catalog projection lost selected rows",
    );
  const row = (
    await client.query(
      `SELECT
      (SELECT count(*)::text FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL) AS "productCount",
      (SELECT count(*)::text FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL AND status='ACTIVE') AS "activeCount",
      (SELECT count(*)::text FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL) AS "variantCount"`,
      [shopId, generationId],
    )
  ).rows[0];
  const summary = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, catalogCount(value)]),
  );
  return {
    products,
    summary,
  };
}
