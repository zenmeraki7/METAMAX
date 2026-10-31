import { deepFreeze } from "./types.js";
import { CANONICAL_FIELDS, requireCanonicalField } from "./canonical.js";

// Pure server-owned metadata for the reviewed prisma/ mirror contract. Dataset
// registration and source availability do not establish authorization/readiness.
export const SOURCE_DATASETS = deepFreeze({
  PRODUCTS: "products",
  VARIANTS: "variants",
  INVENTORY_ITEMS: "inventory_items",
  INVENTORY_LEVELS: "inventory_levels",
  LOCATIONS: "locations",
  COLLECTIONS: "collections",
  PRODUCT_OPTIONS: "product_options",
  CATEGORIES: "categories",
  METAFIELDS: "metafields",
});

export const FILTER_SQL_SCHEMA = deepFreeze({
  mirrorSchemaVersion: "metamax_mirror_v1",
  sourceContractVersion: "metamax_sources_v1",
  product: { alias: "p", idColumn: "id", shopColumn: "shop_id", generationColumn: "generation_id" },
  variant: { schema: "mirror", table: "variants", alias: "v", productIdColumn: "product_id",
    shopColumn: "shop_id", generationColumn: "generation_id" },
});

// Explicit IDs -> physical columns. Never derive SQL names by splitting a field
// ID, changing casing, or accepting caller definitions. Logical Shopify IDs use
// shopify_id text; the compiler's internal bigint identity remains products.id.
const COLUMNS = deepFreeze([
  ["product.id", "shopify_id", "text", "scalar"],
  ["product.title", "title", "text", "text"],
  ["product.handle", "handle", "text", "text"],
  ["product.descriptionHtml", "description_html", "text", "text"],
  ["product.vendor", "vendor", "text", "text"],
  ["product.productType", "product_type", "text", "text"],
  ["product.status", "status", "text", "scalar"],
  ["product.tags", "tags", "text[]", "list"],
  ["product.templateSuffix", "template_suffix", "text", "text"],
  ["product.createdAt", "created_at", "timestamptz", "ordered"],
  ["product.updatedAt", "updated_at", "timestamptz", "ordered"],
  ["product.publishedAt", "published_at", "timestamptz", "ordered"],
  ["product.seoTitle", "seo_title", "text", "text"],
  ["product.seoDescription", "seo_description", "text", "text"],
  ["product.categoryId", "category_id", "text", "scalar"],
  ["variant.id", "shopify_id", "text", "scalar"],
  ["variant.title", "title", "text", "text"],
  ["variant.sku", "sku", "text", "text"],
  ["variant.barcode", "barcode", "text", "text"],
  ["variant.price", "price", "numeric", "ordered"],
  ["variant.compareAtPrice", "compare_at_price", "numeric", "ordered"],
  ["variant.inventoryPolicy", "inventory_policy", "text", "scalar"],
  ["variant.inventoryQuantity", "inventory_quantity", "bigint", "ordered"],
  ["variant.taxable", "taxable", "boolean", "scalar"],
  ["variant.requiresComponents", "requires_components", "boolean", "scalar"],
  ["variant.position", "position", "bigint", "ordered"],
  ["variant.createdAt", "created_at", "timestamptz", "ordered"],
  ["variant.updatedAt", "updated_at", "timestamptz", "ordered"],
]);

const SCALAR_OPERATORS = ["eq", "neq", "in", "not_in", "is_null", "is_not_null"];
const OPERATORS = deepFreeze({
  scalar: SCALAR_OPERATORS,
  text: [...SCALAR_OPERATORS, "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  ordered: [...SCALAR_OPERATORS, "gt", "gte", "lt", "lte", "between"],
  list: ["list_contains", "list_not_contains", "is_empty", "is_not_empty", "is_null", "is_not_null"],
});
const DEPENDENCIES = deepFreeze({
  product: ["products"], variant: ["products", "variants"],
  inventoryItem: ["products", "variants", "inventory_items"],
  inventoryLevel: ["products", "variants", "inventory_items", "locations", "inventory_levels"],
  location: ["locations"], collection: ["products", "collections"],
  productOption: ["products", "product_options"], category: ["categories"],
});
const DISABLED = Object.freeze({
  "variant.productId": "Logical Shopify product ID needs a reviewed relation adapter; product_id is an internal bigint",
  "productOption.productId": "Logical Shopify product ID needs a reviewed relation adapter",
  "inventoryLevel.inventoryItemId": "Logical Shopify inventory item ID needs a reviewed relation adapter",
  "inventoryLevel.locationId": "Logical Shopify location ID needs a reviewed relation adapter",
});

const installed = Object.fromEntries(COLUMNS.map(([id, column, storageType, operators]) => {
  const field = requireCanonicalField(id);
  if (!["product", "variant"].includes(field.entity)) throw new TypeError("Unsupported installed SQL family");
  return [id, { column, storageType, operators }];
}));

// Cover the whole canonical registry without inventing sources for unsupported
// families or relation/list fields. These entries deliberately have no sql map.
export const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => {
  const mapping = Object.getOwnPropertyDescriptor(installed, field.id)?.value;
  const datasets = Object.getOwnPropertyDescriptor(DEPENDENCIES, field.entity)?.value;
  if (!datasets) throw new TypeError("Canonical source family requires an explicit dependency contract");
  const source = { fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, datasets, kind: mapping ? "column" : "unavailable" };
  if (mapping) {
    source.sql = { kind: "column", alias: field.entity === "product" ? "p" : "v", column: mapping.column,
      storageType: mapping.storageType, shopColumn: "shop_id", generationColumn: "generation_id" };
  } else source.unavailableReason = DISABLED[field.id] ?? "SQL handler for this field family is not installed";
  return [field.id, source];
})));

// Closed operator lists: extending the general operator catalog cannot silently
// enable new SQL behavior. No callbacks, functions, JSON paths or raw SQL escape.
export const FILTER_BINDING_DEFINITIONS = deepFreeze(COLUMNS.map(([fieldId, , , operators]) => {
  const field = requireCanonicalField(fieldId), variant = field.entity === "variant";
  return { fieldId, entity: field.entity, sourceKind: "column", datasets: DEPENDENCIES[field.entity],
    correlation: variant ? "variant_exists" : "product", handlerId: variant ? "variant_exists_v1" : "product_column_v1",
    operators: OPERATORS[operators], cost: variant ? 2 : 1,
    mirrorSchemaVersion: FILTER_SQL_SCHEMA.mirrorSchemaVersion, sourceContractVersion: FILTER_SQL_SCHEMA.sourceContractVersion };
}));
