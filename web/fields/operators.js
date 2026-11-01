/**
 * METAMAX — Canonical Operator Contract
 *
 * Shared by filtering, bulk edit conditions,
 * import/export predicates and scheduled operations.
 *
 * CONTRACT:
 * - No Shopify, SQL, Prisma, HTTP or React dependency.
 * - Canonical operator IDs are stable.
 * - Registry metadata is immutable.
 * - Every operator has explicit operand semantics.
 * - Null and empty values are distinct.
 * - Negative predicates exclude null/missing values.
 * - Operand validation is bounded and fail-closed.
 * - Type compatibility is NOT field authorization.
 *
 * Field-specific normalization, scopes, coverage,
 * filterability and execution remain separate.
 */

import {
  FIELD_TYPES as T,
  FIELD_TYPE_CONTRACT_VERSION,
  FIELD_ERROR_CODES,
  FieldError,
  isFieldType,
  deepFreeze,
} from "./types.js";

// ==================================================
// 1. CONTRACT VERSIONS AND LIMITS
// ==================================================

export const OPERATOR_CONTRACT_VERSION = 1;

export const OPERATOR_FIELD_TYPE_VERSION =
  FIELD_TYPE_CONTRACT_VERSION;

/**
 * Counts JavaScript UTF-16 code units.
 * Aggregate UTF-8 byte limits are enforced later.
 */
export const MAX_OPERATOR_STRING_LENGTH = 4096;

export const MAX_OPERATOR_SET_SIZE = 100;

// ==================================================
// 2. OPERAND SHAPES
// ==================================================

export const OPERATOR_VALUE_SHAPES = Object.freeze({
  NONE: "none",
  SCALAR: "scalar",
  PAIR: "pair",
  SET: "set",
  ELEMENT: "element",
});

// ==================================================
// 3. STABLE OPERATOR IDENTIFIERS
// ==================================================

export const OPERATORS = Object.freeze({
  EQ: "eq",
  NEQ: "neq",
  IN: "in",
  NOT_IN: "not_in",

  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
  BETWEEN: "between",

  CONTAINS: "contains",
  NOT_CONTAINS: "not_contains",
  STARTS_WITH: "starts_with",
  ENDS_WITH: "ends_with",

  LIST_CONTAINS: "list_contains",
  LIST_NOT_CONTAINS: "list_not_contains",

  IS_NULL: "is_null",
  IS_NOT_NULL: "is_not_null",
  IS_EMPTY: "is_empty",
  IS_NOT_EMPTY: "is_not_empty",
});

// ==================================================
// 4. CANONICAL TYPE GROUPS
// ==================================================

const SCALARS = Object.freeze([
  T.STRING,
  T.ENUM,
  T.BOOLEAN,
  T.INTEGER,
  T.DECIMAL,
  T.MONEY,
  T.PERCENTAGE,
  T.DATE,
  T.DATETIME,
  T.ID,
]);

const ORDERED = Object.freeze([
  T.INTEGER,
  T.DECIMAL,
  T.MONEY,
  T.PERCENTAGE,
  T.DATE,
  T.DATETIME,
]);

const TEXT = Object.freeze([T.STRING]);

const LISTS = Object.freeze([
  T.STRING_LIST,
  T.ID_LIST,
]);

const EMPTIABLE = Object.freeze([
  T.STRING,
  ...LISTS,
]);

const ALL_TYPES = Object.freeze(Object.values(T));

const S = OPERATOR_VALUE_SHAPES;

// ==================================================
// 5. METADATA CONSTANTS
// ==================================================

const OPERATOR_FAMILIES = Object.freeze({
  COMPARISON: "comparison",
  TEXT: "text",
  COLLECTION: "collection",
  PRESENCE: "presence",
});

const NULL_POLICIES = Object.freeze({
  EXCLUDE: "exclude",
  INSPECT: "inspect",
});

const FAMILY_SET = new Set(
  Object.values(OPERATOR_FAMILIES)
);

const NULL_POLICY_SET = new Set(
  Object.values(NULL_POLICIES)
);

const SHAPE_SET = new Set(
  Object.values(OPERATOR_VALUE_SHAPES)
);

const TEXT_OPERATOR_IDS = new Set([
  OPERATORS.CONTAINS,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.STARTS_WITH,
  OPERATORS.ENDS_WITH,
]);

const COLLECTION_OPERATOR_IDS = new Set([
  OPERATORS.LIST_CONTAINS,
  OPERATORS.LIST_NOT_CONTAINS,
]);

const PRESENCE_OPERATOR_IDS = new Set([
  OPERATORS.IS_NULL,
  OPERATORS.IS_NOT_NULL,
  OPERATORS.IS_EMPTY,
  OPERATORS.IS_NOT_EMPTY,
]);

const NULL_INSPECTION_IDS = new Set([
  OPERATORS.IS_NULL,
  OPERATORS.IS_NOT_NULL,
]);

const SET_OPERATOR_IDS = new Set([
  OPERATORS.IN,
  OPERATORS.NOT_IN,
]);

const PAIR_OPERATOR_IDS = new Set([
  OPERATORS.BETWEEN,
]);

const ELEMENT_OPERATOR_IDS =
  COLLECTION_OPERATOR_IDS;

const NEGATIVE_OPERATOR_IDS = new Set([
  OPERATORS.NEQ,
  OPERATORS.NOT_IN,
  OPERATORS.NOT_CONTAINS,
  OPERATORS.LIST_NOT_CONTAINS,
]);

// ==================================================
// 6. OPERATOR DEFINITION FACTORY
// ==================================================

/**
 * nullPolicy:
 *
 * exclude:
 *   Null and missing canonical values do not match.
 *   Applies to negative predicates as well.
 *
 * inspect:
 *   Explicit null-presence test.
 *
 * caseSensitive:
 *   null  = not applicable
 *   false = case-insensitive substring/prefix/suffix
 *
 * Operand shape validation is structural.
 * Actual type and value constraints belong in
 * fields/normalize.js.
 */
function defineOperator(
  id,
  label,
  valueShape,
  fieldTypes,
  {
    family = OPERATOR_FAMILIES.COMPARISON,
    nullPolicy = NULL_POLICIES.EXCLUDE,
    caseSensitive = null,
  } = {}
) {
  return {
    id,
    label,
    valueShape,
    fieldTypes,
    family,
    nullPolicy,
    caseSensitive,
  };
}

// ==================================================
// 7. OPERATOR DEFINITIONS
// ==================================================

const DEFINITIONS = [
  defineOperator(
    OPERATORS.EQ, "Equals", S.SCALAR, SCALARS
  ),
  defineOperator(
    OPERATORS.NEQ, "Does not equal", S.SCALAR, SCALARS
  ),
  defineOperator(
    OPERATORS.IN, "Is one of", S.SET, SCALARS
  ),
  defineOperator(
    OPERATORS.NOT_IN, "Is not one of", S.SET, SCALARS
  ),

  defineOperator(
    OPERATORS.GT, "Greater than", S.SCALAR, ORDERED
  ),
  defineOperator(
    OPERATORS.GTE,
    "Greater than or equal",
    S.SCALAR,
    ORDERED
  ),
  defineOperator(
    OPERATORS.LT, "Less than", S.SCALAR, ORDERED
  ),
  defineOperator(
    OPERATORS.LTE,
    "Less than or equal",
    S.SCALAR,
    ORDERED
  ),
  defineOperator(
    OPERATORS.BETWEEN,
    "Between (inclusive)",
    S.PAIR,
    ORDERED
  ),

  defineOperator(
    OPERATORS.CONTAINS,
    "Contains text",
    S.SCALAR,
    TEXT,
    {
      family: OPERATOR_FAMILIES.TEXT,
      caseSensitive: false,
    }
  ),
  defineOperator(
    OPERATORS.NOT_CONTAINS,
    "Does not contain text",
    S.SCALAR,
    TEXT,
    {
      family: OPERATOR_FAMILIES.TEXT,
      caseSensitive: false,
    }
  ),
  defineOperator(
    OPERATORS.STARTS_WITH,
    "Starts with",
    S.SCALAR,
    TEXT,
    {
      family: OPERATOR_FAMILIES.TEXT,
      caseSensitive: false,
    }
  ),
  defineOperator(
    OPERATORS.ENDS_WITH,
    "Ends with",
    S.SCALAR,
    TEXT,
    {
      family: OPERATOR_FAMILIES.TEXT,
      caseSensitive: false,
    }
  ),

  defineOperator(
    OPERATORS.LIST_CONTAINS,
    "List contains",
    S.ELEMENT,
    LISTS,
    { family: OPERATOR_FAMILIES.COLLECTION }
  ),
  defineOperator(
    OPERATORS.LIST_NOT_CONTAINS,
    "List does not contain",
    S.ELEMENT,
    LISTS,
    { family: OPERATOR_FAMILIES.COLLECTION }
  ),

  defineOperator(
    OPERATORS.IS_NULL,
    "Is null",
    S.NONE,
    ALL_TYPES,
    {
      family: OPERATOR_FAMILIES.PRESENCE,
      nullPolicy: NULL_POLICIES.INSPECT,
    }
  ),
  defineOperator(
    OPERATORS.IS_NOT_NULL,
    "Is not null",
    S.NONE,
    ALL_TYPES,
    {
      family: OPERATOR_FAMILIES.PRESENCE,
      nullPolicy: NULL_POLICIES.INSPECT,
    }
  ),
  defineOperator(
    OPERATORS.IS_EMPTY,
    "Is empty",
    S.NONE,
    EMPTIABLE,
    { family: OPERATOR_FAMILIES.PRESENCE }
  ),
  defineOperator(
    OPERATORS.IS_NOT_EMPTY,
    "Is not empty",
    S.NONE,
    EMPTIABLE,
    { family: OPERATOR_FAMILIES.PRESENCE }
  ),
];

// ==================================================
// 8. REGISTRY CONSTRUCTION
// ==================================================

function assertUniqueIdentifiers(values, label) {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0
    )
  ) {
    throw new Error(
      `Invalid canonical ${label} identifiers`
    );
  }
}

assertUniqueIdentifiers(
  Object.values(OPERATORS),
  "operator"
);

assertUniqueIdentifiers(
  Object.values(OPERATOR_VALUE_SHAPES),
  "operand shape"
);

const declaredOperatorIds = new Set(
  Object.values(OPERATORS)
);

const registry = Object.create(null);

for (const spec of DEFINITIONS) {
  if (
    !spec ||
    typeof spec.id !== "string" ||
    !declaredOperatorIds.has(spec.id)
  ) {
    throw new Error(
      "Undeclared canonical operator"
    );
  }

  if (Object.hasOwn(registry, spec.id)) {
    throw new Error(
      "Duplicate canonical operator"
    );
  }

  registry[spec.id] = spec;
}

export const OPERATOR_REGISTRY = deepFreeze(registry);

export const OPERATOR_COUNT =
  Object.keys(OPERATOR_REGISTRY).length;

// ==================================================
// 9. REGISTRY INVARIANTS
// ==================================================

/**
 * Checks both structural and version-1 semantic
 * invariants.
 *
 * Fail fast if a future change silently alters
 * established operator behavior.
 */
export function assertOperatorRegistry() {
  const declared = Object.values(OPERATORS);
  const registered = Object.keys(OPERATOR_REGISTRY);

  assertUniqueIdentifiers(declared, "operator");

  assertUniqueIdentifiers(
    Object.values(OPERATOR_VALUE_SHAPES),
    "operand shape"
  );

  if (declared.length !== registered.length) {
    throw new Error(
      "Canonical operator registry mismatch"
    );
  }

  const declaredSet = new Set(declared);

  for (const id of registered) {
    if (!declaredSet.has(id)) {
      throw new Error(
        "Unexpected canonical operator"
      );
    }
  }

  for (const id of declared) {
    if (!Object.hasOwn(OPERATOR_REGISTRY, id)) {
      throw new Error(
        "Missing canonical operator definition"
      );
    }

    const spec = OPERATOR_REGISTRY[id];

    if (!spec || spec.id !== id) {
      throw new Error(
        "Canonical operator identity mismatch"
      );
    }

    if (
      typeof spec.label !== "string" ||
      spec.label.length === 0 ||
      spec.label.length > 120 ||
      spec.label.trim() !== spec.label
    ) {
      throw new Error(
        "Invalid canonical operator label"
      );
    }

    if (!SHAPE_SET.has(spec.valueShape)) {
      throw new Error(
        "Invalid canonical operator value shape"
      );
    }

    if (!FAMILY_SET.has(spec.family)) {
      throw new Error(
        "Invalid canonical operator family"
      );
    }

    if (!NULL_POLICY_SET.has(spec.nullPolicy)) {
      throw new Error(
        "Invalid canonical operator null policy"
      );
    }

    if (
      spec.caseSensitive !== null &&
      typeof spec.caseSensitive !== "boolean"
    ) {
      throw new Error(
        "Invalid canonical operator case policy"
      );
    }

    if (
      !Array.isArray(spec.fieldTypes) ||
      spec.fieldTypes.length === 0 ||
      new Set(spec.fieldTypes).size !==
        spec.fieldTypes.length ||
      spec.fieldTypes.some((type) => !isFieldType(type))
    ) {
      throw new Error(
        "Invalid operator field compatibility"
      );
    }

    const isText = TEXT_OPERATOR_IDS.has(id);
    const isCollection =
      COLLECTION_OPERATOR_IDS.has(id);
    const isPresence =
      PRESENCE_OPERATOR_IDS.has(id);

    const expectedFamily = isText
      ? OPERATOR_FAMILIES.TEXT
      : isCollection
        ? OPERATOR_FAMILIES.COLLECTION
        : isPresence
          ? OPERATOR_FAMILIES.PRESENCE
          : OPERATOR_FAMILIES.COMPARISON;

    if (spec.family !== expectedFamily) {
      throw new Error(
        "Inconsistent operator family"
      );
    }

    // Text operations are currently case-insensitive.
    if (isText) {
      if (
        spec.caseSensitive !== false ||
        spec.valueShape !== S.SCALAR ||
        spec.fieldTypes.length !== 1 ||
        spec.fieldTypes[0] !== T.STRING
      ) {
        throw new Error(
          "Inconsistent text operator contract"
        );
      }
    } else if (spec.caseSensitive !== null) {
      throw new Error(
        "Unexpected case sensitivity contract"
      );
    }

    // All negative predicates continue to exclude
    // null/missing values.
    const expectedNullPolicy =
      NULL_INSPECTION_IDS.has(id)
        ? NULL_POLICIES.INSPECT
        : NULL_POLICIES.EXCLUDE;

    if (spec.nullPolicy !== expectedNullPolicy) {
      throw new Error(
        "Inconsistent operator null semantics"
      );
    }

    if (
      NEGATIVE_OPERATOR_IDS.has(id) &&
      spec.nullPolicy !== NULL_POLICIES.EXCLUDE
    ) {
      throw new Error(
        "Negative operator must exclude null"
      );
    }

    // Presence operators take no operand.
    if (isPresence) {
      if (spec.valueShape !== S.NONE) {
        throw new Error(
          "Presence operator must use NONE"
        );
      }
    } else if (spec.valueShape === S.NONE) {
      throw new Error(
        "Unexpected operand-free operator"
      );
    }

    if (
      SET_OPERATOR_IDS.has(id) &&
      spec.valueShape !== S.SET
    ) {
      throw new Error(
        "Invalid set operator shape"
      );
    }

    if (
      PAIR_OPERATOR_IDS.has(id) &&
      spec.valueShape !== S.PAIR
    ) {
      throw new Error(
        "Invalid pair operator shape"
      );
    }

    if (
      ELEMENT_OPERATOR_IDS.has(id) &&
      spec.valueShape !== S.ELEMENT
    ) {
      throw new Error(
        "Invalid collection operand shape"
      );
    }

    if (
      !isPresence &&
      !SET_OPERATOR_IDS.has(id) &&
      !PAIR_OPERATOR_IDS.has(id) &&
      !ELEMENT_OPERATOR_IDS.has(id) &&
      spec.valueShape !== S.SCALAR
    ) {
      throw new Error(
        "Invalid scalar operator shape"
      );
    }

    // Explicitly check collection compatibility.
    if (isCollection) {
      if (
        spec.fieldTypes.length !== LISTS.length ||
        LISTS.some(
          (type) => !spec.fieldTypes.includes(type)
        )
      ) {
        throw new Error(
          "Invalid collection operator types"
        );
      }
    }

    // Boolean types are intentionally limited
    // to equality, membership and null predicates.
    if (spec.fieldTypes.includes(T.BOOLEAN)) {
      const booleanOperators = new Set([
        OPERATORS.EQ,
        OPERATORS.NEQ,
        OPERATORS.IN,
        OPERATORS.NOT_IN,
        OPERATORS.IS_NULL,
        OPERATORS.IS_NOT_NULL,
      ]);

      if (!booleanOperators.has(id)) {
        throw new Error(
          "Unsupported boolean operator"
        );
      }
    }

    if (
      !Object.isFrozen(spec) ||
      !Object.isFrozen(spec.fieldTypes)
    ) {
      throw new Error(
        "Mutable operator definition"
      );
    }
  }

  return true;
}

assertOperatorRegistry();

// ==================================================
// 10. PRECOMPUTED TYPE INDEX
// ==================================================

const byType = Object.create(null);

for (const type of ALL_TYPES) {
  byType[type] = Object.freeze(
    Object.values(OPERATOR_REGISTRY).filter(
      (operator) =>
        operator.fieldTypes.includes(type)
    )
  );
}

const OPERATORS_BY_TYPE = deepFreeze(byType);

// ==================================================
// 11. LOOKUP FUNCTIONS
// ==================================================

export function isOperator(value) {
  return (
    typeof value === "string" &&
    Object.hasOwn(OPERATOR_REGISTRY, value)
  );
}

export function getOperator(operatorId) {
  return isOperator(operatorId)
    ? OPERATOR_REGISTRY[operatorId]
    : null;
}

export function requireOperator(operatorId) {
  const operator = getOperator(operatorId);

  if (!operator) {
    throw new FieldError(
      FIELD_ERROR_CODES.UNSUPPORTED_OPERATION,
      "Unknown canonical operator"
    );
  }

  return operator;
}

// ==================================================
// 12. TYPE COMPATIBILITY
// ==================================================

/**
 * Type compatibility alone never authorizes a
 * filter or mutation.
 */
export function isOperatorCompatible(
  operatorId,
  fieldType
) {
  if (!isFieldType(fieldType)) {
    return false;
  }

  const operator = getOperator(operatorId);

  return (
    operator !== null &&
    operator.fieldTypes.includes(fieldType)
  );
}

export function assertOperatorCompatible(
  operatorId,
  fieldType
) {
  const operator = requireOperator(operatorId);

  if (
    !isFieldType(fieldType) ||
    !operator.fieldTypes.includes(fieldType)
  ) {
    throw new FieldError(
      FIELD_ERROR_CODES.UNSUPPORTED_OPERATION,
      "Operator is incompatible with field type"
    );
  }

  return operator;
}

export function listOperatorsForType(fieldType) {
  if (!isFieldType(fieldType)) {
    throw new FieldError(
      FIELD_ERROR_CODES.INVALID_TYPE,
      "Unsupported canonical field type"
    );
  }

  return OPERATORS_BY_TYPE[fieldType];
}

// ==================================================
// 13. PRIMITIVE OPERAND VALIDATION
// ==================================================

/**
 * Single source of truth for operand primitives.
 *
 * Empty strings are structurally valid.
 * Whether they are semantically valid depends
 * on the operator and canonical field constraints.
 *
 * Decimal and money canonicalization is performed
 * by fields/normalize.js.
 */
function isValidOperandPrimitive(value) {
  if (typeof value === "string") {
    return value.length <= MAX_OPERATOR_STRING_LENGTH;
  }

  if (typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  return false;
}

/**
 * Validates a plain structured field reference operand:
 * { "kind": "field", "field": "<fieldId>" }
 *
 * Rejects extra keys, accessors, non-plain objects, or invalid field types.
 */
export function isStructuredFieldReference(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("field")) {
    return false;
  }
  return value.kind === "field" && typeof value.field === "string" && value.field.length > 0;
}

/**
 * Dense, ordinary arrays only.
 *
 * Requires:
 * - Standard Array prototype.
 * - Exactly length own indexed properties.
 * - One own "length" property.
 * - No extra keys or symbol properties.
 * - No indexed accessor descriptors.
 *
 * Not a defense against arbitrary JavaScript Proxies.
 */
function isValidOperandArray(value, min, max) {
  if (!Array.isArray(value)) {
    return false;
  }

  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }

  const length = value.length;

  if (
    !Number.isSafeInteger(length) ||
    length < min ||
    length > max
  ) {
    return false;
  }

  const keys = Reflect.ownKeys(value);

  if (keys.length !== length + 1) {
    return false;
  }

  // Reflect.ownKeys returns indexed keys first for
  // ordinary arrays, but explicitly check membership
  // to avoid relying solely on a key-count invariant.
  for (let i = 0; i < length; i++) {
    const expectedKey = String(i);

    if (keys[i] !== expectedKey) {
      return false;
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        value,
        expectedKey
      );

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !isValidOperandPrimitive(descriptor.value)
    ) {
      return false;
    }
  }

  return keys[length] === "length";
}

// ==================================================
// 14. PRIVATE OPERAND SHAPE VALIDATOR
// ==================================================

/**
 * Accepts a resolved definition to avoid repeated
 * registry lookups in the assert function.
 */
function validateOperandShape(
  operator,
  value,
  hasValue
) {
  if (typeof hasValue !== "boolean") {
    return false;
  }

  switch (operator.valueShape) {
    case S.NONE:
      return hasValue === false;

    case S.SCALAR:
    case S.ELEMENT:
      return (
        hasValue === true &&
        (isValidOperandPrimitive(value) || isStructuredFieldReference(value))
      );

    case S.PAIR:
      return (
        hasValue === true &&
        isValidOperandArray(value, 2, 2)
      );

    case S.SET:
      return (
        hasValue === true &&
        isValidOperandArray(
          value,
          1,
          MAX_OPERATOR_SET_SIZE
        )
      );

    default:
      return false;
  }
}

// ==================================================
// 15. PUBLIC OPERAND VALIDATION
// ==================================================

/**
 * Structural validation only.
 *
 * For NONE shapes, hasValue must be false.
 *
 * For all other shapes, hasValue must be true.
 *
 * Consumers must derive hasValue using:
 * Object.hasOwn(node, "value")
 *
 * Never derive hasValue from Boolean(node.value).
 */
export function isOperatorOperandShapeValid(
  operatorId,
  value,
  hasValue = true
) {
  const operator = getOperator(operatorId);

  return (
    operator !== null &&
    validateOperandShape(
      operator,
      value,
      hasValue
    )
  );
}

export function assertOperatorOperandShape(
  operatorId,
  value,
  hasValue = true
) {
  const operator = requireOperator(operatorId);

  if (
    !validateOperandShape(
      operator,
      value,
      hasValue
    )
  ) {
    throw new FieldError(
      FIELD_ERROR_CODES.INVALID_VALUE,
      "Invalid canonical operator operand"
    );
  }

  return operator;
}

// ==================================================
// 16. IMMUTABLE CONTRACT METADATA
// ==================================================

export const OPERATOR_REGISTRY_INFO = deepFreeze({
  contractVersion: OPERATOR_CONTRACT_VERSION,
  fieldTypeContractVersion:
    OPERATOR_FIELD_TYPE_VERSION,
  operatorCount: OPERATOR_COUNT,
  maxSetSize: MAX_OPERATOR_SET_SIZE,
  maxOperandStringLength:
    MAX_OPERATOR_STRING_LENGTH,
});
