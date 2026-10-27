import { requireValueField } from "./sources.js";
import { FIELD_TYPES as T, FIELD_LIMITS, requireFieldType, ownValue } from "./types.js";

export class FieldNormalizationError extends TypeError {
  constructor(message, code = "INVALID_FIELD_VALUE") {
    super(message);
    this.name = "FieldNormalizationError";
    this.code = code;
  }
}
function invalid(_field, message) { throw new FieldNormalizationError(message); }
function string(value, limit = FIELD_LIMITS.textLength, nfc = true) {
  if (typeof value !== "string" || value.length > limit || /\0|\p{Surrogate}/u.test(value))
    invalid(null, "Expected a bounded string without invalid characters");
  const result = nfc ? value.normalize("NFC") : value;
  if (result.length > limit) invalid(null, "Normalized string exceeds the application limit");
  return result;
}
function datetime(field, value) {
  if (value instanceof Date) {
    try { return Date.prototype.toISOString.call(value); }
    catch { invalid(field, "Invalid date"); }
  }
  if (typeof value !== "string" || value.length > 64) invalid(field, "Expected an ISO 8601 timestamp");
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match) invalid(field, "Timestamp must include a timezone");
  const [, y, m, d, h, minute, second, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 ||
        (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0))) ||
      !Number.isFinite(Date.parse(normalized))) invalid(field, "Invalid calendar timestamp");
  // Keep source fractional precision and timezone; these may be revision evidence.
  return normalized;
}

// Representation only: nullability, enum membership and price bounds belong to validation.
export function normalizeValue(type, value) {
  requireFieldType(type);
  if (value === null) return null;
  switch (type) {
    case T.TEXT: return string(value);
    case T.HTML: return string(value, FIELD_LIMITS.htmlLength, false);
    case T.GID: return string(value, 256, false);
    case T.URL: return string(value, 8192, false).trim();
    case T.ENUM: {
      const result = string(value, 128).trim();
      if (!result) invalid(null, "Enum cannot be empty");
      return result;
    }
    case T.DECIMAL: {
      if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
      if (typeof value !== "string" || value.length > FIELD_LIMITS.decimalLength)
        invalid(null, "Expected a bounded decimal string or safe integer");
      const raw = value.trim();
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) invalid(null, "Invalid decimal format");
      const [whole, fraction = ""] = raw.replace(/^[+-]/, "").split(".");
      const integer = whole.replace(/^0+(?=\d)/, ""), digits = fraction.replace(/0+$/, "");
      return (raw.startsWith("-") && (integer !== "0" || digits) ? "-" : "") + integer + (digits ? `.${digits}` : "");
    }
    case T.INTEGER: {
      if (typeof value === "string" && value.length <= 32 && /^[+-]?\d+$/.test(value.trim())) {
        const big = BigInt(value.trim());
        if (big < BigInt(Number.MIN_SAFE_INTEGER) || big > BigInt(Number.MAX_SAFE_INTEGER))
          invalid(null, "Integer exceeds safe range");
        value = Number(big);
      }
      if (!Number.isSafeInteger(value)) invalid(null, "Expected a safe integer");
      return Object.is(value, -0) ? 0 : value;
    }
    case T.BOOLEAN:
      if (typeof value === "boolean") return value;
      if (typeof value === "string" && value.length <= 16 && /^(true|false)$/i.test(value.trim()))
        return value.trim().toLowerCase() === "true";
      invalid(null, "Expected true or false");
      break;
    case T.DATETIME: return datetime(null, value);
    case T.TEXT_ARRAY:
    case T.STRING_LIST: {
      if (!Array.isArray(value) || value.length > FIELD_LIMITS.listLength) invalid(null, "Expected a bounded string array");
      const entries = [];
      for (let i = 0; i < value.length; i++) entries.push(string(ownValue(value, String(i)), FIELD_LIMITS.listItemLength));
      return Object.freeze(entries);
    }
    default: throw new FieldNormalizationError("Unsupported field type", "UNSUPPORTED_TYPE");
  }
}

export function normalizeFieldValue(fieldReference, value) {
  const field = requireValueField(fieldReference);
  let result = normalizeValue(field.type, value);
  if (result === null) return result;
  if (typeof result === "string") {
    if (field.trim) result = result.trim();
    if (field.lowercase) result = result.toLowerCase();
    if (field.enumCase === "upper") result = result.toUpperCase();
  }
  if (Array.isArray(result) && field.trimItems) result = Object.freeze(result.map(item => item.trim()));
  return result;
}
