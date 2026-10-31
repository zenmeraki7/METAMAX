/**
 * METAMAX — Canonical Field Value Normalization
 *
 * Shared by:
 * - Filter Engine
 * - Bulk Edit Engine
 * - Import / Export Engine
 * - Scheduled / Recurring Operations
 *
 * CONTRACT:
 * - No Shopify, Prisma, SQL, React or HTTP coupling.
 * - No implicit Boolean or numeric coercion.
 * - Exact decimals use strings.
 * - Enums require trusted allowed values.
 * - Datetimes normalize to canonical UTC.
 * - Null, empty and missing are distinct.
 * - Lists must be dense and ordinary.
 * - Operator operands are normalized by field type.
 *
 * This is value validation, not authorization,
 * source readiness or SQL compilation.
 */

import {
  FIELD_TYPES as T,
  FIELD_ERROR_CODES,
  FieldError,
  isFieldType,
  isCanonicalFieldId,
  isDecimalString,
  isBoundedDecimalString,
  isISODate,
  isISODateTime,
} from "./types.js";

import {
  assertOperatorCompatible,
  assertOperatorOperandShape,
  OPERATOR_VALUE_SHAPES as S,
  MAX_OPERATOR_SET_SIZE,
  MAX_OPERATOR_STRING_LENGTH,
} from "./operators.js";

// ==================================================
// 1. CONTRACT AND LIMITS
// ==================================================

export const NORMALIZE_CONTRACT_VERSION = 1;

export const NORMALIZE_LIMITS = Object.freeze({
  maxStringLength: 4096,
  maxHtmlLength: 65536,
  maxIdLength: 256,
  maxListItems: 100,
  maxEnumValues: 256,
  maxDecimalLength: 256,
  maxTimestampLength: 40,
});

const OWN = (object, key) =>
  Object.hasOwn(object, key);

const DECIMAL_TYPES = new Set([
  T.DECIMAL,
  T.MONEY,
  T.PERCENTAGE,
]);

const LIST_TYPES = new Set([
  T.STRING_LIST,
  T.ID_LIST,
]);

const CONSTRAINT_KEYS = new Set([
  "enumValues",
  "minLength",
  "maxLength",
  "maxItems",
  "allowEmpty",
  "allowNegative",
]);

const FIELD_KEYS = new Set([
  "id",
  "type",
  "nullable",
  "precision",
  "scale",
]);

const RFC3339_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

// ==================================================
// 2. ERROR HELPERS
// ==================================================

function fail(field, message = "Invalid field value") {
  throw new FieldError(
    FIELD_ERROR_CODES.INVALID_VALUE,
    message,
    {
      fieldId: isCanonicalFieldId(field?.id)
        ? field.id
        : null,
    }
  );
}

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

/**
 * Read data properties without invoking getters.
 *
 * Intended for trusted descriptors and normalized
 * request objects, not arbitrary JavaScript Proxies.
 */
function readDataProperties(
  value,
  allowed,
  description
) {
  if (!isPlainRecord(value)) {
    throw new TypeError(
      `Invalid ${description}`
    );
  }

  const result = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      throw new TypeError(
        `Unsupported ${description} property`
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !OWN(descriptor, "value")
    ) {
      throw new TypeError(
        `Accessor prohibited in ${description}`
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

// ==================================================
// 3. RESOLVED FIELD VALIDATION
// ==================================================

function resolveField(field) {
  if (!isPlainRecord(field)) {
    throw new TypeError(
      "Invalid resolved field descriptor"
    );
  }

  // Resolved descriptors may include other
  // validated metadata. Only read required fields.
  const result = Object.create(null);

  for (const key of FIELD_KEYS) {
    if (!OWN(field, key)) continue;

    const descriptor =
      Object.getOwnPropertyDescriptor(field, key);

    if (
      !descriptor ||
      !OWN(descriptor, "value")
    ) {
      throw new TypeError(
        "Invalid resolved field property"
      );
    }

    result[key] = descriptor.value;
  }

  if (
    !isCanonicalFieldId(result.id) ||
    !isFieldType(result.type) ||
    typeof result.nullable !== "boolean"
  ) {
    throw new TypeError(
      "Invalid resolved field contract"
    );
  }

  if (DECIMAL_TYPES.has(result.type)) {
    if (
      !Number.isSafeInteger(result.precision) ||
      !Number.isSafeInteger(result.scale) ||
      result.precision < 1 ||
      result.precision > 38 ||
      result.scale < 0 ||
      result.scale > result.precision
    ) {
      throw new TypeError(
        "Invalid decimal field definition"
      );
    }
  } else if (
    OWN(result, "precision") ||
    OWN(result, "scale")
  ) {
    throw new TypeError(
      "Unexpected decimal field constraints"
    );
  }

  return result;
}

// ==================================================
// 4. DENSE ARRAY VALIDATION
// ==================================================

/**
 * Rejects:
 * - Sparse arrays
 * - Additional own properties
 * - Symbol properties
 * - Indexed accessors
 * - Custom array prototypes
 *
 * Returns extracted elements without reading
 * potentially accessor-backed indexed properties.
 */
function readDenseArray(value, maxItems, field) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxItems
  ) {
    fail(field, "Invalid canonical array");
  }

  const length = value.length;
  const keys = Reflect.ownKeys(value);

  if (keys.length !== length + 1) {
    fail(field, "Unexpected array properties");
  }

  const items = [];

  for (let i = 0; i < length; i++) {
    if (keys[i] !== String(i)) {
      fail(field, "Invalid array index");
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        value,
        String(i)
      );

    if (
      !descriptor ||
      !OWN(descriptor, "value")
    ) {
      fail(field, "Sparse or accessor array");
    }

    items.push(descriptor.value);
  }

  if (keys[length] !== "length") {
    fail(field, "Invalid array structure");
  }

  return items;
}

// ==================================================
// 5. TRUSTED CONSTRAINT RESOLUTION
// ==================================================

function resolveConstraints(field, constraints) {
  const input = readDataProperties(
    constraints,
    CONSTRAINT_KEYS,
    "field constraints"
  );

  const defaultMax =
    field.id === "product.descriptionHtml"
      ? NORMALIZE_LIMITS.maxHtmlLength
      : field.type === T.ID ||
          field.type === T.ID_LIST
        ? NORMALIZE_LIMITS.maxIdLength
        : NORMALIZE_LIMITS.maxStringLength;

  const maxLength = OWN(input, "maxLength")
    ? input.maxLength
    : defaultMax;

  const minLength = OWN(input, "minLength")
    ? input.minLength
    : 0;

  const maxItems = OWN(input, "maxItems")
    ? input.maxItems
    : NORMALIZE_LIMITS.maxListItems;

  const allowEmpty = OWN(input, "allowEmpty")
    ? input.allowEmpty
    : true;

  const allowNegative = OWN(input, "allowNegative")
    ? input.allowNegative
    : true;

  if (
    !Number.isSafeInteger(maxLength) ||
    !Number.isSafeInteger(minLength) ||
    minLength < 0 ||
    maxLength < minLength ||
    maxLength > NORMALIZE_LIMITS.maxHtmlLength ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 0 ||
    maxItems > NORMALIZE_LIMITS.maxListItems ||
    typeof allowEmpty !== "boolean" ||
    typeof allowNegative !== "boolean"
  ) {
    throw new TypeError(
      "Invalid normalization constraints"
    );
  }

  if (
    LIST_TYPES.has(field.type) &&
    maxItems > NORMALIZE_LIMITS.maxListItems
  ) {
    throw new TypeError(
      "Invalid list item limit"
    );
  }

  let enumValues = null;

  if (field.type === T.ENUM) {
    if (!OWN(input, "enumValues")) {
      throw new TypeError(
        "Enum field requires trusted values"
      );
    }

    enumValues = readDenseArray(
      input.enumValues,
      NORMALIZE_LIMITS.maxEnumValues,
      field
    );

    if (
      enumValues.length === 0 ||
      enumValues.some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > maxLength
      ) ||
      new Set(enumValues).size !== enumValues.length
    ) {
      throw new TypeError(
        "Invalid trusted enum values"
      );
    }

    enumValues = new Set(enumValues);
  } else if (OWN(input, "enumValues")) {
    throw new TypeError(
      "Enum constraints on non-enum field"
    );
  }

  return {
    maxLength,
    minLength,
    maxItems,
    allowEmpty,
    allowNegative,
    enumValues,
  };
}

// ==================================================
// 6. STRING NORMALIZATION
// ==================================================

function normalizeString(value, field, constraints) {
  if (
    typeof value !== "string" ||
    value.length < constraints.minLength ||
    value.length > constraints.maxLength ||
    (!constraints.allowEmpty && value.length === 0)
  ) {
    fail(field, "Invalid canonical string");
  }

  return value;
}

// ==================================================
// 7. BOOLEAN NORMALIZATION
// ==================================================

function normalizeBoolean(value, field) {
  if (typeof value !== "boolean") {
    fail(field, "Expected canonical boolean");
  }

  return value;
}

// ==================================================
// 8. INTEGER NORMALIZATION
// ==================================================

function normalizeInteger(value, field, constraints) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (!constraints.allowNegative && value < 0)
  ) {
    fail(field, "Expected safe integer");
  }

  return Object.is(value, -0) ? 0 : value;
}

// ==================================================
// 9. EXACT DECIMAL NORMALIZATION
// ==================================================

function normalizeDecimal(value, field, constraints) {
  if (
    typeof value !== "string" ||
    value.length > NORMALIZE_LIMITS.maxDecimalLength ||
    !isDecimalString(value)
  ) {
    fail(field, "Expected canonical decimal string");
  }

  if (
    !isBoundedDecimalString(value, {
      precision: field.precision,
      scale: field.scale,
      allowNegative: constraints.allowNegative,
    })
  ) {
    fail(field, "Decimal precision or scale exceeded");
  }

  const negative = value.startsWith("-");

  const unsigned = negative
    ? value.slice(1)
    : value;

  const dot = unsigned.indexOf(".");

  const integer = dot === -1
    ? unsigned
    : unsigned.slice(0, dot);

  const fraction = dot === -1
    ? ""
    : unsigned.slice(dot + 1);

  const normalizedFraction =
    fraction.replace(/0+$/, "");

  const normalized = normalizedFraction
    ? `${integer}.${normalizedFraction}`
    : integer;

  // Normalize negative zero without floating point.
  if (
    integer === "0" &&
    normalizedFraction.length === 0
  ) {
    return "0";
  }

  return negative ? `-${normalized}` : normalized;
}

// ==================================================
// 10. DATE NORMALIZATION
// ==================================================

function normalizeDate(value, field) {
  if (!isISODate(value)) {
    fail(field, "Expected valid ISO date");
  }

  return value;
}

// ==================================================
// 11. DATETIME NORMALIZATION
// ==================================================

/**
 * Accepts RFC3339 timestamps with:
 * - Seconds required
 * - Optional 1–3 fractional digits
 * - Explicit Z or timezone offset
 *
 * Produces YYYY-MM-DDTHH:mm:ss.sssZ.
 *
 * Offsets are converted to UTC.
 * Rejects leap seconds and invalid calendar values.
 * Rejects timestamps outside supported ISO year range.
 */
function normalizeDateTime(value, field) {
  if (isISODateTime(value)) {
    return value;
  }

  if (
    typeof value !== "string" ||
    value.length > NORMALIZE_LIMITS.maxTimestampLength
  ) {
    fail(field, "Invalid datetime input");
  }

  const match = RFC3339_PATTERN.exec(value);

  if (!match) {
    fail(field, "Expected RFC3339 timestamp");
  }

  const [
    ,
    date,
    hourText,
    minuteText,
    secondText,
    milliseconds = "",
    zone,
  ] = match;

  if (!isISODate(date)) {
    fail(field, "Invalid calendar date");
  }

  const hours = Number(hourText);
  const minutes = Number(minuteText);
  const seconds = Number(secondText);

  if (
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    fail(field, "Invalid datetime clock");
  }

  let offsetMinutes = 0;

  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));

    if (
      offsetHours > 14 ||
      offsetRemainder > 59 ||
      (offsetHours === 14 && offsetRemainder !== 0)
    ) {
      fail(field, "Invalid timezone offset");
    }

    offsetMinutes =
      offsetHours * 60 + offsetRemainder;

    if (zone[0] === "-") {
      offsetMinutes = -offsetMinutes;
    }
  }

  const localISOString =
    `${date}T${hourText}:${minuteText}:${secondText}.` +
    `${milliseconds.padEnd(3, "0")}Z`;

  const localEpoch = Date.parse(localISOString);

  if (!Number.isFinite(localEpoch)) {
    fail(field, "Invalid timestamp");
  }

  const localDate = new Date(localEpoch);

  if (
    localDate.toISOString() !== localISOString
  ) {
    fail(field, "Invalid datetime components");
  }

  const utcEpoch =
    localEpoch - offsetMinutes * 60000;

  const utcDate = new Date(utcEpoch);

  if (!Number.isFinite(utcDate.getTime())) {
    fail(field, "Datetime outside supported range");
  }

  const normalized = utcDate.toISOString();

  if (!isISODateTime(normalized)) {
    fail(field, "Datetime outside canonical range");
  }

  return normalized;
}

// ==================================================
// 12. ID NORMALIZATION
// ==================================================

function normalizeId(value, field, constraints) {
  const maxLength = Math.min(
    constraints.maxLength,
    NORMALIZE_LIMITS.maxIdLength
  );

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.length < constraints.minLength ||
    /\s/.test(value)
  ) {
    fail(field, "Invalid canonical identifier");
  }

  return value;
}

// ==================================================
// 13. ENUM NORMALIZATION
// ==================================================

function normalizeEnum(value, field, constraints) {
  const normalized =
    normalizeString(value, field, constraints);

  if (!constraints.enumValues.has(normalized)) {
    fail(field, "Unknown canonical enum value");
  }

  return normalized;
}

// ==================================================
// 14. SCALAR VALUE NORMALIZATION
// ==================================================

function normalizeScalar(
  field,
  value,
  constraints,
  type = field.type
) {
  switch (type) {
    case T.STRING:
      return normalizeString(value, field, constraints);

    case T.ENUM:
      return normalizeEnum(value, field, constraints);

    case T.BOOLEAN:
      return normalizeBoolean(value, field);

    case T.INTEGER:
      return normalizeInteger(value, field, constraints);

    case T.DECIMAL:
    case T.MONEY:
    case T.PERCENTAGE:
      return normalizeDecimal(value, field, constraints);

    case T.DATE:
      return normalizeDate(value, field);

    case T.DATETIME:
      return normalizeDateTime(value, field);

    case T.ID:
      return normalizeId(value, field, constraints);

    default:
      fail(field, "Unsupported scalar field type");
  }
}

// ==================================================
// 15. FIELD VALUE NORMALIZATION
// ==================================================

/**
 * Normalize one canonical field value.
 *
 * The field must already be resolved through the
 * trusted Field Engine.
 *
 * The constraints must come from a trusted registry,
 * not from the merchant's request body.
 */
export function normalizeFieldValue(
  field,
  value,
  { constraints = {} } = {}
) {
  const resolved = resolveField(field);

  const limits =
    resolveConstraints(resolved, constraints);

  if (value === undefined) {
    fail(resolved, "Missing canonical field value");
  }

  if (value === null) {
    if (!resolved.nullable) {
      fail(resolved, "Null not allowed");
    }

    return null;
  }

  if (resolved.type === T.JSON) {
    fail(
      resolved,
      "JSON requires a separate normalization contract"
    );
  }

  if (LIST_TYPES.has(resolved.type)) {
    const items = readDenseArray(
      value,
      limits.maxItems,
      resolved
    );

    if (!limits.allowEmpty && items.length === 0) {
      fail(resolved, "Empty list not allowed");
    }

    const elementType =
      resolved.type === T.STRING_LIST
        ? T.STRING
        : T.ID;

    const normalized = items.map((item) =>
      normalizeScalar(
        resolved,
        item,
        limits,
        elementType
      )
    );

    return Object.freeze(normalized);
  }

  return normalizeScalar(
    resolved,
    value,
    limits
  );
}

// ==================================================
// 16. EXACT DECIMAL COMPARISON
// ==================================================

function decimalToComparable(value, scale) {
  const negative = value.startsWith("-");

  const unsigned = negative
    ? value.slice(1)
    : value;

  const [integer, fraction = ""] =
    unsigned.split(".");

  const digits =
    integer + fraction.padEnd(scale, "0");

  const magnitude = BigInt(digits);

  return negative ? -magnitude : magnitude;
}

function compareCanonicalValues(a, b, type) {
  if (DECIMAL_TYPES.has(type)) {
    const fractionA =
      (a.split(".")[1] ?? "").length;

    const fractionB =
      (b.split(".")[1] ?? "").length;

    const scale = Math.max(
      fractionA,
      fractionB
    );

    const left = decimalToComparable(a, scale);
    const right = decimalToComparable(b, scale);

    return left < right ? -1 : left > right ? 1 : 0;
  }

  if (
    type === T.INTEGER ||
    type === T.DATE ||
    type === T.DATETIME
  ) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  throw new TypeError(
    "Unsupported canonical range comparison"
  );
}

// ==================================================
// 17. OPERATOR OPERAND NORMALIZATION
// ==================================================

/**
 * Validates operator compatibility and structure,
 * then normalizes operands by the resolved field type.
 *
 * DOES NOT:
 * - Grant field filterability
 * - Check Shopify permissions
 * - Check mirror readiness
 * - Generate SQL
 *
 * hasValue must be obtained using:
 * Object.hasOwn(node, "value")
 */
export function normalizeOperatorOperand(
  field,
  operatorId,
  value,
  {
    hasValue = true,
    constraints = {},
  } = {}
) {
  const resolved = resolveField(field);

  const operator = assertOperatorCompatible(
    operatorId,
    resolved.type
  );

  assertOperatorOperandShape(
    operatorId,
    value,
    hasValue
  );

  if (operator.valueShape === S.NONE) {
    return undefined;
  }

  const limits = resolveConstraints(
    resolved,
    constraints
  );

  const operandType =
    resolved.type === T.STRING_LIST
      ? T.STRING
      : resolved.type === T.ID_LIST
        ? T.ID
        : resolved.type;

  function normalizeOperand(value) {
    // The operator contract applies before the
    // more specific canonical field constraints.
    if (
      typeof value === "string" &&
      value.length > MAX_OPERATOR_STRING_LENGTH
    ) {
      fail(resolved, "Operator operand too long");
    }

    return normalizeScalar(
      resolved,
      value,
      limits,
      operandType
    );
  }

  if (
    operator.valueShape === S.SCALAR ||
    operator.valueShape === S.ELEMENT
  ) {
    return normalizeOperand(value);
  }

  if (operator.valueShape !== S.SET && operator.valueShape !== S.PAIR) {
    fail(resolved, "Unsupported operator operand shape");
  }

  const items = readDenseArray(
    value,
    operator.valueShape === S.PAIR
      ? 2
      : MAX_OPERATOR_SET_SIZE,
    resolved
  );

  const normalized =
    items.map(normalizeOperand);

  if (
    operator.valueShape === S.PAIR &&
    compareCanonicalValues(
      normalized[0],
      normalized[1],
      resolved.type
    ) > 0
  ) {
    fail(resolved, "Invalid range boundaries");
  }

  return Object.freeze(normalized);
}
