import test from "node:test";
import assert from "node:assert/strict";

import {
  FIELD_TYPES as T,
  FIELD_ERROR_CODES,
} from "./types.js";

import {
  OPERATORS,
  OPERATOR_VALUE_SHAPES,
  OPERATOR_REGISTRY,
  OPERATOR_REGISTRY_INFO,
  OPERATOR_COUNT,
  MAX_OPERATOR_SET_SIZE,
  MAX_OPERATOR_STRING_LENGTH,
  assertOperatorRegistry,
  isOperator,
  getOperator,
  requireOperator,
  isOperatorCompatible,
  assertOperatorCompatible,
  listOperatorsForType,
  isOperatorOperandShapeValid,
  assertOperatorOperandShape,
} from "./operators.js";

// --------------------------------------------------
// 1. Registry completeness
// --------------------------------------------------

test("all 19 operators are registered", () => {
  assert.equal(OPERATOR_COUNT, 19);

  assert.equal(
    Object.keys(OPERATOR_REGISTRY).length,
    19
  );

  assert.equal(
    new Set(Object.values(OPERATORS)).size,
    19
  );
});

test("operator and shape identifiers are unique", () => {
  const operators = Object.values(OPERATORS);
  const shapes = Object.values(OPERATOR_VALUE_SHAPES);

  assert.equal(
    operators.length,
    new Set(operators).size
  );

  assert.equal(
    shapes.length,
    new Set(shapes).size
  );
});

test("registry initialization invariants hold", () => {
  assert.equal(assertOperatorRegistry(), true);
});

test("every operator has valid metadata", () => {
  const validShapes = new Set(
    Object.values(OPERATOR_VALUE_SHAPES)
  );

  for (const id of Object.values(OPERATORS)) {
    const spec = OPERATOR_REGISTRY[id];

    assert.ok(spec);
    assert.equal(spec.id, id);
    assert.ok(spec.label.length > 0);
    assert.ok(spec.label.length <= 120);
    assert.ok(validShapes.has(spec.valueShape));

    assert.ok(
      ["exclude", "inspect"].includes(
        spec.nullPolicy
      )
    );

    assert.ok(
      spec.caseSensitive === null ||
      typeof spec.caseSensitive === "boolean"
    );

    assert.ok(Object.isFrozen(spec));
    assert.ok(Object.isFrozen(spec.fieldTypes));
  }
});

test("registry is deeply immutable", () => {
  assert.ok(Object.isFrozen(OPERATOR_REGISTRY));

  for (const spec of Object.values(OPERATOR_REGISTRY)) {
    assert.ok(Object.isFrozen(spec));
    assert.ok(Object.isFrozen(spec.fieldTypes));
  }
});

// --------------------------------------------------
// 2. Lookups and compatibility
// --------------------------------------------------

test("operator lookups preserve identity", () => {
  const spec = getOperator(OPERATORS.EQ);

  assert.strictEqual(
    requireOperator(OPERATORS.EQ),
    spec
  );

  assert.equal(isOperator(OPERATORS.EQ), true);
  assert.equal(isOperator("__proto__"), false);
  assert.equal(getOperator("unknown"), null);
});

test("unknown operators fail closed", () => {
  assert.throws(
    () => requireOperator("invalid_operator"),
    (error) =>
      error.code ===
      FIELD_ERROR_CODES.UNSUPPORTED_OPERATION
  );

  assert.equal(
    isOperatorOperandShapeValid("invalid", "abc"),
    false
  );
});

test("all field types have consistent operator lists", () => {
  for (const type of Object.values(T)) {
    const list = listOperatorsForType(type);

    assert.ok(Array.isArray(list));
    assert.ok(Object.isFrozen(list));

    assert.strictEqual(
      listOperatorsForType(type),
      list
    );

    for (const operator of Object.values(OPERATOR_REGISTRY)) {
      assert.equal(
        list.includes(operator),
        isOperatorCompatible(operator.id, type)
      );
    }
  }
});

test("boolean supports only approved operators", () => {
  const approved = new Set([
    OPERATORS.EQ,
    OPERATORS.NEQ,
    OPERATORS.IN,
    OPERATORS.NOT_IN,
    OPERATORS.IS_NULL,
    OPERATORS.IS_NOT_NULL,
  ]);

  const actual = listOperatorsForType(T.BOOLEAN)
    .map((operator) => operator.id);

  assert.deepEqual(
    new Set(actual),
    approved
  );
});

test("JSON cannot use ordinary comparison operators", () => {
  assert.equal(
    isOperatorCompatible(OPERATORS.EQ, T.JSON),
    false
  );

  assert.equal(
    isOperatorCompatible(OPERATORS.IS_NULL, T.JSON),
    true
  );
});

test("ordered comparison rejects boolean types", () => {
  assert.equal(
    isOperatorCompatible(OPERATORS.GT, T.BOOLEAN),
    false
  );

  assert.equal(
    isOperatorCompatible(OPERATORS.BETWEEN, T.MONEY),
    true
  );

  assert.throws(
    () => assertOperatorCompatible(
      OPERATORS.BETWEEN,
      T.BOOLEAN
    ),
    (error) =>
      error.code ===
      FIELD_ERROR_CODES.UNSUPPORTED_OPERATION
  );
});

// --------------------------------------------------
// 3. Scalar operand limits
// --------------------------------------------------

test("accepts string exactly at length limit", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.EQ,
      "x".repeat(MAX_OPERATOR_STRING_LENGTH)
    ),
    true
  );
});

test("rejects strings exceeding length limit", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.EQ,
      "x".repeat(MAX_OPERATOR_STRING_LENGTH + 1)
    ),
    false
  );

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.LIST_CONTAINS,
      "x".repeat(MAX_OPERATOR_STRING_LENGTH + 1)
    ),
    false
  );
});

test("validates booleans structurally", () => {
  assert.equal(
    isOperatorOperandShapeValid(OPERATORS.EQ, false),
    true
  );

  assert.equal(
    isOperatorOperandShapeValid(OPERATORS.EQ, true),
    true
  );

  // Shape validation alone is intentionally not
  // field-specific Boolean validation.
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.EQ,
      "false"
    ),
    true
  );
});

test("rejects invalid primitive operands", () => {
  for (const value of [
    null,
    undefined,
    Infinity,
    -Infinity,
    NaN,
    10n,
    Symbol("x"),
    {},
    [],
  ]) {
    assert.equal(
      isOperatorOperandShapeValid(OPERATORS.EQ, value),
      false
    );
  }
});

// --------------------------------------------------
// 4. Pair and set structural validation
// --------------------------------------------------

test("accepts valid pair boundaries", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      ["1", "2"]
    ),
    true
  );
});

test("rejects wrong pair length", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      ["1"]
    ),
    false
  );

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      ["1", "2", "3"]
    ),
    false
  );
});

test("accepts maximum set size", () => {
  const values = Array(
    MAX_OPERATOR_SET_SIZE
  ).fill("value");

  assert.equal(
    isOperatorOperandShapeValid(OPERATORS.IN, values),
    true
  );
});

test("rejects empty and oversized sets", () => {
  assert.equal(
    isOperatorOperandShapeValid(OPERATORS.IN, []),
    false
  );

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IN,
      Array(MAX_OPERATOR_SET_SIZE + 1).fill("a")
    ),
    false
  );
});

test("rejects oversized strings inside sets", () => {
  const values = [
    "normal",
    "x".repeat(MAX_OPERATOR_STRING_LENGTH + 1),
  ];

  assert.equal(
    isOperatorOperandShapeValid(OPERATORS.IN, values),
    false
  );
});

test("rejects oversized strings inside pairs", () => {
  const values = [
    "x".repeat(MAX_OPERATOR_STRING_LENGTH + 1),
    "end",
  ];

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      values
    ),
    false
  );
});

test("rejects sparse arrays", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      new Array(2)
    ),
    false
  );
});

test("rejects arrays with extra properties", () => {
  const values = ["a", "b"];
  values.extra = "unexpected";

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      values
    ),
    false
  );
});

test("rejects symbol properties", () => {
  const values = ["a", "b"];
  values[Symbol("extra")] = 1;

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IN,
      values
    ),
    false
  );
});

test("rejects extra keys replacing expected indices", () => {
  const values = ["a", "b"];

  delete values[1];
  values.extra = "replacement";

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      values
    ),
    false
  );
});

test("does not invoke accessor properties", () => {
  const values = ["a", "b"];

  Object.defineProperty(values, "0", {
    configurable: true,
    get() {
      throw new Error("Getter executed");
    },
  });

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.BETWEEN,
      values
    ),
    false
  );
});

test("rejects nonstandard array prototypes", () => {
  const values = ["a", "b"];
  Object.setPrototypeOf(values, null);

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IN,
      values
    ),
    false
  );
});

// --------------------------------------------------
// 5. Presence and null semantics
// --------------------------------------------------

test("presence operators require absent value", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IS_NULL,
      undefined,
      false
    ),
    true
  );

  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IS_NULL,
      null,
      true
    ),
    false
  );
});

test("invalid hasValue flags fail closed", () => {
  assert.equal(
    isOperatorOperandShapeValid(
      OPERATORS.IS_NULL,
      undefined,
      "false"
    ),
    false
  );
});

test("negative predicates exclude null values", () => {
  for (const operatorId of [
    OPERATORS.NEQ,
    OPERATORS.NOT_IN,
    OPERATORS.NOT_CONTAINS,
    OPERATORS.LIST_NOT_CONTAINS,
  ]) {
    assert.equal(
      OPERATOR_REGISTRY[operatorId].nullPolicy,
      "exclude"
    );
  }
});

test("only explicit null checks inspect null", () => {
  const inspect = Object.values(OPERATOR_REGISTRY)
    .filter((operator) =>
      operator.nullPolicy === "inspect"
    )
    .map((operator) => operator.id);

  assert.deepEqual(
    new Set(inspect),
    new Set([
      OPERATORS.IS_NULL,
      OPERATORS.IS_NOT_NULL,
    ])
  );
});

test("empty and null checks remain distinct", () => {
  assert.equal(
    OPERATOR_REGISTRY.is_empty.valueShape,
    "none"
  );

  assert.equal(
    OPERATOR_REGISTRY.is_null.nullPolicy,
    "inspect"
  );

  assert.equal(
    OPERATOR_REGISTRY.is_empty.nullPolicy,
    "exclude"
  );
});

// --------------------------------------------------
// 6. Error and contract stability
// --------------------------------------------------

test("assert operand validation returns operator", () => {
  const spec = assertOperatorOperandShape(
    OPERATORS.EQ,
    "valid"
  );

  assert.strictEqual(
    spec,
    OPERATOR_REGISTRY.eq
  );
});

test("invalid operands produce safe errors", () => {
  assert.throws(
    () => assertOperatorOperandShape(
      OPERATORS.EQ,
      "x".repeat(MAX_OPERATOR_STRING_LENGTH + 1)
    ),
    (error) =>
      error.code === FIELD_ERROR_CODES.INVALID_VALUE &&
      error.toJSON().message === "Invalid field operation"
  );
});

test("contract metadata exposes limits", () => {
  assert.equal(
    OPERATOR_REGISTRY_INFO.contractVersion,
    1
  );

  assert.equal(
    OPERATOR_REGISTRY_INFO.operatorCount,
    19
  );

  assert.equal(
    OPERATOR_REGISTRY_INFO.maxSetSize,
    MAX_OPERATOR_SET_SIZE
  );

  assert.equal(
    OPERATOR_REGISTRY_INFO.maxOperandStringLength,
    MAX_OPERATOR_STRING_LENGTH
  );
});
