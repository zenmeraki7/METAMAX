import { requireValueField } from "./sources.js";
import { normalizeFieldValue, FieldNormalizationError } from "./normalize.js";
import { hasFieldCapability } from "./capabilities.js";
import { FieldError, FIELD_LIMITS, isFieldType, deepFreeze, isPlainRecord, ownValue } from "./types.js";

function checkedResult(fn) {
  try { return deepFreeze({ ok: true, value: fn(), errors: [] }); }
  catch (error) {
    if (!(error instanceof FieldError) && !(error instanceof FieldNormalizationError)) throw error;
    return deepFreeze({ ok: false, errors: [{ code: error.code, field: error.field, message: error.message }] });
  }
}

export class FieldValidationError extends FieldError {
  constructor(code, message, field = null) {
    super(code, message, field);
    this.name = "FieldValidationError";
  }
}

// Compare bounded canonical decimals exactly, including arbitrarily small fractions.
function compareDecimals(left, right) {
  const parse = value => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    return { digits: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
  };
  const a = parse(String(left)), b = parse(String(right)), scale = Math.max(a.scale, b.scale);
  const av = a.digits * 10n ** BigInt(scale - a.scale), bv = b.digits * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function metafieldConstraints(field, value, fail) {
  const rules = field.metafieldContract;
  if (!rules.validationsKnown) fail("METAFIELD_VALIDATIONS_REQUIRED", "The complete definition validations projection is required");
  if (value === null) return;
  const encoder = new TextEncoder();
  const byteLength = text => encoder.encode(text).length;
  if (Array.isArray(value)) {
    if (value.length < (rules.minItems ?? 0)) fail("BELOW_MINIMUM_ITEMS", "List has too few items");
    if (value.length > rules.maxItems) fail("ABOVE_MAXIMUM_ITEMS", "List has too many items");
    if (byteLength(JSON.stringify(value)) > 65536) fail("METAFIELD_SIZE_LIMIT", "Serialized list exceeds the metafield byte limit");
  }
  const textValues = typeof value === "string" && field.type === "text" ? [value] : Array.isArray(value) ? value : [];
  for (const text of textValues) {
    if (byteLength(text) > 65536) fail("METAFIELD_SIZE_LIMIT", "Text exceeds the metafield byte limit");
    if (field.shopifyType !== "multi_line_text_field" && /[\r\n\u2028\u2029]/u.test(text))
      fail("INVALID_SINGLE_LINE_TEXT", "Single-line metafields cannot contain line breaks");
    const length = [...text].length;
    if (length < (rules.minTextLength ?? 0)) fail("BELOW_MINIMUM_LENGTH", "Text is shorter than its definition minimum");
    if (length > (rules.maxTextLength ?? Infinity)) fail("ABOVE_MAXIMUM_LENGTH", "Text exceeds its definition maximum");
    if (rules.choices && !rules.choices.includes(text)) fail("INVALID_CHOICE", "Value is not a declared definition choice");
  }
  if (["integer", "decimal"].includes(field.type)) {
    for (const [key, code] of [["min", "BELOW_MINIMUM"], ["definitionMin", "BELOW_MINIMUM"], ["max", "ABOVE_MAXIMUM"], ["definitionMax", "ABOVE_MAXIMUM"]]) {
      if (rules[key] !== undefined && (key.toLowerCase().endsWith("min") ? compareDecimals(value, rules[key]) < 0 : compareDecimals(value, rules[key]) > 0))
        fail(code, "Value violates the metafield numeric bound");
    }
    if (field.type === "decimal" && (value.split(".")[1]?.length ?? 0) > rules.maxPrecision)
      fail("MAX_PRECISION_EXCEEDED", "Decimal exceeds the metafield precision limit");
  }
}

function constraints(field, value) {
  const fail = (code, message) => { throw new FieldValidationError(code, message, field.id); };
  if (field.dynamic) metafieldConstraints(field, value, fail);
  if (value === null) {
    if (!field.nullable) fail("NULL_NOT_ALLOWED", "Field cannot be null");
    return value;
  }
  if (field.values && !field.values.includes(value)) fail("INVALID_ENUM", "Unsupported enum value");
  if (typeof value === "string") {
    if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))
      fail("INVALID_FIELD_VALUE", "String violates its declared length bounds");
    if (field.format === "handle" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
      fail("INVALID_FIELD_VALUE", "Invalid handle format");
    if (field.gidType && !new RegExp(`^gid://shopify/${field.gidType}/[1-9]\\d*$`).test(value))
      fail("INVALID_FIELD_VALUE", "Expected an opaque Shopify GID for this entity");
    if (field.type === "url") {
      let url;
      try { url = new URL(value); } catch { fail("INVALID_FIELD_VALUE", "Invalid URL"); }
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
        fail("INVALID_FIELD_VALUE", "Expected an HTTP URL without credentials");
    }
  }
  if (["decimal", "integer"].includes(field.type)) {
    if (field.min !== undefined && compareDecimals(value, field.min) < 0) fail("BELOW_MINIMUM", "Value is below the declared minimum");
    if (field.max !== undefined && compareDecimals(value, field.max) > 0) fail("ABOVE_MAXIMUM", "Value exceeds the declared maximum");
  }
  if (Array.isArray(value)) {
    if (value.length > (field.maxItems ?? FIELD_LIMITS.listLength)) fail("INVALID_TAG_COUNT", "List exceeds its declared item limit");
    const seen = new Set();
    for (const item of value) {
      if (field.nonEmptyItems && !item) fail("INVALID_FIELD_VALUE", "List entries cannot be blank");
      if (field.uniqueItems && seen.has(item)) fail("DUPLICATE_TAG", "Duplicate normalized tags are not allowed");
      seen.add(item);
    }
  }
  return value;
}

export function validateValue(fieldId, value) {
  return checkedResult(() => requireValidFieldValue(fieldId, value, { purpose: "read" }));
}

// Declared suitability only. Runtime scopes, installation and adapter checks are separate.
export function validateFieldValue(fieldReference, value, options = {}) {
  let field;
  try {
    field = requireValueField(fieldReference);
    if (!isPlainRecord(options)) throw new FieldValidationError("INVALID_PURPOSE", "Expected validation options", field.id);
    const suppliedPurpose = ownValue(options, "purpose");
    const purpose = suppliedPurpose === undefined ? "edit" : suppliedPurpose;
    if (!["read", "edit", "import", "export", "undo", "filter"].includes(purpose))
      throw new FieldValidationError("INVALID_PURPOSE", "Unknown validation purpose", field.id);
    if (!isFieldType(field.type)) throw new FieldValidationError("UNSUPPORTED_TYPE", "Unsupported field type", field.id);
    if (purpose !== "read") {
      const declaredCapability = field.dynamic
        ? field.capabilities[{ filter: "filterable", edit: "editable", import: "import", export: "export", undo: "undo" }[purpose]] === true
        : hasFieldCapability(field.id, purpose);
      if (!declaredCapability)
        throw new FieldValidationError("NOT_SUPPORTED", "Field does not declare this capability", field.id);
    }
    if (value === undefined) throw new FieldValidationError("MISSING_VALUE", "Field requires a value", field.id);
    const normalized = constraints(field, normalizeFieldValue(field, value));
    return deepFreeze({ valid: true, field: field.id, value: normalized, code: null, message: null });
  } catch (error) {
    if (!(error instanceof FieldError) && !(error instanceof FieldNormalizationError)) throw error;
    return Object.freeze({ valid: false, field: field?.id ?? null, value: undefined, code: error.code, message: error.message });
  }
}

export function requireValidFieldValue(fieldId, value, options) {
  const result = validateFieldValue(fieldId, value, options);
  if (!result.valid) throw new FieldValidationError(result.code, result.message, result.field);
  return result.value;
}

export function validateFieldValues(entries, options) {
  if (!Array.isArray(entries) || entries.length > FIELD_LIMITS.fieldReferences)
    throw new TypeError("Expected a bounded array of field entries");
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = ownValue(entries, String(i));
    if (!isPlainRecord(entry)) throw new FieldValidationError("INVALID_FIELD_INPUT", "Expected a plain field entry");
    for (const key of Reflect.ownKeys(entry)) {
      if (!["field", "value"].includes(key)) throw new FieldValidationError("INVALID_FIELD_INPUT", "Unsupported entry property");
      ownValue(entry, key);
    }
    results.push(validateFieldValue(ownValue(entry, "field"), ownValue(entry, "value"), options));
  }
  return deepFreeze({ valid: results.every(result => result.valid), results, errors: results.filter(result => !result.valid) });
}
