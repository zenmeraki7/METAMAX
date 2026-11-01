import { validateProducts } from "./catalog-validation.js";
import { shop, token, transaction } from "./transactions.server.js";
import {writeCatalogBatch} from './catalog-batch-writer.server.js';
export { validateProducts } from "./catalog-validation.js";

/** Shared authoritative writer. Caller holds the generation lock and transaction. */
export async function writeCatalogProducts({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateProducts(records);
  if(records.length>1 || records[0].variants.length>8)return writeCatalogBatch({client,shopId,generationId,records});
  // 1. Insert products
  for (const record of records) {
    const pGid = record.id || record.shopifyId;
    const nowIso = new Date().toISOString();
    const createdAt = record.createdAt || nowIso;
    const updatedAt = record.updatedAt || nowIso;
    const publishedAt = record.publishedAt || null;
    const deletedAt = record.deletedAt || null;
    const sourceRev = BigInt(record.sourceRevision || 0);

    const prodRes = await client.query(
      `INSERT INTO mirror.products (
             shop_id, generation_id, shopify_id, title, handle, description_html,
             vendor, product_type, status, tags, template_suffix, seo_title,
             seo_description, category_id, created_at, updated_at, published_at,
             deleted_at, source_revision, attributes
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17,
             $18, $19, $20
           )
           ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
             title = EXCLUDED.title,
             handle = EXCLUDED.handle,
             description_html = EXCLUDED.description_html,
             vendor = EXCLUDED.vendor,
             product_type = EXCLUDED.product_type,
             status = EXCLUDED.status,
             tags = EXCLUDED.tags,
             template_suffix = EXCLUDED.template_suffix,
             seo_title = EXCLUDED.seo_title,
             seo_description = EXCLUDED.seo_description,
             category_id = EXCLUDED.category_id,
             updated_at = EXCLUDED.updated_at,
             published_at = EXCLUDED.published_at,
             deleted_at = EXCLUDED.deleted_at,
             source_revision = EXCLUDED.source_revision,
             attributes = EXCLUDED.attributes
           RETURNING id`,
      [
        shopId,
        generationId,
        pGid,
        record.title ?? "Untitled",
        record.handle ?? "",
        record.descriptionHtml ?? null,
        record.vendor ?? null,
        record.productType ?? null,
        record.status ?? "ACTIVE",
        record.tags,
        record.templateSuffix ?? null,
        record.seoTitle ?? record.seo?.title ?? null,
        record.seoDescription ?? record.seo?.description ?? null,
        record.categoryId ?? record.category?.id ?? null,
        createdAt,
        updatedAt,
        publishedAt,
        deletedAt,
        sourceRev.toString(),
        record.attributes ? JSON.stringify(record.attributes) : null,
      ],
    );

    const internalProductId = prodRes.rows[0].id;
    const variants = record.variants;
    if (
      (
        await client.query(
          `SELECT 1 FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2
          AND shopify_id=ANY($3::text[]) AND product_id<>$4 LIMIT 1`,
          [shopId, generationId, variants.map((v) => v.id), internalProductId],
        )
      ).rowCount
    ) {
      throw new Error("Variant identity belongs to another product");
    }
    await client.query(
      `DELETE FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND product_id=$3
          AND NOT (shopify_id=ANY($4::text[]))`,
      [shopId, generationId, internalProductId, variants.map((v) => v.id)],
    );

    // 2. Insert variants for this product
    let pos = 1n;
    for (const variant of variants) {
      const vGid = variant.id || variant.shopifyId;
      const vCreatedAt = variant.createdAt || createdAt;
      const vUpdatedAt = variant.updatedAt || updatedAt;
      const vDeletedAt = variant.deletedAt || null;
      const vRev = BigInt(variant.sourceRevision || sourceRev);
      const price =
        variant.price !== undefined ? String(variant.price) : "0.00";
      const compareAt =
        variant.compareAtPrice !== undefined && variant.compareAtPrice !== null
          ? String(variant.compareAtPrice)
          : null;
      const invQuantity = BigInt(variant.inventoryQuantity ?? 0);
      const taxable = Boolean(variant.taxable ?? true);
      const requiresComponents = Boolean(variant.requiresComponents ?? false);
      const position = BigInt(variant.position ?? pos++);

      await client.query(
        `INSERT INTO mirror.variants (
               shop_id, generation_id, shopify_id, product_id, title, sku, barcode,
               price, compare_at_price, inventory_policy, inventory_quantity, taxable,
               requires_components, position, created_at, updated_at, deleted_at,
               source_revision, attributes
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17,
               $18, $19
             )
             ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
               product_id = EXCLUDED.product_id,
               title = EXCLUDED.title,
               sku = EXCLUDED.sku,
               barcode = EXCLUDED.barcode,
               price = EXCLUDED.price,
               compare_at_price = EXCLUDED.compare_at_price,
               inventory_policy = EXCLUDED.inventory_policy,
               inventory_quantity = EXCLUDED.inventory_quantity,
               taxable = EXCLUDED.taxable,
               requires_components = EXCLUDED.requires_components,
               position = EXCLUDED.position,
               updated_at = EXCLUDED.updated_at,
               deleted_at = EXCLUDED.deleted_at,
               source_revision = EXCLUDED.source_revision,
               attributes = EXCLUDED.attributes`,
        [
          shopId,
          generationId,
          vGid,
          internalProductId,
          variant.title ?? "Default Title",
          variant.sku ?? null,
          variant.barcode ?? null,
          price,
          compareAt,
          variant.inventoryPolicy ?? "DENY",
          invQuantity.toString(),
          taxable,
          requiresComponents,
          position.toString(),
          vCreatedAt,
          vUpdatedAt,
          vDeletedAt,
          vRev.toString(),
          variant.attributes ? JSON.stringify(variant.attributes) : null,
        ],
      );
    }
  }
}

/**
 * Service factory for validating and writing trusted generation-scoped catalog rows.
 */
export function createCatalogWriter({ database } = {}) {
  return Object.freeze({
    validateProducts,
    async writeCatalogProducts({ client, shopId, generationId, records }) {
      if (client) {
        return writeCatalogProducts({ client, shopId, generationId, records });
      }
      if (!database) {
        throw new TypeError("Database client or connection pool required");
      }
      return transaction(database, (c) =>
        writeCatalogProducts({ client: c, shopId, generationId, records }), shopId);
    },
    async writeProducts({ client, shopId, generationId, records }) {
      return this.writeCatalogProducts({
        client,
        shopId,
        generationId,
        records,
      });
    },
  });
}
