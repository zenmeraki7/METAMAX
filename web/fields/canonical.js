import { FIELD_TYPES as T, deepFreeze, FieldError, isSortableType } from "./types.js";
export const SOURCE_ENTITIES = deepFreeze({
  product: { object: "Product", model: "SnapshotProduct", dataset: "products", readScope: "read_products" },
  variant: { object: "ProductVariant", model: "SnapshotProduct", dataset: "products", readScope: "read_products" },
  inventoryItem: { object: "InventoryItem", model: "InventoryItem", dataset: "inventory_items", readScope: "read_inventory" },
  inventoryLevel: { object: "InventoryLevel", model: "InventoryLevel", dataset: "inventory_levels", readScope: "read_inventory" },
  location: { object: "Location", model: "InventoryLocation", dataset: "inventory_locations", readScope: "read_locations" },
});

// Descriptors contain fixed paths, never executable SQL or user-supplied paths.
export function defineSources(entity, property, options = {}) {
  const base = typeof entity === "string" && Object.hasOwn(SOURCE_ENTITIES, entity) ? SOURCE_ENTITIES[entity] : null;
  if (!base) throw new TypeError("Unknown source entity");
  const path = Array.isArray(property) ? [...property] : [property];
  const mirrorPath = options.mirrorPath ?? (entity === "product" ? ["data", ...path] : path);
  return deepFreeze({
    mirror: {
      model: options.model ?? base.model,
      dataset: options.dataset ?? base.dataset,
      path: mirrorPath,
      ...(entity === "variant" ? { collectionPath: ["data", "variants"] } : {}),
      ...(options.quantityName ? { quantityName: options.quantityName } : {}),
      ...(options.exactCount ? { precisionPath: ["data", "variantsCount", "precision"] } : {}),
    },
    shopify: { object: base.object, path: options.shopifyPath ?? path,
      ...(options.quantityName ? { quantityName: options.quantityName } : {}),
      ...(options.exactCount ? { precisionPath: ["variantsCount", "precision"] } : {}),
    },
  });
}
export const FIELD_CONTRACT_VERSION = "metamax-fields-v4";
export const SHOPIFY_FIELD_API_VERSION = "2026-10";
const definitions = [];

function field(entity, key, type, options = {}) {
  const { property = key, source = {}, operations = [], writeScope = null,
    mutation = null, ...rules } = options;
  definitions.push(deepFreeze({
    id: `${entity}.${key}`, entity, key, label: key, type,
    nullable: false, filterable: ![T.HTML, T.URL].includes(type),
    sortable: isSortableType(type),
    editable: operations.length > 0, importable: false, exportable: true, undoable: false,
    aliases: [], ...(type === T.INTEGER ? { min: -2147483648, max: 2147483647 } : {}), ...rules,
    operations: [...operations],
    readScopes: [SOURCE_ENTITIES[entity].readScope],
    writeScopes: writeScope ? [writeScope] : [],
    sources: defineSources(entity, property, source),
    mutation,
  }));
}

const productEdit = (key, operations = ["set"]) => ({
  operations, writeScope: "write_products", mutation: { family: "productUpdate", inputPath: [key] },
  importable: true, undoable: !["handle", "status"].includes(key),
});
const itemEdit = (key, operations = ["set"]) => ({
  operations, writeScope: "write_inventory", mutation: { family: "inventoryItemUpdate", inputPath: [key] },
  importable: true, undoable: true,
});
const variantEdit = key => ({
  operations: ["set"], importable: true, undoable: true,
  writeScope: "write_products", mutation: { family: "productVariantsBulkUpdate", inputPath: [key] },
});

field("product", "id", T.GID, { gidType: "Product" });
field("product", "title", T.TEXT, { ...productEdit("title"), trim: true, minLength: 1 });
field("product", "handle", T.TEXT, { ...productEdit("handle"), trim: true, lowercase: true, format: "handle", minLength: 1 });
field("product", "descriptionHtml", T.HTML, { ...productEdit("descriptionHtml"), aliases: ["product.description_html"] });
field("product", "status", T.ENUM, { ...productEdit("status"), enumCase: "upper", values: ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"] });
for (const key of ["vendor", "productType"])
  field("product", key, T.TEXT, { ...productEdit(key), trim: true,
    ...(key === "productType" ? { aliases: ["product.product_type"] } : {}) });
field("product", "tags", T.STRING_LIST, { ...productEdit("tags", ["set", "add_tags", "remove_tags"]),
  maxItems: 250, uniqueItems: true, nonEmptyItems: true, trimItems: true, unicodeNormalization: "NFC" });
field("product", "totalInventory", T.INTEGER, { aliases: ["product.total_inventory"] });
field("product", "tracksInventory", T.BOOLEAN);
for (const key of ["createdAt", "updatedAt"]) field("product", key, T.DATETIME);
field("product", "featuredImageUrl", T.URL, { nullable: true, property: ["featuredImage", "url"] });
field("product", "variantCount", T.INTEGER, { property: ["variantsCount", "count"], min: 0, source: { exactCount: true } });

field("variant", "id", T.GID, { gidType: "ProductVariant" });
field("variant", "title", T.TEXT);
field("variant", "position", T.INTEGER, { min: 1 });
// SKU is edited through the authoritative inventory item, not a stale variant projection.
field("variant", "sku", T.TEXT, { nullable: true, readOnlyReason: "Edit inventoryItem.sku using its inventory item target" });
field("variant", "barcode", T.TEXT, { nullable: true, readOnlyReason: "Legacy scalar barcode; multi-barcode writes require a dedicated adapter" });
field("variant", "price", T.DECIMAL, { ...variantEdit("price"), min: "0" });
field("variant", "compareAtPrice", T.DECIMAL, { ...variantEdit("compareAtPrice"), min: "0", nullable: true, aliases: ["variant.compare_at_price"] });
field("variant", "inventoryQuantity", T.INTEGER);
for (const key of ["createdAt", "updatedAt"]) field("variant", key, T.DATETIME);
field("variant", "inventoryItemId", T.GID, { nullable: true, gidType: "InventoryItem", source: { shopifyPath: ["inventoryItem", "id"] } });

field("inventoryItem", "id", T.GID, { gidType: "InventoryItem" });
field("inventoryItem", "sku", T.TEXT, { ...itemEdit("sku"), nullable: true });
for (const key of ["tracked", "requiresShipping"]) field("inventoryItem", key, T.BOOLEAN, itemEdit(key));
field("inventoryItem", "updatedAt", T.DATETIME, { source: { mirrorPath: ["sourceUpdatedAt"] } });

field("location", "id", T.GID, { gidType: "Location" });
field("location", "name", T.TEXT);
for (const key of ["isActive", "fulfillsOnlineOrders"]) field("location", key, T.BOOLEAN);
field("location", "updatedAt", T.DATETIME, { source: { mirrorPath: ["sourceUpdatedAt"] } });

field("inventoryLevel", "inventoryItemId", T.GID, { gidType: "InventoryItem", source: { shopifyPath: ["item", "id"] } });
field("inventoryLevel", "locationId", T.GID, { gidType: "Location", source: { shopifyPath: ["location", "id"] } });
field("inventoryLevel", "isActive", T.BOOLEAN);
field("inventoryLevel", "updatedAt", T.DATETIME, { source: { mirrorPath: ["sourceUpdatedAt"] } });
export const INVENTORY_FIELD_QUANTITIES = deepFreeze([
  "available", "on_hand", "committed", "reserved", "incoming", "damaged", "safety_stock", "quality_control",
]);
for (const name of INVENTORY_FIELD_QUANTITIES) field("inventoryLevel", name, T.INTEGER, {
  property: "quantity", source: { quantityName: name, model: "InventoryQuantity", dataset: "inventory_quantities" },
  readOnlyReason: "Quantity writes require location targets, inventory policy and compare-and-set checks in execution",
});

const byId = new Map();
for (const definition of definitions) {
  if (definition.operations.length && (!definition.mutation || !definition.writeScopes.length))
    throw new Error("Editable fields require an explicit mutation and scope contract");
  for (const id of [definition.id, ...definition.aliases]) {
    if (byId.has(id)) throw new Error("Duplicate canonical field or alias");
    byId.set(id, definition);
  }
}
export const CANONICAL_FIELDS = deepFreeze([...definitions]);

export function getFieldDefinition(id) {
  if (typeof id !== "string" || id.length > 128 || !byId.has(id))
    throw new FieldError("UNKNOWN_FIELD", "Unknown canonical field");
  return byId.get(id);
}

// Non-throwing lookup for optional resolution and source discovery. Execution
// validation continues to use the strict getFieldDefinition API.
export function getCanonicalField(id) {
  return typeof id === "string" && id.length <= 128 ? byId.get(id) ?? null : null;
}

export function listFields({ entity } = {}) {
  if (entity !== undefined && (typeof entity !== "string" || !Object.hasOwn(SOURCE_ENTITIES, entity)))
    throw new FieldError("UNKNOWN_FIELD_ENTITY", "Unknown field entity");
  return Object.freeze(CANONICAL_FIELDS.filter(field => entity === undefined || field.entity === entity));
}

export const requireCanonicalField = getFieldDefinition;
