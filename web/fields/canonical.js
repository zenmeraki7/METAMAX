/**
 * METAMAX — Canonical Field Registry
 *
 * Pure metadata contract shared across all engines.
 *
 * - Stable field identities
 * - Strict definition validation
 * - Immutable registry
 * - No Shopify / SQL / HTTP coupling
 * - Measured metadata budgets
 * - No implicit write authorization
 */

import {
  FIELD_TYPES as T,
  FIELD_TYPE_CONTRACT_VERSION,
  FIELD_ERROR_CODES,
  FieldError,
  assertCanonicalFieldId,
  isCanonicalFieldId,
  isFieldType,
  isPlainObject,
  deepFreeze,
  measureFieldMetadata,
  FIELD_METADATA_BUDGETS,
} from "./types.js";

// --------------------------------------------------
// 1. Versions
// --------------------------------------------------

export const CANONICAL_FIELD_CONTRACT_VERSION = 1;
export const CANONICAL_FIELD_REGISTRY_VERSION = 1;
export const CANONICAL_FIELD_TYPE_VERSION =
  FIELD_TYPE_CONTRACT_VERSION;

// --------------------------------------------------
// 2. Entities
// --------------------------------------------------

export const FIELD_ENTITIES = deepFreeze({
  PRODUCT: "product",
  VARIANT: "variant",
  INVENTORY_ITEM: "inventoryItem",
  INVENTORY_LEVEL: "inventoryLevel",
  LOCATION: "location",
  COLLECTION: "collection",
  PRODUCT_OPTION: "productOption",
  CATEGORY: "category",
});

const ENTITY_SET = new Set(Object.values(FIELD_ENTITIES));

export function isFieldEntity(value) {
  return typeof value === "string" && ENTITY_SET.has(value);
}

// --------------------------------------------------
// 3. Definition contract
// --------------------------------------------------

const MAX_LABEL_LENGTH = 120;
const MAX_DECIMAL_PRECISION = 38;

const DECIMAL_TYPES = new Set([
  T.DECIMAL,
  T.MONEY,
  T.PERCENTAGE,
]);

const STRUCTURAL_KEYS = new Set([
  "id",
  "label",
  "entity",
  "type",
]);

const OPTION_KEYS = new Set([
  "nullable",
  "editable",
  "derived",
  "precision",
  "scale",
]);

const DEFINITION_KEYS = new Set([
  ...STRUCTURAL_KEYS,
  ...OPTION_KEYS,
]);

function invalidDefinition(message, fieldId = null) {
  throw new FieldError(
    FIELD_ERROR_CODES.INVALID_DEFINITION,
    message,
    { fieldId }
  );
}

function readOwnDataEntries(value, allowed, fieldId) {
  if (!isPlainObject(value)) {
    invalidDefinition(
      "Field metadata must be a plain object",
      fieldId
    );
  }

  const result = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      invalidDefinition(
        "Unknown canonical field metadata",
        fieldId
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      invalidDefinition(
        "Metadata accessors are prohibited",
        fieldId
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

function validateDefinition(definition) {
  const data = readOwnDataEntries(
    definition,
    DEFINITION_KEYS,
    null
  );

  const {
    id,
    label,
    entity,
    type,
    nullable,
    editable,
    derived,
    precision,
    scale,
  } = data;

  assertCanonicalFieldId(id);

  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH ||
    label.trim() !== label
  ) {
    invalidDefinition("Invalid field label", id);
  }

  if (!isFieldEntity(entity)) {
    invalidDefinition("Invalid field entity", id);
  }

  if (!isFieldType(type)) {
    invalidDefinition("Invalid field type", id);
  }

  for (const [name, flag] of [
    ["nullable", nullable],
    ["editable", editable],
    ["derived", derived],
  ]) {
    if (typeof flag !== "boolean") {
      invalidDefinition(
        `Invalid field flag: ${name}`,
        id
      );
    }
  }

  if (derived && editable) {
    invalidDefinition(
      "Derived fields cannot be directly editable",
      id
    );
  }

  if (!id.startsWith(`${entity}.`)) {
    invalidDefinition(
      "Field identifier does not match entity",
      id
    );
  }

  const decimal = DECIMAL_TYPES.has(type);
  const hasPrecision = Object.hasOwn(data, "precision");
  const hasScale = Object.hasOwn(data, "scale");

  if (decimal) {
    if (
      !hasPrecision ||
      !hasScale ||
      !Number.isSafeInteger(precision) ||
      !Number.isSafeInteger(scale) ||
      precision < 1 ||
      precision > MAX_DECIMAL_PRECISION ||
      scale < 0 ||
      scale > precision
    ) {
      invalidDefinition(
        "Invalid decimal field constraints",
        id
      );
    }
  } else if (hasPrecision || hasScale) {
    invalidDefinition(
      "Decimal constraints on non-decimal field",
      id
    );
  }

  return true;
}

/**
 * Structural identity and type are passed separately.
 * Only safe capability/precision options are accepted.
 */
function defineField(type, id, label, entity, options = {}) {
  const safe = readOwnDataEntries(
    options,
    OPTION_KEYS,
    isCanonicalFieldId(id) ? id : null
  );

  const definition = {
    id,
    label,
    entity,
    type,
    nullable: Object.hasOwn(safe, "nullable")
      ? safe.nullable
      : false,
    editable: Object.hasOwn(safe, "editable")
      ? safe.editable
      : false,
    derived: Object.hasOwn(safe, "derived")
      ? safe.derived
      : false,
  };

  if (DECIMAL_TYPES.has(type)) {
    definition.precision = safe.precision;
    definition.scale = safe.scale;
  } else if (
    Object.hasOwn(safe, "precision") ||
    Object.hasOwn(safe, "scale")
  ) {
    invalidDefinition(
      "Numeric constraints require decimal type",
      id
    );
  }

  validateDefinition(definition);
  return deepFreeze(definition);
}

// --------------------------------------------------
// 4. Private field factories
// --------------------------------------------------

const F = Object.freeze({
  string: (id, label, e, o) =>
    defineField(T.STRING, id, label, e, o),

  enum: (id, label, e, o) =>
    defineField(T.ENUM, id, label, e, o),

  bool: (id, label, e, o) =>
    defineField(T.BOOLEAN, id, label, e, o),

  integer: (id, label, e, o) =>
    defineField(T.INTEGER, id, label, e, o),

  decimal: (id, label, e, o) =>
    defineField(T.DECIMAL, id, label, e, o),

  money: (id, label, e, o) =>
    defineField(T.MONEY, id, label, e, o),

  date: (id, label, e, o) =>
    defineField(T.DATE, id, label, e, o),

  datetime: (id, label, e, o) =>
    defineField(T.DATETIME, id, label, e, o),

  id: (id, label, e, o) =>
    defineField(T.ID, id, label, e, o),

  stringList: (id, label, e, o) =>
    defineField(T.STRING_LIST, id, label, e, o),

  idList: (id, label, e, o) =>
    defineField(T.ID_LIST, id, label, e, o),
});

// --------------------------------------------------
// 5. Canonical definitions
// --------------------------------------------------

const E = FIELD_ENTITIES;
const EDIT = Object.freeze({ editable: true });
const NULL = Object.freeze({ nullable: true });
const NULL_EDIT = Object.freeze({
  nullable: true,
  editable: true,
});
const DERIVED = Object.freeze({ derived: true });
const MONEY = Object.freeze({
  editable: true,
  precision: 20,
  scale: 4,
});
const NULL_MONEY = Object.freeze({
  nullable: true,
  editable: true,
  precision: 20,
  scale: 4,
});

const DEFINITIONS = [

  // PRODUCTS

  F.id("product.id", "Product ID", E.PRODUCT),
  F.string("product.title", "Title", E.PRODUCT, EDIT),
  F.string("product.handle", "Handle", E.PRODUCT, EDIT),
  F.string("product.descriptionHtml", "Description", E.PRODUCT, EDIT),
  F.string("product.vendor", "Vendor", E.PRODUCT, NULL_EDIT),
  F.string("product.productType", "Product type", E.PRODUCT, NULL_EDIT),
  F.enum("product.status", "Status", E.PRODUCT, EDIT),
  F.stringList("product.tags", "Tags", E.PRODUCT, EDIT),
  F.string("product.templateSuffix", "Theme template", E.PRODUCT, NULL_EDIT),
  F.datetime("product.createdAt", "Created at", E.PRODUCT),
  F.datetime("product.updatedAt", "Updated at", E.PRODUCT),
  F.datetime("product.publishedAt", "Published at", E.PRODUCT, NULL),
  F.string("product.seoTitle", "SEO title", E.PRODUCT, NULL_EDIT),
  F.string("product.seoDescription", "SEO description", E.PRODUCT, NULL_EDIT),
  F.id("product.categoryId", "Category ID", E.PRODUCT, NULL),

  // VARIANTS

  F.id("variant.id", "Variant ID", E.VARIANT),
  F.id("variant.productId", "Product ID", E.VARIANT),
  F.string("variant.title", "Variant title", E.VARIANT),
  F.string("variant.sku", "SKU", E.VARIANT, NULL_EDIT),
  F.string("variant.barcode", "Barcode", E.VARIANT, NULL_EDIT),
  F.money("variant.price", "Price", E.VARIANT, MONEY),
  F.money("variant.compareAtPrice", "Compare-at price", E.VARIANT, NULL_MONEY),
  F.enum("variant.inventoryPolicy", "Inventory policy", E.VARIANT, EDIT),
  F.integer("variant.inventoryQuantity", "Inventory quantity", E.VARIANT, DERIVED),
  F.bool("variant.taxable", "Taxable", E.VARIANT, EDIT),
  F.bool("variant.requiresComponents", "Requires components", E.VARIANT),
  F.integer("variant.position", "Variant position", E.VARIANT),
  F.datetime("variant.createdAt", "Created at", E.VARIANT),
  F.datetime("variant.updatedAt", "Updated at", E.VARIANT),

  // INVENTORY ITEMS

  F.id("inventoryItem.id", "Inventory item ID", E.INVENTORY_ITEM),
  F.string("inventoryItem.sku", "Inventory SKU", E.INVENTORY_ITEM, NULL_EDIT),
  F.bool("inventoryItem.tracked", "Inventory tracked", E.INVENTORY_ITEM, EDIT),
  F.bool("inventoryItem.requiresShipping", "Requires shipping", E.INVENTORY_ITEM, EDIT),
  F.money("inventoryItem.unitCost", "Unit cost", E.INVENTORY_ITEM, NULL_MONEY),
  F.string("inventoryItem.countryCodeOfOrigin", "Country of origin", E.INVENTORY_ITEM, NULL_EDIT),
  F.string("inventoryItem.harmonizedSystemCode", "HS code", E.INVENTORY_ITEM, NULL_EDIT),

  // INVENTORY LEVELS

  F.id("inventoryLevel.id", "Inventory level ID", E.INVENTORY_LEVEL),
  F.id("inventoryLevel.inventoryItemId", "Inventory item ID", E.INVENTORY_LEVEL),
  F.id("inventoryLevel.locationId", "Location ID", E.INVENTORY_LEVEL),
  F.integer("inventoryLevel.available", "Available inventory", E.INVENTORY_LEVEL, DERIVED),
  F.integer("inventoryLevel.onHand", "On-hand inventory", E.INVENTORY_LEVEL, DERIVED),
  F.integer("inventoryLevel.committed", "Committed inventory", E.INVENTORY_LEVEL, DERIVED),
  F.integer("inventoryLevel.incoming", "Incoming inventory", E.INVENTORY_LEVEL, DERIVED),

  // LOCATIONS

  F.id("location.id", "Location ID", E.LOCATION),
  F.string("location.name", "Location name", E.LOCATION),
  F.bool("location.active", "Active", E.LOCATION),

  // COLLECTIONS

  F.id("collection.id", "Collection ID", E.COLLECTION),
  F.string("collection.title", "Collection title", E.COLLECTION),
  F.string("collection.handle", "Collection handle", E.COLLECTION),
  F.datetime("collection.updatedAt", "Updated at", E.COLLECTION),

  // PRODUCT OPTIONS

  F.id("productOption.id", "Product option ID", E.PRODUCT_OPTION),
  F.id("productOption.productId", "Product ID", E.PRODUCT_OPTION),
  F.string("productOption.name", "Option name", E.PRODUCT_OPTION, EDIT),
  F.integer("productOption.position", "Option position", E.PRODUCT_OPTION),
  F.stringList("productOption.values", "Option values", E.PRODUCT_OPTION),

  // PRODUCT TAXONOMY

  F.id("category.id", "Taxonomy category ID", E.CATEGORY),
  F.string("category.name", "Category name", E.CATEGORY),
  F.string("category.fullName", "Category path", E.CATEGORY),
];

// --------------------------------------------------
// 6. Registry assembly
// --------------------------------------------------

function buildRegistry(definitions) {
  if (!Array.isArray(definitions)) {
    throw new TypeError(
      "Canonical definitions must be an array"
    );
  }

  const registry = Object.create(null);

  for (const definition of definitions) {
    validateDefinition(definition);

    if (Object.hasOwn(registry, definition.id)) {
      invalidDefinition(
        "Duplicate canonical field identifier",
        definition.id
      );
    }

    registry[definition.id] = definition;
  }

  return deepFreeze(registry);
}

export const CANONICAL_FIELDS = buildRegistry(DEFINITIONS);

// --------------------------------------------------
// 7. Registry measurement and validation
// --------------------------------------------------

/**
 * Measures the actual assembled fixed-field registry.
 *
 * Limits are not automatically increased.
 * Failure means the contract must be investigated.
 */
export const CANONICAL_REGISTRY_METADATA_USAGE =
  measureFieldMetadata(CANONICAL_FIELDS);

export const CANONICAL_REGISTRY_METADATA_BUDGETS =
  FIELD_METADATA_BUDGETS;

export function assertCanonicalRegistry() {
  const entries = Object.entries(CANONICAL_FIELDS);

  if (entries.length !== DEFINITIONS.length) {
    throw new Error(
      "Canonical registry size mismatch"
    );
  }

  if (!Object.isFrozen(CANONICAL_FIELDS)) {
    throw new Error(
      "Mutable canonical registry"
    );
  }

  for (const [id, definition] of entries) {
    if (id !== definition.id) {
      throw new Error(
        "Canonical field identity mismatch"
      );
    }

    validateDefinition(definition);

    if (!Object.isFrozen(definition)) {
      throw new Error(
        "Mutable canonical field definition"
      );
    }
  }

  return true;
}

assertCanonicalRegistry();

// --------------------------------------------------
// 8. Lookups
// --------------------------------------------------

export function isCanonicalField(value) {
  return (
    typeof value === "string" &&
    Object.hasOwn(CANONICAL_FIELDS, value)
  );
}

export function getCanonicalField(fieldId) {
  return isCanonicalField(fieldId)
    ? CANONICAL_FIELDS[fieldId]
    : null;
}

export function requireCanonicalField(fieldId) {
  const field = getCanonicalField(fieldId);

  if (!field) {
    throw new FieldError(
      FIELD_ERROR_CODES.UNKNOWN_FIELD,
      "Unknown canonical field",
      { fieldId }
    );
  }

  return field;
}

// --------------------------------------------------
// 9. Listing and filtering
// --------------------------------------------------

const ALL_FIELDS = Object.freeze(
  Object.values(CANONICAL_FIELDS)
);

// Cached combinations are bounded because all
// accepted filters belong to finite registries.
const listCache = new Map();

export function listCanonicalFields({
  entity,
  type,
  editable,
  derived,
} = {}) {
  if (
    entity !== undefined &&
    !isFieldEntity(entity)
  ) {
    throw new TypeError("Invalid entity filter");
  }

  if (
    type !== undefined &&
    !isFieldType(type)
  ) {
    throw new TypeError("Invalid type filter");
  }

  if (
    editable !== undefined &&
    typeof editable !== "boolean"
  ) {
    throw new TypeError("Invalid editable filter");
  }

  if (
    derived !== undefined &&
    typeof derived !== "boolean"
  ) {
    throw new TypeError("Invalid derived filter");
  }

  if (
    entity === undefined &&
    type === undefined &&
    editable === undefined &&
    derived === undefined
  ) {
    return ALL_FIELDS;
  }

  const key = JSON.stringify([
    entity ?? null,
    type ?? null,
    editable ?? null,
    derived ?? null,
  ]);

  const cached = listCache.get(key);
  if (cached) return cached;

  const result = Object.freeze(
    ALL_FIELDS.filter((field) =>
      (entity === undefined || field.entity === entity) &&
      (type === undefined || field.type === type) &&
      (editable === undefined || field.editable === editable) &&
      (derived === undefined || field.derived === derived)
    )
  );

  listCache.set(key, result);
  return result;
}

// --------------------------------------------------
// 10. Registry summary
// --------------------------------------------------

export const CANONICAL_FIELD_COUNT =
  DEFINITIONS.length;

export const CANONICAL_FIELD_ENTITIES = deepFreeze(
  [...new Set(DEFINITIONS.map((field) => field.entity))]
);

export const CANONICAL_REGISTRY_INFO = deepFreeze({
  contractVersion: CANONICAL_FIELD_CONTRACT_VERSION,
  registryVersion: CANONICAL_FIELD_REGISTRY_VERSION,
  typeContractVersion: CANONICAL_FIELD_TYPE_VERSION,
  fieldCount: CANONICAL_FIELD_COUNT,
});

// Dynamic metafields belong in fields/resolve.js.
// Shopify source mappings belong in fields/sources.js.
// Field readiness and authorization are separate.
