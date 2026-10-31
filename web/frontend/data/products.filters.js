// UI metadata only. The backend registry remains the authority for execution.
export const DYNAMIC_FIELD_ID_PATTERN =
  /^(product|variant)\.metafield\.[a-z][a-zA-Z0-9]{7,95}$/;

export function isDynamicMetafieldId(value) {
  return typeof value === "string" && DYNAMIC_FIELD_ID_PATTERN.test(value);
}

/**
 * All 58 canonical fields defined in the METAMAX backend Canonical Field Registry (canonical.js).
 */
export const canonicalFilterFields = [
  // Products (15)
  ["product.title", "Title", "text"],
  ["product.vendor", "Vendor", "text"],
  ["product.status", "Status", "scalar"],
  ["product.productType", "Product type", "text"],
  ["product.handle", "Handle", "text"],
  ["product.id", "Product ID", "scalar"],
  ["product.descriptionHtml", "Description", "text"],
  ["product.templateSuffix", "Theme template", "text"],
  ["product.createdAt", "Date created", "date"],
  ["product.updatedAt", "Date updated", "date"],
  ["product.publishedAt", "Date published", "date"],
  ["product.seoTitle", "SEO meta title", "text"],
  ["product.seoDescription", "SEO meta description", "text"],
  ["product.categoryId", "Category ID", "scalar"],
  ["product.tags", "Tag", "list"],

  // Variants (14)
  ["variant.id", "Variant ID", "scalar"],
  ["variant.productId", "Variant product ID", "scalar"],
  ["variant.title", "Variant title", "text"],
  ["variant.sku", "SKU", "text"],
  ["variant.barcode", "Barcode", "text"],
  ["variant.price", "Price", "number"],
  ["variant.compareAtPrice", "Compare-at price", "number"],
  ["variant.inventoryPolicy", "Inventory policy", "scalar"],
  ["variant.inventoryQuantity", "Variant inventory quantity", "integer"],
  ["variant.taxable", "Charge tax", "boolean"],
  ["variant.requiresComponents", "Requires components", "boolean"],
  ["variant.position", "Variant position", "integer"],
  ["variant.createdAt", "Variant date created", "date"],
  ["variant.updatedAt", "Variant date updated", "date"],

  // Inventory Items (7)
  ["inventoryItem.id", "Inventory item ID", "scalar"],
  ["inventoryItem.sku", "Inventory SKU", "text"],
  ["inventoryItem.tracked", "Inventory tracked", "boolean"],
  ["inventoryItem.requiresShipping", "Requires shipping", "boolean"],
  ["inventoryItem.unitCost", "Unit cost", "number"],
  ["inventoryItem.countryCodeOfOrigin", "Country of origin", "text"],
  ["inventoryItem.harmonizedSystemCode", "HS code", "text"],

  // Inventory Levels (7)
  ["inventoryLevel.id", "Inventory level ID", "scalar"],
  ["inventoryLevel.inventoryItemId", "Inventory level item ID", "scalar"],
  ["inventoryLevel.locationId", "Inventory level location ID", "scalar"],
  ["inventoryLevel.available", "Available inventory", "integer"],
  ["inventoryLevel.onHand", "On-hand inventory", "integer"],
  ["inventoryLevel.committed", "Committed inventory", "integer"],
  ["inventoryLevel.incoming", "Incoming inventory", "integer"],

  // Locations (3)
  ["location.id", "Location ID", "scalar"],
  ["location.name", "Location name", "text"],
  ["location.active", "Active location", "boolean"],

  // Collections (4)
  ["collection.id", "Collection ID", "scalar"],
  ["collection.title", "Collection title", "text"],
  ["collection.handle", "Collection handle", "text"],
  ["collection.updatedAt", "Collection date updated", "date"],

  // Product Options (5)
  ["productOption.id", "Product option ID", "scalar"],
  ["productOption.productId", "Product option product ID", "scalar"],
  ["productOption.name", "Option name", "text"],
  ["productOption.position", "Option position", "integer"],
  ["productOption.values", "Option values", "list"],

  // Taxonomy Categories (3)
  ["category.id", "Taxonomy category ID", "scalar"],
  ["category.name", "Category name", "text"],
  ["category.fullName", "Category path", "text"],
];

/**
 * Fields installed with verified physical SQL bindings for PostgreSQL catalog querying.
 */
export const installedFilterFields = canonicalFilterFields.filter(([id]) =>
  id.startsWith("product.") || (id.startsWith("variant.") && id !== "variant.productId")
);

export const productFilterFields = canonicalFilterFields;

export function getFieldLabel(fieldId) {
  const found = canonicalFilterFields.find(([id]) => id === fieldId);
  if (found) return found[1];
  if (typeof fieldId === "string") {
    if (fieldId.startsWith("product.metafield.")) {
      return `Product Metafield (${fieldId.replace("product.metafield.", "")})`;
    }
    if (fieldId.startsWith("variant.metafield.")) {
      return `Variant Metafield (${fieldId.replace("variant.metafield.", "")})`;
    }
  }
  return fieldId ?? "Field";
}

export function getFieldType(fieldId) {
  const found = canonicalFilterFields.find(([id]) => id === fieldId);
  if (found) return found[2];
  return "text";
}

const scalar = [
  ["eq", "is"],
  ["neq", "is not"],
  ["in", "is one of"],
  ["not_in", "is not one of"],
];
const presence = [
  ["is_null", "is missing"],
  ["is_not_null", "is present"],
];
const empty = [
  ["is_empty", "is empty"],
  ["is_not_empty", "is not empty"],
];
export const filterOperators = {
  text: [
    ["contains", "contains"],
    ...scalar,
    ["not_contains", "does not contain"],
    ["starts_with", "starts with"],
    ["ends_with", "ends with"],
    ...empty,
    ...presence,
  ],
  scalar: [...scalar, ...presence],
  boolean: [["eq", "is"], ["neq", "is not"], ["in", "is one of"], ["not_in", "is not one of"], ...presence],
  number: [
    ...scalar,
    ["gt", "is greater than"],
    ["gte", "is at least"],
    ["lt", "is less than"],
    ["lte", "is at most"],
    ["between", "is between"],
    ...presence,
  ],
  list: [
    ["list_contains", "contains tag"],
    ["list_not_contains", "does not contain tag"],
    ...empty,
    ...presence,
  ],
};
filterOperators.integer = filterOperators.number;
filterOperators.date = filterOperators.number;
filterOperators.string = filterOperators.text;
filterOperators.enum = filterOperators.scalar;
filterOperators.id = filterOperators.scalar;
filterOperators.decimal = filterOperators.number;
filterOperators.money = filterOperators.number;
filterOperators.percentage = filterOperators.number;
filterOperators.datetime = filterOperators.date;
filterOperators.string_list = filterOperators.list;
filterOperators.id_list = filterOperators.list;
filterOperators.json = [...presence];

export const isPresenceOperator = (operator) =>
  ["is_null", "is_not_null", "is_empty", "is_not_empty"].includes(operator);
export function filterOperand(type, operator, value) {
  if (isPresenceOperator(operator)) return undefined;
  if (type === "list" || type === "string_list" || type === "id_list") return value; // Exact tag identity includes whitespace and commas.
  const normalize = (item) => {
    if (type === "boolean") return item.trim() === "true";
    if (type === "date" || type === "datetime") {
      const date = new Date(item);
      return Number.isNaN(date.getTime()) ? item : date.toISOString();
    }
    // Preserve exact decimal and bigint strings; the backend validates ranges.
    return item.trim();
  };
  return ["in", "not_in", "between"].includes(operator)
    ? value.split(",").map(normalize)
    : normalize(value);
}
