/**
 * METAMAX — Canonical Field Type Foundation
 *
 * Shared by:
 * - Filter Engine
 * - Bulk Edit Engine
 * - Import / Export Engine
 * - Scheduled / Recurring Operations
 * - Mirror Engine
 *
 * CONTRACT:
 * - No external runtime dependencies.
 * - Stable canonical field type identifiers.
 * - No database, Shopify API or HTTP coupling.
 * - Decimal values use strings, not floating point.
 * - Metadata validation precedes freezing.
 * - Trusted, application-owned metadata only.
 * - Public errors never serialize internal messages.
 * - Metadata work is bounded by independent budgets.
 */

export const FIELD_TYPE_CONTRACT_VERSION = 1;

// ==================================================
// 1. CANONICAL FIELD TYPES
// ==================================================

export const FIELD_TYPES = Object.freeze({
  STRING: "string",
  ENUM: "enum",
  BOOLEAN: "boolean",

  INTEGER: "integer",
  DECIMAL: "decimal",
  MONEY: "money",
  PERCENTAGE: "percentage",

  DATE: "date",
  DATETIME: "datetime",

  ID: "id",
  STRING_LIST: "string_list",
  ID_LIST: "id_list",

  JSON: "json",
});

const ALL_TYPES = new Set(Object.values(FIELD_TYPES));

const NUMERIC_TYPES = new Set([
  FIELD_TYPES.INTEGER,
  FIELD_TYPES.DECIMAL,
  FIELD_TYPES.MONEY,
  FIELD_TYPES.PERCENTAGE,
]);

const TEMPORAL_TYPES = new Set([
  FIELD_TYPES.DATE,
  FIELD_TYPES.DATETIME,
]);

const COLLECTION_TYPES = new Set([
  FIELD_TYPES.STRING_LIST,
  FIELD_TYPES.ID_LIST,
]);

const TEXTUAL_TYPES = new Set([
  FIELD_TYPES.STRING,
  FIELD_TYPES.ENUM,
  FIELD_TYPES.ID,
]);

const SORTABLE_TYPES = new Set([
  ...TEXTUAL_TYPES,
  ...NUMERIC_TYPES,
  ...TEMPORAL_TYPES,
  FIELD_TYPES.BOOLEAN,
]);

// ==================================================
// 2. SHARED CONSTANTS
// ==================================================

/**
 * Conservative application defaults.
 *
 * These are safety budgets, not performance targets.
 *
 * Measure complete production registries before
 * considering any change to these defaults.
 */
export const FIELD_METADATA_BUDGETS = Object.freeze({
  maxDepth: 32,
  maxNodes: 10000,
  maxProperties: 50000,
  maxVisits: 100000,
});

const FORBIDDEN_METADATA_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const FIELD_ID_PATTERN =
  /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export const FIELD_ID_LIMITS = Object.freeze({
  MAX_BYTES: 160,
});

export const DYNAMIC_FIELD_ID_PATTERN =
  /^(product|variant)\.metafield\.[a-z][a-zA-Z0-9]{7,95}$/;

const STRUCTURAL_FIELD_ID_PATTERN =
  /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

const DECIMAL_PATTERN =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}$/;

const DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const DAYS_IN_MONTH = Object.freeze([
  31, 28, 31, 30, 31, 30,
  31, 31, 30, 31, 30, 31,
]);

const MAX_DECIMAL_STRING_LENGTH = 256;

// ==================================================
// 3. OBJECT CONTRACTS
// ==================================================

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function assertMetadataPrimitive(value) {
  const type = typeof value;

  if (
    type === "function" ||
    type === "symbol" ||
    type === "bigint"
  ) {
    throw new TypeError(
      "Unsupported field metadata primitive"
    );
  }

  if (
    type === "number" &&
    !Number.isFinite(value)
  ) {
    throw new TypeError(
      "Non-finite field metadata number"
    );
  }
}

function resolveMetadataBudgets(options = {}) {
  if (
    options === null ||
    !isPlainObject(options)
  ) {
    throw new TypeError(
      "Invalid metadata budget options"
    );
  }

  const allowed = new Set([
    "maxDepth",
    "maxNodes",
    "maxProperties",
    "maxVisits",
  ]);

  const budgets = {
    ...FIELD_METADATA_BUDGETS,
  };

  for (const key of Reflect.ownKeys(options)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      throw new TypeError(
        "Unknown metadata budget option"
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(options, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        "Metadata budget accessors prohibited"
      );
    }

    budgets[key] = descriptor.value;
  }

  for (const [name, minimum] of [
    ["maxDepth", 0],
    ["maxNodes", 1],
    ["maxProperties", 0],
    ["maxVisits", 1],
  ]) {
    const limit = budgets[name];

    if (
      !Number.isSafeInteger(limit) ||
      limit < minimum
    ) {
      throw new TypeError(
        `Invalid metadata budget: ${name}`
      );
    }
  }

  return budgets;
}

// ==================================================
// 4. METADATA GRAPH VALIDATION
// ==================================================

/**
 * Internal iterative graph validator.
 *
 * Guarantees for stable, trusted metadata:
 *
 * - Bounded depth.
 * - Bounded unique object count.
 * - Bounded unique property count.
 * - Bounded traversal visits.
 * - Cycle rejection.
 * - Shared references supported.
 * - Deepest reachable paths are checked.
 * - Accessors and symbol keys rejected.
 * - Functions, symbols, BigInts and non-finite
 *   numbers rejected.
 * - Exotic objects rejected.
 *
 * Returns objects for the freezing phase and
 * measurement statistics.
 *
 * IMPORTANT:
 * Proxies and concurrently mutated objects are not
 * supported. This is not an untrusted-input sanitizer.
 */
function validateMetadataGraph(value, options) {
  const {
    maxDepth,
    maxNodes,
    maxProperties,
    maxVisits,
  } = resolveMetadataBudgets(options);

  const seenDepth = new WeakMap();
  const active = new WeakSet();
  const descriptorsCache = new WeakMap();

  const freezeOrder = [];

  let nodeCount = 0;
  let propertyCount = 0;
  let visitCount = 0;
  let deepestDepth = 0;

  const stack = [{
    node: value,
    depth: 0,
    entered: false,
    children: null,
    index: 0,
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    const { node, depth } = frame;

    if (!frame.entered) {
      // Count each frame entry, including revisits.
      visitCount++;

      if (visitCount > maxVisits) {
        throw new TypeError(
          "Field metadata traversal limit exceeded"
        );
      }

      if (depth > deepestDepth) {
        deepestDepth = depth;
      }

      // Validate primitive values, including
      // root-level primitives.
      if (
        node === null ||
        typeof node !== "object"
      ) {
        assertMetadataPrimitive(node);

        stack.pop();
        continue;
      }

      // An active ancestor is a genuine cycle.
      if (active.has(node)) {
        throw new TypeError(
          "Cyclic field metadata"
        );
      }

      if (depth > maxDepth) {
        throw new TypeError(
          "Field metadata depth exceeded"
        );
      }

      const previousDepth = seenDepth.get(node);

      // A subtree validated at an equal or greater
      // depth cannot violate a shallower depth limit.
      //
      // A deeper occurrence must be checked again.
      if (
        previousDepth !== undefined &&
        previousDepth >= depth
      ) {
        stack.pop();
        continue;
      }

      let children = descriptorsCache.get(node);

      if (children === undefined) {
        if (
          !Array.isArray(node) &&
          !isPlainObject(node)
        ) {
          throw new TypeError(
            "Unsupported metadata object"
          );
        }

        nodeCount++;

        if (nodeCount > maxNodes) {
          throw new TypeError(
            "Field metadata node limit exceeded"
          );
        }

        const keys = Reflect.ownKeys(node);

        // Charge each property's cost once,
        // regardless of shared-reference revisits.
        if (
          keys.length > maxProperties - propertyCount
        ) {
          throw new TypeError(
            "Field metadata property limit exceeded"
          );
        }

        propertyCount += keys.length;

        children = [];

        for (const key of keys) {
          if (
            typeof key !== "string" ||
            FORBIDDEN_METADATA_KEYS.has(key)
          ) {
            throw new TypeError(
              "Forbidden field metadata key"
            );
          }

          const descriptor =
            Object.getOwnPropertyDescriptor(node, key);

          if (
            !descriptor ||
            !Object.hasOwn(descriptor, "value")
          ) {
            throw new TypeError(
              "Metadata accessors prohibited"
            );
          }

          const child = descriptor.value;

          if (
            child === null ||
            typeof child !== "object"
          ) {
            assertMetadataPrimitive(child);
          }

          children.push(child);
        }

        // Cache child references so deeper revisits
        // do not repeat property inspection.
        descriptorsCache.set(node, children);

        freezeOrder.push(node);
      }

      seenDepth.set(node, depth);
      active.add(node);

      frame.entered = true;
      frame.children = children;
      frame.index = 0;

      continue;
    }

    if (frame.index < frame.children.length) {
      const child = frame.children[frame.index++];

      // Object children participate in cycle detection.
      if (
        child !== null &&
        typeof child === "object" &&
        active.has(child)
      ) {
        throw new TypeError(
          "Cyclic field metadata"
        );
      }

      stack.push({
        node: child,
        depth: depth + 1,
        entered: false,
        children: null,
        index: 0,
      });

      continue;
    }

    active.delete(node);
    stack.pop();
  }

  return {
    freezeOrder,
    stats: Object.freeze({
      nodes: nodeCount,
      properties: propertyCount,
      visits: visitCount,
      maxDepthObserved: deepestDepth,
    }),
  };
}

// ==================================================
// 5. METADATA MEASUREMENT
// ==================================================

/**
 * Inspect trusted metadata without freezing it.
 *
 * This uses exactly the same validation and budgets
 * as deepFreeze().
 *
 * Use at startup or in a CI measurement script.
 *
 * Do not execute repeatedly on every request.
 */
export function measureFieldMetadata(
  value,
  options = {}
) {
  return validateMetadataGraph(value, options).stats;
}

// ==================================================
// 6. DEEP FREEZE
// ==================================================

/**
 * Two-phase validation and freezing.
 *
 * Validation must complete successfully before
 * any Object.freeze() call is made.
 *
 * Intended for trusted application-owned metadata.
 *
 * Avoid passing custom Proxies or objects with
 * exotic runtime behavior.
 */
export function deepFreeze(
  value,
  options = {}
) {
  const { freezeOrder } =
    validateMetadataGraph(value, options);

  // Freeze only after the entire graph validates.
  for (let i = freezeOrder.length - 1; i >= 0; i--) {
    Object.freeze(freezeOrder[i]);
  }

  return value;
}

// ==================================================
// 7. FIELD TYPE CAPABILITIES
// ==================================================

export const FIELD_TYPE_CAPABILITIES = deepFreeze(
  Object.fromEntries(
    Object.values(FIELD_TYPES).map((type) => [
      type,
      {
        numeric: NUMERIC_TYPES.has(type),
        temporal: TEMPORAL_TYPES.has(type),
        collection: COLLECTION_TYPES.has(type),
        textual: TEXTUAL_TYPES.has(type),
        sortable: SORTABLE_TYPES.has(type),

        scalar:
          !COLLECTION_TYPES.has(type) &&
          type !== FIELD_TYPES.JSON,
      },
    ])
  )
);

function assertCapabilityRegistry() {
  const types = Object.values(FIELD_TYPES);

  const registered =
    Object.keys(FIELD_TYPE_CAPABILITIES);

  if (
    types.length !== new Set(types).size ||
    registered.length !== types.length
  ) {
    throw new Error(
      "Field capability registry mismatch"
    );
  }

  const typeSet = new Set(types);

  for (const type of registered) {
    if (!typeSet.has(type)) {
      throw new Error(
        "Unexpected field type capability"
      );
    }
  }

  for (const type of types) {
    if (
      !Object.hasOwn(
        FIELD_TYPE_CAPABILITIES,
        type
      )
    ) {
      throw new Error(
        "Missing field type capabilities"
      );
    }

    const capabilities =
      FIELD_TYPE_CAPABILITIES[type];

    if (
      capabilities.numeric !== NUMERIC_TYPES.has(type) ||
      capabilities.temporal !== TEMPORAL_TYPES.has(type) ||
      capabilities.collection !== COLLECTION_TYPES.has(type) ||
      capabilities.textual !== TEXTUAL_TYPES.has(type) ||
      capabilities.sortable !== SORTABLE_TYPES.has(type) ||
      capabilities.scalar !== (
        !COLLECTION_TYPES.has(type) &&
        type !== FIELD_TYPES.JSON
      )
    ) {
      throw new Error(
        "Inconsistent field type capabilities"
      );
    }
  }
}

assertCapabilityRegistry();

// ==================================================
// 8. TYPE PREDICATES
// ==================================================

export function isFieldType(type) {
  return (
    typeof type === "string" &&
    ALL_TYPES.has(type)
  );
}

export function isNumericType(type) {
  return NUMERIC_TYPES.has(type);
}

export function isTemporalType(type) {
  return TEMPORAL_TYPES.has(type);
}

export function isCollectionType(type) {
  return COLLECTION_TYPES.has(type);
}

export function isTextualType(type) {
  return TEXTUAL_TYPES.has(type);
}

export function isSortableType(type) {
  return SORTABLE_TYPES.has(type);
}

export function isScalarType(type) {
  return (
    isFieldType(type) &&
    !COLLECTION_TYPES.has(type) &&
    type !== FIELD_TYPES.JSON
  );
}

export function getTypeCapabilities(type) {
  assertFieldType(type);

  return FIELD_TYPE_CAPABILITIES[type];
}

// ==================================================
// 9. ERROR CODES
// ==================================================

export const FIELD_ERROR_CODES = Object.freeze({
  INVALID_TYPE: "FIELD_INVALID_TYPE",
  INVALID_VALUE: "FIELD_INVALID_VALUE",
  INVALID_DEFINITION: "FIELD_INVALID_DEFINITION",

  UNKNOWN_FIELD: "FIELD_UNKNOWN_FIELD",
  UNSUPPORTED_OPERATION: "FIELD_UNSUPPORTED_OPERATION",

  READ_ONLY: "FIELD_READ_ONLY",

  MISSING_DEPENDENCY: "FIELD_MISSING_DEPENDENCY",
  EXECUTION_UNAVAILABLE: "FIELD_EXECUTION_UNAVAILABLE",
  INVALID_SOURCE: "FIELD_INVALID_SOURCE",

  PERMISSION_DENIED: "FIELD_PERMISSION_DENIED",
  CONTRACT_MISMATCH: "FIELD_CONTRACT_MISMATCH",
});

const ERROR_CODE_SET = new Set(
  Object.values(FIELD_ERROR_CODES)
);

// ==================================================
// 10. CANONICAL FIELD IDENTIFIERS
// ==================================================

/** General field identity syntax only; does not check registry membership. */
export function isValidFieldId(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= FIELD_ID_LIMITS.MAX_BYTES &&
    STRUCTURAL_FIELD_ID_PATTERN.test(value)
  );
}

export function hasUnpairedSurrogate(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Legacy-compatible supported syntax; neither existence nor authorization. */
export function isSupportedFieldId(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= FIELD_ID_LIMITS.MAX_BYTES &&
    !hasUnpairedSurrogate(value) && (isCanonicalFieldId(value) || DYNAMIC_FIELD_ID_PATTERN.test(value));
}

export function isDynamicMetafieldId(value) {
  return isSupportedFieldId(value) && DYNAMIC_FIELD_ID_PATTERN.test(value);
}

/** Identifies the currently supported dynamic metafield family. */
export function isDynamicFieldId(value) {
  return isValidFieldId(value) && DYNAMIC_FIELD_ID_PATTERN.test(value);
}

export function isCanonicalFieldId(value) {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    FIELD_ID_PATTERN.test(value)
  );
}

export function assertCanonicalFieldId(value) {
  if (!isCanonicalFieldId(value)) {
    throw new FieldError(
      FIELD_ERROR_CODES.INVALID_DEFINITION,
      "Invalid canonical field identifier"
    );
  }

  return value;
}

// ==================================================
// 11. SAFE FIELD ERROR CONTRACT
// ==================================================

/**
 * Error messages are internal diagnostics.
 *
 * API controllers should expose approved
 * user-facing messages based on error codes.
 *
 * Do not return error.message or error.details
 * directly to merchants.
 */
export class FieldError extends Error {
  constructor(
    code,
    message,
    {
      fieldId = null,
      details = null,
      cause,
    } = {}
  ) {
    if (!ERROR_CODE_SET.has(code)) {
      throw new TypeError(
        "Unknown field error code"
      );
    }

    if (
      typeof message !== "string" ||
      message.length === 0
    ) {
      throw new TypeError(
        "FieldError requires a message"
      );
    }

    super(message, { cause });

    this.name = "FieldError";
    this.code = code;
    this.fieldId = fieldId;
    this.details = details;

    Object.setPrototypeOf(
      this,
      new.target.prototype
    );
  }

  toJSON() {
    return {
      error: this.code,
      message: "Invalid field operation",

      ...(isCanonicalFieldId(this.fieldId)
        ? { fieldId: this.fieldId }
        : {}),
    };
  }
}

export function assertFieldType(type) {
  if (!isFieldType(type)) {
    throw new FieldError(
      FIELD_ERROR_CODES.INVALID_TYPE,
      "Unsupported canonical field type"
    );
  }

  return type;
}

// ==================================================
// 12. INTEGER CONTRACT
// ==================================================

export function isFiniteInteger(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  );
}

// ==================================================
// 13. DECIMAL CONTRACTS
// ==================================================

/**
 * Canonical decimal string syntax.
 *
 * No exponential notation.
 * No whitespace.
 * No positive sign.
 * No JavaScript floating-point conversion.
 *
 * The 256-character limit is part of the
 * accepted-input contract.
 */
export function isDecimalString(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_DECIMAL_STRING_LENGTH &&
    DECIMAL_PATTERN.test(value)
  );
}

/**
 * Validates storage precision and scale.
 *
 * DECIMAL(p,s):
 *
 * - At most p-s integer digits.
 * - At most s fractional digits.
 * - A zero integer part consumes no integer
 *   precision when validating DECIMAL(p,p).
 *
 * Does not round values or normalize their
 * representations.
 */
export function isBoundedDecimalString(
  value,
  {
    precision = 18,
    scale = 6,
    allowNegative = true,
  } = {}
) {
  if (
    !Number.isSafeInteger(precision) ||
    !Number.isSafeInteger(scale) ||
    precision < 1 ||
    scale < 0 ||
    scale > precision ||
    typeof allowNegative !== "boolean"
  ) {
    throw new TypeError(
      "Invalid decimal constraints"
    );
  }

  if (!isDecimalString(value)) {
    return false;
  }

  if (
    !allowNegative &&
    value.startsWith("-")
  ) {
    return false;
  }

  const unsigned = value.startsWith("-")
    ? value.slice(1)
    : value;

  const dotIndex = unsigned.indexOf(".");

  const integer = dotIndex === -1
    ? unsigned
    : unsigned.slice(0, dotIndex);

  const fractionDigits = dotIndex === -1
    ? 0
    : unsigned.length - dotIndex - 1;

  const integerDigits =
    integer === "0" ? 0 : integer.length;

  return (
    integerDigits <= precision - scale &&
    fractionDigits <= scale
  );
}

// ==================================================
// 14. ISO DATE CONTRACT
// ==================================================

/**
 * Accepts strictly YYYY-MM-DD.
 *
 * Validates Gregorian calendar dates.
 */
export function isISODate(value) {
  if (
    typeof value !== "string" ||
    !DATE_PATTERN.test(value)
  ) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return false;
  }

  const leapYear =
    year % 4 === 0 &&
    (
      year % 100 !== 0 ||
      year % 400 === 0
    );

  const daysInMonth =
    month === 2 && leapYear
      ? 29
      : DAYS_IN_MONTH[month - 1];

  return day <= daysInMonth;
}

// ==================================================
// 15. CANONICAL UTC DATETIME CONTRACT
// ==================================================

/**
 * Canonical storage representation:
 *
 * YYYY-MM-DDTHH:mm:ss.sssZ
 *
 * Rejects:
 * - Invalid calendar dates
 * - Invalid clock components
 * - Non-UTC offsets
 * - Missing milliseconds
 * - Leap-second notation
 *
 * Shopify's incoming datetime values should be
 * normalized separately before this predicate.
 */
export function isISODateTime(value) {
  if (
    typeof value !== "string" ||
    !DATETIME_PATTERN.test(value)
  ) {
    return false;
  }

  if (!isISODate(value.slice(0, 10))) {
    return false;
  }

  const hours = Number(value.slice(11, 13));
  const minutes = Number(value.slice(14, 16));
  const seconds = Number(value.slice(17, 19));

  return (
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59 &&
    seconds >= 0 &&
    seconds <= 59
  );
}
