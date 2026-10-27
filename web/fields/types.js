export const FIELD_TYPES = Object.freeze({
  TEXT: "text", HTML: "html", ENUM: "enum", GID: "gid", INTEGER: "integer",
  DECIMAL: "decimal", BOOLEAN: "boolean", DATETIME: "datetime", URL: "url",
  STRING_LIST: "string_list", TEXT_ARRAY: "text_array",
});

// Application payload limits, not a replacement for Shopify's shop-specific rules.
export const FIELD_LIMITS = Object.freeze({
  textLength: 65536, htmlLength: 1048576, decimalLength: 256,
  listLength: 1000, listItemLength: 1024, changes: 100, variants: 2048,
  fieldReferences: 1000, metafieldDefinitions: 10000,
});

export class FieldError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = "FieldError";
    this.code = code;
    this.field = field;
    this.status = 400;
  }
}

// Type traits describe generic representations, not authorization or field support.
const typeDefinitions = deepFreeze(Object.fromEntries(Object.values(FIELD_TYPES).map(id => [id, {
  id, kind: ["string_list", "text_array"].includes(id) ? "array" :
    ["decimal", "integer", "boolean"].includes(id) ? id : "string",
  comparable: !["string_list", "text_array", "html"].includes(id),
  searchable: ["text", "string_list", "text_array"].includes(id),
  sortable: ["text", "decimal", "integer", "gid", "datetime"].includes(id),
  ...(id === "decimal" ? { storage: "string" } : {}),
  ...(id === "integer" ? { storage: "safe_integer" } : {}),
  ...(["string_list", "text_array"].includes(id) ? { elementType: "text" } : {}),
}])));
export function getFieldType(type) {
  return typeof type === "string" && Object.hasOwn(typeDefinitions, type) ? typeDefinitions[type] : null;
}
export function requireFieldType(type) {
  const definition = getFieldType(type);
  if (!definition) throw new TypeError("Unsupported field type");
  return definition;
}
export function isFieldType(type) { return getFieldType(type) !== null; }
export function listFieldTypes() { return Object.freeze(Object.values(typeDefinitions)); }
export function isComparableType(type) { return getFieldType(type)?.comparable === true; }
export function isSortableType(type) { return getFieldType(type)?.sortable === true; }
export function isSearchableType(type) { return getFieldType(type)?.searchable === true; }

// Opaque backend revision/snapshot tokens are compared, never executed or
// converted to numbers. Reject blank, unbounded and malformed identities.
export function isCoverageToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\s\u0000-\u001f\u007f-\u009f\p{Surrogate}]/u.test(value);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function isPlainRecord(value) {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// Do not invoke getters or traverse prototypes in untrusted input or mirror JSON.
export function ownValue(record, key) {
  if (!record || typeof record !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(record, key);
  if (!property) return undefined;
  if (!("value" in property))
    throw new FieldError("INVALID_FIELD_INPUT", "Accessor properties are not supported");
  return property.value;
}
