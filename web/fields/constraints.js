/**
 * METAMAX — Trusted Field Constraint Registry
 *
 * web/fields/constraints.js
 *
 * Normalization policy is NOT authorization.
 *
 * This module:
 * - Separates read/filter/write constraints
 * - Defines write operand contracts
 * - Validates final write values
 * - Precomputes immutable canonical policies
 * - Rejects malformed policy metadata
 * - Supports verified dynamic policy resolution
 *
 * Shopify mutation selection, approval, permissions,
 * and execution belong to separate trusted services.
 */

import {
  deepFreeze,
  FieldError,
  FIELD_ERROR_CODES as C,
  FIELD_TYPES as T,
  isFieldType,
} from "./types.js";

import {
  CANONICAL_FIELDS,
  requireCanonicalField,
} from "./canonical.js";
import {requireInstalledWriteCapability,WRITE_CAPABILITY_VERSION} from './write-capabilities.js';

import {
  normalizeFieldValue,
  NORMALIZE_LIMITS,
} from "./normalize.js";
import {
  validateMetafieldShop,
  validateDynamicMetafieldId,
  METAFIELD_DEFINITION_TOKEN_PATTERN,
} from "./metafield-identity.js";

export const CONSTRAINTS_VERSION = 5;

export const POLICY_CONTEXT = deepFreeze({
  READ: "read",
  FILTER: "filter",
  WRITE: "write",
});

export const WRITE_OPERATIONS = deepFreeze({
  SET: "set",
  CLEAR: "clear",
  INCREASE: "increase",
  DECREASE: "decrease",
  MULTIPLY: "multiply",
  APPEND: "append",
  PREPEND: "prepend",
  ADD_ITEMS: "add_items",
  REMOVE_ITEMS: "remove_items",
});

export const WRITE_OPERAND_KIND = deepFreeze({
  VALUE: "value",
  NONE: "none",
  NUMBER: "number",
  LIST: "list",
});

export const CLEAR_STRATEGY = deepFreeze({
  NULL: "null",
  EMPTY_STRING: "empty_string",
  EMPTY_LIST: "empty_list",
});

const P = POLICY_CONTEXT;
const O = WRITE_OPERATIONS;
const K = WRITE_OPERAND_KIND;
const CLEAR = CLEAR_STRATEGY;

export const WRITE_OPERATION_OPERANDS = deepFreeze({
  [O.SET]: K.VALUE,
  [O.CLEAR]: K.NONE,
  [O.INCREASE]: K.NUMBER,
  [O.DECREASE]: K.NUMBER,
  [O.MULTIPLY]: K.NUMBER,
  [O.APPEND]: K.VALUE,
  [O.PREPEND]: K.VALUE,
  [O.ADD_ITEMS]: K.LIST,
  [O.REMOVE_ITEMS]: K.LIST,
});

const CONTEXTS = new Set(Object.values(P));
const OPERATIONS = new Set(Object.values(O));
const CLEAR_MODES = new Set(Object.values(CLEAR));

const NUMERIC = new Set([
  T.INTEGER,
  T.DECIMAL,
  T.MONEY,
  T.PERCENTAGE,
]);

const LISTS = new Set([
  T.STRING_LIST,
  T.ID_LIST,
]);

const TEXT = new Set([
  T.STRING,
  T.ENUM,
  T.ID,
]);

const NUMERIC_OPERATIONS = new Set([
  O.INCREASE,
  O.DECREASE,
  O.MULTIPLY,
]);

const LIST_OPERATIONS = new Set([
  O.ADD_ITEMS,
  O.REMOVE_ITEMS,
]);

const TEXT_OPERATIONS = new Set([
  O.APPEND,
  O.PREPEND,
]);

const NORMALIZATION_KEYS = new Set([
  "enumValues",
  "minLength",
  "maxLength",
  "maxItems",
  "allowEmpty",
  "allowNegative",
]);

const WRITE_KEYS = new Set([
  "operations",
  "clearStrategy",
  "uniqueItems",
  ...NORMALIZATION_KEYS,
]);

const MAX_OPERAND_BYTES = 65536;
const MAX_MULTIPLIER_DIGITS = 38;
const MAX_MULTIPLIER_SCALE = 18;

function fail(code, message, fieldId = null) {
  throw new FieldError(code, message, { fieldId });
}

// --------------------------------------------------
// 1. Strict own-data validation
// --------------------------------------------------

function plainRecord(value, allowed, fieldId) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(C.INVALID_DEFINITION, "Invalid policy", fieldId);
  }

  const proto = Object.getPrototypeOf(value);

  if (
    proto !== null &&
    proto !== Object.prototype
  ) {
    fail(C.INVALID_DEFINITION, "Invalid policy prototype", fieldId);
  }

  const copy = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Unexpected policy property",
        fieldId
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Policy accessors are prohibited",
        fieldId
      );
    }

    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return copy;
}

function denseUniqueStrings(value, fieldId, max = 256) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > max
  ) {
    fail(C.INVALID_DEFINITION, "Invalid policy list", fieldId);
  }

  // Reject symbols, custom properties, sparse arrays,
  // accessor-backed indices and overridden length
  // descriptors where applicable.
  const keys = Reflect.ownKeys(value);

  if (keys.length !== value.length + 1) {
    fail(
      C.INVALID_DEFINITION,
      "Unexpected array properties",
      fieldId
    );
  }

  const seen = new Set();
  const output = [];

  for (let i = 0; i < value.length; i++) {
    const descriptor =
      Object.getOwnPropertyDescriptor(value, String(i));

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      seen.has(descriptor.value)
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Invalid policy list entry",
        fieldId
      );
    }

    seen.add(descriptor.value);
    output.push(descriptor.value);
  }

  return Object.freeze(output);
}

function validateNormalization(field, raw) {
  const p = plainRecord(
    raw,
    NORMALIZATION_KEYS,
    field.id
  );

  const output = Object.create(null);

  for (const key of Reflect.ownKeys(p)) {
    if (key === "enumValues") {
      if (field.type !== T.ENUM) {
        fail(
          C.INVALID_DEFINITION,
          "Enum values on non-enum field",
          field.id
        );
      }

      output[key] = denseUniqueStrings(
        p[key],
        field.id,
        NORMALIZE_LIMITS.maxEnumValues
      );
      continue;
    }

    if (key === "minLength" || key === "maxLength") {
      if (
        !Number.isSafeInteger(p[key]) ||
        p[key] < 0 ||
        p[key] > NORMALIZE_LIMITS.maxHtmlLength
      ) {
        fail(
          C.INVALID_DEFINITION,
          "Invalid length constraint",
          field.id
        );
      }
    } else if (key === "maxItems") {
      if (
        !LISTS.has(field.type) ||
        !Number.isSafeInteger(p[key]) ||
        p[key] < 0 ||
        p[key] > NORMALIZE_LIMITS.maxListItems
      ) {
        fail(
          C.INVALID_DEFINITION,
          "Invalid list constraint",
          field.id
        );
      }
    } else if (
      key === "allowEmpty" ||
      key === "allowNegative"
    ) {
      if (typeof p[key] !== "boolean") {
        fail(
          C.INVALID_DEFINITION,
          "Invalid boolean constraint",
          field.id
        );
      }

      if (
        key === "allowNegative" &&
        !NUMERIC.has(field.type)
      ) {
        fail(
          C.INVALID_DEFINITION,
          "Sign restriction on nonnumeric field",
          field.id
        );
      }
    }

    output[key] = p[key];
  }

  if (
    output.minLength !== undefined &&
    output.maxLength !== undefined &&
    output.minLength > output.maxLength
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Inconsistent length limits",
      field.id
    );
  }

  return deepFreeze(output);
}

// --------------------------------------------------
// 2. Read representation constraints
// --------------------------------------------------

/**
 * These describe recognized source representation.
 *
 * They must not inherit mutation-only limits.
 *
 * The existing normalizer still applies its own
 * implementation-level safety ceilings.
 */

const REPRESENTATION_OVERRIDES = deepFreeze({
  "product.status": {
    enumValues: ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"],
  },

  "variant.inventoryPolicy": {
    enumValues: ["DENY", "CONTINUE"],
  },
});

// --------------------------------------------------
// 3. Filter operand constraints
// --------------------------------------------------

/**
 * These limits apply to user-supplied operands.
 * They do NOT restrict existing mirror field values.
 */

const FILTER_OVERRIDES = deepFreeze({
  "product.title": {
    maxLength: 255,
  },

  "product.vendor": {
    maxLength: 255,
  },

  "product.handle": {
    maxLength: 255,
  },

  "product.tags": {
    maxItems: 100,
  },

  "variant.sku": {
    maxLength: 255,
  },
});

// --------------------------------------------------
// 4. Outgoing write restrictions
// --------------------------------------------------

const WRITE_NORMALIZATION = deepFreeze({
  "product.title": {
    allowEmpty: false,
    maxLength: 255,
  },

  "product.handle": {
    allowEmpty: false,
    maxLength: 255,
  },

  "product.vendor": {
    maxLength: 255,
  },

  "product.productType": {
    maxLength: 255,
  },

  "product.tags": {
    maxItems: 100,
    allowEmpty: true,
  },

  "variant.sku": {
    maxLength: 255,
  },

  "variant.barcode": {
    maxLength: 255,
  },

  "variant.price": {
    allowNegative: false,
  },

  "variant.compareAtPrice": {
    allowNegative: false,
  },

  "inventoryItem.unitCost": {
    allowNegative: false,
  },
});

/**
 * Operation permissions are structural.
 *
 * They are NOT evidence that Shopify supports
 * a particular mutation or that it is authorized.
 */

const WRITE_POLICIES = deepFreeze({
  "product.title": {
    operations: [O.SET],
  },

  "product.handle": {
    operations: [O.SET],
  },

  "product.descriptionHtml": {
    operations: [O.SET],
  },

  "product.vendor": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "product.productType": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "product.status": {
    operations: [O.SET],
  },

  "product.tags": {
    operations: [
      O.SET,
      O.CLEAR,
      O.ADD_ITEMS,
      O.REMOVE_ITEMS,
    ],
    clearStrategy: CLEAR.EMPTY_LIST,
    uniqueItems: true,
  },

  "product.templateSuffix": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "product.seoTitle": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "product.seoDescription": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "variant.sku": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "variant.barcode": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "variant.price": {
    operations: [
      O.SET,
      O.INCREASE,
      O.DECREASE,
      O.MULTIPLY,
    ],
  },

  "variant.compareAtPrice": {
    operations: [
      O.SET,
      O.CLEAR,
      O.INCREASE,
      O.DECREASE,
      O.MULTIPLY,
    ],
    clearStrategy: CLEAR.NULL,
  },

  "variant.inventoryPolicy": {
    operations: [O.SET],
  },

  "variant.taxable": {
    operations: [O.SET],
  },

  "inventoryItem.sku": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "inventoryItem.tracked": {
    operations: [O.SET],
  },

  "inventoryItem.requiresShipping": {
    operations: [O.SET],
  },

  "inventoryItem.unitCost": {
    operations: [
      O.SET,
      O.CLEAR,
      O.INCREASE,
      O.DECREASE,
      O.MULTIPLY,
    ],
    clearStrategy: CLEAR.NULL,
  },

  "inventoryItem.countryCodeOfOrigin": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "inventoryItem.harmonizedSystemCode": {
    operations: [O.SET, O.CLEAR],
    clearStrategy: CLEAR.NULL,
  },

  "productOption.name": {
    operations: [O.SET],
  },
});

// --------------------------------------------------
// 5. Validate operation policy
// --------------------------------------------------

function validateWritePolicy(field, raw) {
  const p = plainRecord(raw, WRITE_KEYS, field.id);

  if (!field.editable || field.derived) {
    fail(
      C.READ_ONLY,
      "Write policy assigned to read-only field",
      field.id
    );
  }

  if (field.type === T.JSON) {
    fail(
      C.INVALID_DEFINITION,
      "Write policy not supported for JSON field",
      field.id
    );
  }

  const operations = denseUniqueStrings(
    p.operations,
    field.id,
    Object.keys(WRITE_OPERATIONS).length
  );

  for (const operation of operations) {
    if (!OPERATIONS.has(operation)) {
      fail(
        C.INVALID_DEFINITION,
        "Unknown write operation",
        field.id
      );
    }

    if (
      NUMERIC_OPERATIONS.has(operation) &&
      !NUMERIC.has(field.type)
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Arithmetic on nonnumeric field",
        field.id
      );
    }

    if (
      LIST_OPERATIONS.has(operation) &&
      !LISTS.has(field.type)
    ) {
      fail(
        C.INVALID_DEFINITION,
        "List operation on non-list field",
        field.id
      );
    }

    if (
      TEXT_OPERATIONS.has(operation) &&
      field.type !== T.STRING
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Text operation on nontext field",
        field.id
      );
    }
  }

  if (operations.includes(O.CLEAR)) {
    if (!CLEAR_MODES.has(p.clearStrategy)) {
      fail(
        C.INVALID_DEFINITION,
        "Missing clear strategy",
        field.id
      );
    }

    if (
      p.clearStrategy === CLEAR.NULL &&
      !field.nullable
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Null clear on nonnullable field",
        field.id
      );
    }

    if (
      p.clearStrategy === CLEAR.EMPTY_LIST &&
      !LISTS.has(field.type)
    ) {
      fail(
        C.INVALID_DEFINITION,
        "List clear on non-list field",
        field.id
      );
    }

    if (
      p.clearStrategy === CLEAR.EMPTY_STRING &&
      field.type !== T.STRING
    ) {
      fail(
        C.INVALID_DEFINITION,
        "String clear on nonstring field",
        field.id
      );
    }
  } else if (p.clearStrategy !== undefined) {
    fail(
      C.INVALID_DEFINITION,
      "Unexpected clear strategy",
      field.id
    );
  }

  if (
    p.uniqueItems !== undefined &&
    (
      typeof p.uniqueItems !== "boolean" ||
      !LISTS.has(field.type)
    )
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Invalid list uniqueness policy",
      field.id
    );
  }

  return deepFreeze({
    operations,
    clearStrategy: p.clearStrategy ?? null,
    uniqueItems: p.uniqueItems === true,
  });
}

// --------------------------------------------------
// 6. Precomputed immutable registry
// --------------------------------------------------

function buildRegistry() {
  const registry = Object.create(null);

  for (const field of Object.values(CANONICAL_FIELDS)) {
    const representation = validateNormalization(
      field,
      REPRESENTATION_OVERRIDES[field.id] ?? {}
    );

    const filter = validateNormalization(field, {
      ...representation,
      ...(FILTER_OVERRIDES[field.id] ?? {}),
    });

    const write = validateNormalization(field, {
      ...representation,
      ...(WRITE_NORMALIZATION[field.id] ?? {}),
    });

    const rawWrite = WRITE_POLICIES[field.id];
    const writePolicy = rawWrite
      ? validateWritePolicy(field, rawWrite)
      : null;

    registry[field.id] = deepFreeze({
      fieldId: field.id,
      read: representation,
      filter,
      write,
      writePolicy,
    });
  }

  for (const table of [
    REPRESENTATION_OVERRIDES,
    FILTER_OVERRIDES,
    WRITE_NORMALIZATION,
    WRITE_POLICIES,
  ]) {
    for (const id of Object.keys(table)) {
      if (!Object.hasOwn(CANONICAL_FIELDS, id)) {
        fail(
          C.CONTRACT_MISMATCH,
          "Policy references unknown field",
          id
        );
      }
    }
  }

  for (const field of Object.values(CANONICAL_FIELDS)) {
    if (
      field.type === T.ENUM &&
      !Object.hasOwn(REPRESENTATION_OVERRIDES, field.id)
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Enum representation policy missing",
        field.id
      );
    }
  }

  return deepFreeze(registry);
}

export const FIELD_CONSTRAINT_REGISTRY = buildRegistry();

// --------------------------------------------------
// 7. Cached policy lookup
// --------------------------------------------------

function assertContext(context) {
  if (!CONTEXTS.has(context)) {
    fail(C.INVALID_VALUE, "Invalid policy context");
  }
}

export function getFieldConstraints(
  fieldId,
  context = P.READ
) {
  const field = requireCanonicalField(fieldId);
  assertContext(context);

  return FIELD_CONSTRAINT_REGISTRY[field.id][context];
}

export function getFieldPolicy(
  fieldId,
  context = P.READ
) {
  const field = requireCanonicalField(fieldId);
  assertContext(context);

  const entry = FIELD_CONSTRAINT_REGISTRY[field.id];

  return deepFreeze({
    fieldId: field.id,
    context,
    type: field.type,
    nullable: field.nullable,
    constraints: entry[context],
    operations:
      context === P.WRITE && entry.writePolicy
        ? listFieldWriteOperations(field.id)
        : [],
  });
}

// --------------------------------------------------
// 8. Structural write operation validation
// --------------------------------------------------

export function assertFieldWriteOperation(
  fieldId,
  operation
) {
  const field = requireCanonicalField(fieldId);

  if (!field.editable || field.derived) {
    fail(
      C.READ_ONLY,
      "Field is not structurally writable",
      field.id
    );
  }

  if (!OPERATIONS.has(operation)) {
    fail(
      C.UNSUPPORTED_OPERATION,
      "Unknown operation",
      field.id
    );
  }

  const policy =
    FIELD_CONSTRAINT_REGISTRY[field.id].writePolicy;

  if (
    !policy ||
    !policy.operations.includes(operation)
  ) {
    fail(
      C.UNSUPPORTED_OPERATION,
      "Operation not permitted by field policy",
      field.id
    );
  }

  return policy;
}

export function listFieldWriteOperations(fieldId) {
  return Object.freeze(listStructuralFieldWriteOperations(fieldId).filter(operation=>{
    try{requireInstalledWriteCapability(fieldId,operation,WRITE_CAPABILITY_VERSION);return true;}catch{return false;}
  }));
}

/** Pure operand-normalization policy, explicitly separate from installed support. */
export function listStructuralFieldWriteOperations(fieldId) {
  const field = requireCanonicalField(fieldId);

  return (
    FIELD_CONSTRAINT_REGISTRY[field.id]
      .writePolicy?.operations ??
    Object.freeze([])
  );
}

// --------------------------------------------------
// 9. Operand shape and byte safety
// --------------------------------------------------

function assertByteBudget(value, fieldId) {
  // JSON length bounds apply to JSON-compatible
  // operands, not arbitrary object graphs.
  if (
    typeof value !== "string" &&
    !Array.isArray(value)
  ) {
    return;
  }

  if (Array.isArray(value)) {
    if (
      value.length > NORMALIZE_LIMITS.maxListItems ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      fail(
        C.INVALID_VALUE,
        "Invalid operand list",
        fieldId
      );
    }

    let bytes = 0;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys[value.length] !== "length") {
      fail(C.INVALID_VALUE, "Unexpected operand array properties", fieldId);
    }

    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (keys[i] !== String(i) || !descriptor ||
          !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") {
        fail(
          C.INVALID_VALUE,
          "Sparse operand list",
          fieldId
        );
      }

      bytes += Buffer.byteLength(descriptor.value, "utf8");

      if (bytes > MAX_OPERAND_BYTES) {
        fail(
          C.INVALID_VALUE,
          "Operand exceeds byte limit",
          fieldId
        );
      }
    }

    return;
  }

  if (
    Buffer.byteLength(value, "utf8") >
    MAX_OPERAND_BYTES
  ) {
    fail(
      C.INVALID_VALUE,
      "Operand exceeds byte limit",
      fieldId
    );
  }
}

// --------------------------------------------------
// 10. Exact numeric operand contract
// --------------------------------------------------

function normalizeNumericOperand(
  field,
  value,
  operation
) {
  if (field.type === T.INTEGER) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      fail(
        C.INVALID_VALUE,
        "Expected nonnegative integer operand",
        field.id
      );
    }

    return value;
  }

  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    fail(
      C.INVALID_VALUE,
      "Expected nonnegative decimal operand",
      field.id
    );
  }

  const [integer, fraction = ""] = value.split(".");

  const significantInteger =
    integer.replace(/^0+/, "");

  const digits = Math.max(
    1,
    significantInteger.length + fraction.length
  );

  if (
    digits > MAX_MULTIPLIER_DIGITS ||
    fraction.length > MAX_MULTIPLIER_SCALE
  ) {
    fail(
      C.INVALID_VALUE,
      "Numeric operand precision exceeded",
      field.id
    );
  }

  // INCREASE and DECREASE operands must also
  // respect the target field's decimal limits.
  // MULTIPLY is a dimensionless factor and uses
  // its independent precision contract.
  if (operation !== O.MULTIPLY) {
    return normalizeFieldValue(field, value, {
      constraints: {
        allowNegative: false,
      },
    });
  }

  return value;
}

// --------------------------------------------------
// 11. Write operand normalization
// --------------------------------------------------

/**
 * Normalizes the incoming operation operand.
 *
 * CLEAR must not contain a value.
 *
 * This function does NOT compute the final value
 * and does NOT authorize a mutation.
 */

export function normalizeWriteOperand(
  fieldId,
  operation,
  operand
) {
  const field = requireCanonicalField(fieldId);
  const policy =
    assertFieldWriteOperation(fieldId, operation);

  const kind = WRITE_OPERATION_OPERANDS[operation];

  if (kind === K.NONE) {
    if (operand !== undefined) {
      fail(
        C.INVALID_VALUE,
        "CLEAR must not contain an operand",
        field.id
      );
    }

    return undefined;
  }

  if (operand === undefined) {
    fail(
      C.INVALID_VALUE,
      "Missing write operand",
      field.id
    );
  }

  assertByteBudget(operand, field.id);

  if (kind === K.NUMBER) {
    return normalizeNumericOperand(
      field,
      operand,
      operation
    );
  }

  const constraints = getFieldConstraints(
    field.id,
    P.WRITE
  );

  if (kind === K.LIST) {
    // Field is a list by registry validation.
    const result = normalizeFieldValue(
      field,
      operand,
      {
        constraints: {
          ...constraints,
          allowEmpty: false,
        },
      }
    );

    if (policy.uniqueItems) {
      if (new Set(result).size !== result.length) {
        fail(
          C.INVALID_VALUE,
          "Duplicate operand list items",
          field.id
        );
      }
    }

    return result;
  }

  if (TEXT_OPERATIONS.has(operation)) {
    // APPEND and PREPEND are string fragments.
    // The final string must be validated separately.
    return normalizeFieldValue(
      field,
      operand,
      {
        constraints: {
          ...constraints,
          allowEmpty: false,
        },
      }
    );
  }

  // SET represents a proposed complete field value.
  return normalizeFieldValue(
    field,
    operand,
    { constraints }
  );
}

// --------------------------------------------------
// 12. Clear result contract
// --------------------------------------------------

export function getFieldClearResult(fieldId) {
  const policy =
    assertFieldWriteOperation(fieldId, O.CLEAR);

  switch (policy.clearStrategy) {
    case CLEAR.NULL:
      return null;

    case CLEAR.EMPTY_STRING:
      return "";

    case CLEAR.EMPTY_LIST:
      return Object.freeze([]);

    default:
      fail(
        C.CONTRACT_MISMATCH,
        "Missing clear result contract",
        fieldId
      );
  }
}

// --------------------------------------------------
// 13. Mandatory final-value validation
// --------------------------------------------------

/**
 * Call after SET, relative arithmetic, list
 * modifications, append/prepend, or CLEAR.
 *
 * `finalValue` must be the result computed by
 * the trusted operation implementation.
 *
 * Shopify mutation adapter-specific validation
 * remains mandatory after this function.
 */

export function validateFinalWriteValue(
  fieldId,
  operation,
  finalValue
) {
  const field = requireCanonicalField(fieldId);

  const policy =
    assertFieldWriteOperation(fieldId, operation);

  const constraints = getFieldConstraints(
    field.id,
    P.WRITE
  );

  const normalized = normalizeFieldValue(
    field,
    // Normalize signed zero before enforcing the outgoing sign restriction.
    constraints.allowNegative === false && NUMERIC.has(field.type)
      ? normalizeFieldValue(field, finalValue, { constraints: { ...constraints, allowNegative: true } })
      : finalValue,
    { constraints }
  );

  if (
    policy.uniqueItems &&
    Array.isArray(normalized) &&
    new Set(normalized).size !== normalized.length
  ) {
    fail(
      C.INVALID_VALUE,
      "Final list contains duplicates",
      field.id
    );
  }

  if (operation === O.CLEAR) {
    const expected = getFieldClearResult(field.id);

    const matches =
      Array.isArray(expected)
        ? Array.isArray(normalized) &&
          normalized.length === 0
        : normalized === expected;

    if (!matches) {
      fail(
        C.INVALID_VALUE,
        "Final value does not match clear strategy",
        field.id
      );
    }
  }

  return normalized;
}

// --------------------------------------------------
// 14. Verified dynamic field policy entry
// --------------------------------------------------

/**
 * Dynamic metafield policies must be supplied by
 * an authenticated, shop-scoped field service.
 *
 * This function requires the trusted service to
 * return a validated policy bound to its verified
 * definition revision.
 *
 * Do not call this with a request-controlled
 * callback or unverified field descriptor.
 *
 * The returned policy is metadata, not an
 * authorization grant.
 */

const DYNAMIC_FIELD_KEYS = new Set(["id", "label", "entity", "type", "nullable", "editable", "derived", "precision", "scale"]);
const DYNAMIC_POLICY_KEYS = new Set(["shopId", "fieldId", "definitionToken", "verified", "field", "read", "filter", "write", "writePolicy"]);

/** Builds validated policy metadata; only a trusted adapter can attest its source. */
export function createDynamicFieldPolicy({ shopId, field, definitionToken, constraints = {}, writePolicy } = {}) {
  validateMetafieldShop(shopId);
  const f = plainRecord(field, DYNAMIC_FIELD_KEYS);
  validateDynamicMetafieldId(f.id);
  if (!isFieldType(f.type) || typeof f.nullable !== "boolean" ||
      typeof f.editable !== "boolean" || typeof f.derived !== "boolean" ||
      (f.editable && f.derived) || typeof definitionToken !== "string" ||
      !METAFIELD_DEFINITION_TOKEN_PATTERN.test(definitionToken)) {
    fail(C.INVALID_DEFINITION, "Invalid dynamic policy definition", f.id);
  }
  if (f.editable && f.type === T.JSON) {
    fail(C.INVALID_DEFINITION, "JSON dynamic field cannot be editable", f.id);
  }
  if ([T.DECIMAL, T.MONEY, T.PERCENTAGE].includes(f.type)) {
    if (!Number.isSafeInteger(f.precision) || !Number.isSafeInteger(f.scale) ||
        f.precision < 1 || f.precision > 38 || f.scale < 0 || f.scale > f.precision) {
      fail(C.INVALID_DEFINITION, "Invalid dynamic decimal policy", f.id);
    }
  } else if (f.precision !== undefined || f.scale !== undefined) {
    fail(C.INVALID_DEFINITION, "Unexpected dynamic decimal policy", f.id);
  }
  const contexts = plainRecord(constraints, new Set(Object.values(P)), f.id);
  const read = validateNormalization(f, contexts.read ?? {});
  const filter = validateNormalization(f, { ...read, ...plainRecord(contexts.filter ?? {}, NORMALIZATION_KEYS, f.id) });
  const write = validateNormalization(f, { ...read, ...plainRecord(contexts.write ?? {}, NORMALIZATION_KEYS, f.id) });
  if (f.type === T.ENUM && (!read.enumValues || !filter.enumValues || !write.enumValues)) {
    fail(C.INVALID_DEFINITION, "Dynamic enum values required", f.id);
  }
  // JSON has no generic normalization contract and receives no default writes.
  const defaultWrite = f.editable && !f.derived && f.type !== T.JSON
    ? { operations: f.nullable ? [O.SET, O.CLEAR] : [O.SET], ...(f.nullable ? { clearStrategy: CLEAR.NULL } : {}) }
    : null;
  const rawWrite = writePolicy === undefined ? defaultWrite : writePolicy;
  if (f.editable && rawWrite === null) {
    fail(C.INVALID_DEFINITION, "Editable dynamic field requires write policy", f.id);
  }
  return deepFreeze({
    shopId, fieldId: f.id, definitionToken, verified: true, field: f,
    read, filter, write, writePolicy: rawWrite === null ? null : validateWritePolicy(f, rawWrite),
  });
}

/** Revalidate returned metadata against the independently resolved definition. */
export function validateDynamicFieldPolicy(raw, { shopId, field, definitionToken }) {
  field = plainRecord(field, DYNAMIC_FIELD_KEYS);
  const p = plainRecord(raw, DYNAMIC_POLICY_KEYS, field.id);
  const declared = plainRecord(p.field, DYNAMIC_FIELD_KEYS, field.id);
  if (p.shopId !== shopId || p.fieldId !== field.id || p.verified !== true ||
      p.definitionToken !== definitionToken ||
      [...DYNAMIC_FIELD_KEYS].some(key => declared[key] !== field[key]) ||
      !["read", "filter", "write", "writePolicy"].every(key => Object.hasOwn(p, key))) {
    fail(C.INVALID_DEFINITION, "Dynamic policy binding mismatch", field.id);
  }
  if (field.editable && p.writePolicy === null) {
    fail(C.INVALID_DEFINITION, "Editable dynamic policy requires writePolicy", field.id);
  }
  if (!field.editable && p.writePolicy !== null) {
    fail(C.INVALID_DEFINITION, "Read-only dynamic policy cannot declare writePolicy", field.id);
  }
  // Validated write policies use null for an absent clear strategy.
  const writePolicy = p.writePolicy === null ? null : plainRecord(p.writePolicy, WRITE_KEYS, field.id);
  const policyInput = writePolicy === null ? null : {
    ...writePolicy, ...(writePolicy.clearStrategy === null ? { clearStrategy: undefined } : {}),
  };
  if (policyInput && !LISTS.has(field.type) && policyInput.uniqueItems === false) {
    delete policyInput.uniqueItems;
  }
  return createDynamicFieldPolicy({
    shopId, field, definitionToken,
    constraints: { read: p.read, filter: p.filter, write: p.write }, writePolicy: policyInput,
  });
}

export async function resolveDynamicFieldPolicy({
  shopId,
  fieldId,
  context,
  trustedPolicyResolver,
} = {}) {
  assertContext(context);

  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    typeof fieldId !== "string" ||
    typeof trustedPolicyResolver !== "function"
  ) {
    fail(
      C.MISSING_DEPENDENCY,
      "Trusted dynamic policy service required"
    );
  }

  validateMetafieldShop(shopId);
  validateDynamicMetafieldId(fieldId);

  const rawResult = await trustedPolicyResolver({
    shopId,
    fieldId,
    context,
  });
  const result = plainRecord(rawResult, DYNAMIC_POLICY_KEYS, fieldId);
  const field = plainRecord(result.field, DYNAMIC_FIELD_KEYS, fieldId);

  if (
    !result ||
    result.shopId !== shopId ||
    result.fieldId !== fieldId ||
    typeof result.definitionToken !== "string" ||
    !METAFIELD_DEFINITION_TOKEN_PATTERN.test(result.definitionToken) ||
    result.verified !== true ||
    field.id !== fieldId
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Unverified dynamic field policy",
      fieldId
    );
  }

  if (
    context === P.WRITE &&
    (
      field.editable !== true ||
      field.derived === true ||
      result.writePolicy === null ||
      result.writePolicy === undefined
    )
  ) {
    fail(
      C.READ_ONLY,
      "Dynamic field is not writable",
      fieldId
    );
  }

  return validateDynamicFieldPolicy(result, {
    shopId, field, definitionToken: result.definitionToken,
  });
}

// --------------------------------------------------
// 15. Registry integrity and metadata
// --------------------------------------------------

export function assertFieldConstraintRegistry() {
  for (const field of Object.values(CANONICAL_FIELDS)) {
    const entry = FIELD_CONSTRAINT_REGISTRY[field.id];

    if (
      !entry ||
      entry.fieldId !== field.id ||
      !Object.isFrozen(entry)
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Constraint registry mismatch",
        field.id
      );
    }
  }

  return true;
}

export const FIELD_CONSTRAINT_REGISTRY_INFO =
  deepFreeze({
    version: CONSTRAINTS_VERSION,
    fieldCount: Object.keys(
      FIELD_CONSTRAINT_REGISTRY
    ).length,
    contexts: Object.values(P),
    operations: Object.values(O),
    operandKinds: Object.values(K),
    lengthSemantics: "UTF-16 code units",
    apiByteLimitRequired: true,
  });

assertFieldConstraintRegistry();
