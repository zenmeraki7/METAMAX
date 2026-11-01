import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_FIELDS,
  requireCanonicalField,
} from "./canonical.js";
import { normalizeCanonicalInput } from "./canonical-input.js";

import {
  FIELD_ERROR_CODES,
  FieldError,
} from "./types.js";

import {
  NORMALIZE_CONTRACT_VERSION,
  NORMALIZE_LIMITS,
  normalizeFieldValue,
  normalizeOperatorOperand,
} from "./normalize.js";

const fields = {
  title: {
    id: "product.title",
    type: "string",
    nullable: false,
  },

  vendor: {
    id: "product.vendor",
    type: "string",
    nullable: true,
  },

  taxable: {
    id: "variant.taxable",
    type: "boolean",
    nullable: false,
  },

  quantity: {
    id: "variant.inventoryQuantity",
    type: "integer",
    nullable: false,
  },

  price: {
    id: "variant.price",
    type: "money",
    nullable: false,
    precision: 20,
    scale: 4,
  },

  fraction: {
    id: "variant.testDecimal",
    type: "decimal",
    nullable: false,
    precision: 2,
    scale: 2,
  },

  status: {
    id: "product.status",
    type: "enum",
    nullable: false,
  },

  createdAt: {
    id: "product.createdAt",
    type: "datetime",
    nullable: false,
  },

  date: {
    id: "product.testDate",
    type: "date",
    nullable: false,
  },

  tags: {
    id: "product.tags",
    type: "string_list",
    nullable: false,
  },

  collections: {
    id: "product.collectionIds",
    type: "id_list",
    nullable: false,
  },
};

const statusOptions = {
  constraints: {
    enumValues: [
      "ACTIVE",
      "DRAFT",
      "ARCHIVED",
    ],
  },
};

function expectInvalid(callback) {
  assert.throws(
    callback,
    (error) =>
      error instanceof FieldError &&
      error.code === FIELD_ERROR_CODES.INVALID_VALUE &&
      error.toJSON().message ===
        "Invalid field operation"
  );
}

// --------------------------------------------------
// 1. Boolean
// --------------------------------------------------

test("accepts only canonical booleans", () => {
  assert.equal(
    normalizeFieldValue(fields.taxable, true),
    true
  );

  assert.equal(
    normalizeFieldValue(fields.taxable, false),
    false
  );

  for (const value of [
    "true",
    "false",
    0,
    1,
    "",
    null,
  ]) {
    expectInvalid(() =>
      normalizeFieldValue(fields.taxable, value)
    );
  }
});

test("operator operands enforce Boolean types", () => {
  assert.equal(
    normalizeOperatorOperand(
      fields.taxable,
      "eq",
      false
    ),
    false
  );

  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.taxable,
      "eq",
      "false"
    )
  );
});

// --------------------------------------------------
// 2. Integer
// --------------------------------------------------

test("integer validation requires safe integers", () => {
  assert.equal(
    normalizeFieldValue(fields.quantity, 42),
    42
  );

  assert.equal(
    normalizeFieldValue(fields.quantity, -0),
    0
  );

  for (const value of [
    "42",
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expectInvalid(() =>
      normalizeFieldValue(fields.quantity, value)
    );
  }
});

test("integer constraints can prohibit negatives", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.quantity,
      -1,
      {
        constraints: {
          allowNegative: false,
        },
      }
    )
  );
});

// --------------------------------------------------
// 3. Decimal and money
// --------------------------------------------------

test("money normalization preserves exact values", () => {
  assert.equal(
    normalizeFieldValue(fields.price, "12.3400"),
    "12.34"
  );

  assert.equal(
    normalizeFieldValue(fields.price, "-0.0000"),
    "0"
  );

  assert.equal(
    normalizeFieldValue(fields.price, "0.0100"),
    "0.01"
  );
});

test("floating-point money inputs are rejected", () => {
  expectInvalid(() =>
    normalizeFieldValue(fields.price, 12.34)
  );
});

test("DECIMAL(p,p) supports fractional values", () => {
  assert.equal(
    normalizeFieldValue(fields.fraction, "0.12"),
    "0.12"
  );

  expectInvalid(() =>
    normalizeFieldValue(fields.fraction, "1.12")
  );
});

test("decimal input length is bounded", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.price,
      "1".repeat(
        NORMALIZE_LIMITS.maxDecimalLength + 1
      )
    )
  );
});

test("decimal BETWEEN compares exactly", () => {
  const values = normalizeOperatorOperand(
    fields.price,
    "between",
    ["0.10", "0.20"]
  );

  assert.deepEqual(values, ["0.1", "0.2"]);
  assert.ok(Object.isFrozen(values));

  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.price,
      "between",
      ["0.20", "0.10"]
    )
  );

  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.price,
      "between",
      ["0.10"]
    )
  );

  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.price,
      "between",
      []
    )
  );
});

// --------------------------------------------------
// 4. Enum
// --------------------------------------------------

test("enums require trusted allowed values", () => {
  assert.equal(
    normalizeFieldValue(
      fields.status,
      "ACTIVE",
      statusOptions
    ),
    "ACTIVE"
  );

  expectInvalid(() =>
    normalizeFieldValue(
      fields.status,
      "active",
      statusOptions
    )
  );
});

test("missing enum definitions fail closed", () => {
  assert.throws(
    () => normalizeFieldValue(
      fields.status,
      "ACTIVE"
    ),
    TypeError
  );
});

test("duplicate enum values are rejected", () => {
  assert.throws(
    () => normalizeFieldValue(
      fields.status,
      "ACTIVE",
      {
        constraints: {
          enumValues: [
            "ACTIVE",
            "ACTIVE",
          ],
        },
      }
    ),
    TypeError
  );
});

// --------------------------------------------------
// 5. Null and empty values
// --------------------------------------------------

test("nullable field accepts null", () => {
  assert.equal(
    normalizeFieldValue(fields.vendor, null),
    null
  );
});

test("non-nullable field rejects null", () => {
  expectInvalid(() =>
    normalizeFieldValue(fields.title, null)
  );
});

test("missing is distinct from null", () => {
  expectInvalid(() =>
    normalizeFieldValue(fields.vendor, undefined)
  );
});

test("empty string is not automatically null", () => {
  assert.equal(
    normalizeFieldValue(fields.vendor, ""),
    ""
  );
});

test("allowEmpty can reject empty strings", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.title,
      "",
      {
        constraints: {
          allowEmpty: false,
        },
      }
    )
  );
});

// --------------------------------------------------
// 6. Dates and timestamps
// --------------------------------------------------

test("valid dates are accepted", () => {
  assert.equal(
    normalizeFieldValue(
      fields.date,
      "2024-02-29"
    ),
    "2024-02-29"
  );
});

test("invalid dates are rejected", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.date,
      "2025-02-29"
    )
  );
});

test("UTC timestamps retain canonical format", () => {
  assert.equal(
    normalizeFieldValue(
      fields.createdAt,
      "2026-10-27T12:30:00.000Z"
    ),
    "2026-10-27T12:30:00.000Z"
  );
});

test("timezone offsets normalize to UTC", () => {
  assert.equal(
    normalizeFieldValue(
      fields.createdAt,
      "2026-10-27T18:00:00+05:30"
    ),
    "2026-10-27T12:30:00.000Z"
  );
});

test("fractional seconds are normalized", () => {
  assert.equal(
    normalizeFieldValue(
      fields.createdAt,
      "2026-10-27T12:30:00.5Z"
    ),
    "2026-10-27T12:30:00.500Z"
  );
});

test("invalid timezone offsets are rejected", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.createdAt,
      "2026-10-27T12:30:00+14:30"
    )
  );
});

// --------------------------------------------------
// 7. Lists
// --------------------------------------------------

test("string lists are normalized and frozen", () => {
  const result = normalizeFieldValue(
    fields.tags,
    ["Summer", "Winter"]
  );

  assert.deepEqual(
    result,
    ["Summer", "Winter"]
  );

  assert.ok(Object.isFrozen(result));
});

test("allowEmpty rejects empty string and ID lists", () => {
  for (const field of [fields.tags, fields.collections]) {
    expectInvalid(() =>
      normalizeFieldValue(field, [], {
        constraints: { allowEmpty: false },
      })
    );
  }
});

test("allowEmpty permits empty lists when enabled or omitted", () => {
  for (const field of [fields.tags, fields.collections]) {
    for (const options of [{}, { constraints: { allowEmpty: true } }]) {
      const result = normalizeFieldValue(field, [], options);
      assert.deepEqual(result, []);
      assert.ok(Object.isFrozen(result));
    }
  }
});

test("rejects an empty canonical list when allowEmpty is false", () => {
  expectInvalid(() =>
    normalizeFieldValue(CANONICAL_FIELDS["product.tags"], [], {
      constraints: { allowEmpty: false },
    })
  );
});

test("allows an empty canonical list when explicitly permitted", () => {
  const result = normalizeFieldValue(CANONICAL_FIELDS["product.tags"], [], {
    constraints: { allowEmpty: true },
  });
  assert.deepEqual(result, []);
  assert.ok(Object.isFrozen(result));
});

test("sparse lists are rejected", () => {
  const values = new Array(2);

  expectInvalid(() =>
    normalizeFieldValue(fields.tags, values)
  );
});

test("extra array properties are rejected", () => {
  const values = ["Summer"];
  values.extra = "unexpected";

  expectInvalid(() =>
    normalizeFieldValue(fields.tags, values)
  );
});

test("array accessors are rejected", () => {
  const values = ["Summer"];

  Object.defineProperty(values, "0", {
    get() {
      throw new Error("Should not execute");
    },
  });

  expectInvalid(() =>
    normalizeFieldValue(fields.tags, values)
  );
});

test("list limits are enforced", () => {
  expectInvalid(() =>
    normalizeFieldValue(
      fields.tags,
      Array(101).fill("tag")
    )
  );
});

// --------------------------------------------------
// 8. Operator operands
// --------------------------------------------------

test("scalar operators normalize operands", () => {
  assert.equal(
    normalizeOperatorOperand(
      fields.price,
      "eq",
      "12.3400"
    ),
    "12.34"
  );
});

test("set operands normalize independently", () => {
  const result = normalizeOperatorOperand(
    fields.price,
    "in",
    ["1.00", "2.5000"]
  );

  assert.deepEqual(
    result,
    ["1", "2.5"]
  );

  assert.ok(Object.isFrozen(result));
});

test("presence operators require no operand", () => {
  assert.equal(
    normalizeOperatorOperand(
      fields.vendor,
      "is_null",
      undefined,
      { hasValue: false }
    ),
    undefined
  );

  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.vendor,
      "is_null",
      null,
      { hasValue: true }
    )
  );
});

test("operator strings obey length bounds", () => {
  expectInvalid(() =>
    normalizeOperatorOperand(
      fields.title,
      "contains",
      "x".repeat(4097)
    )
  );
});

// --------------------------------------------------
// 9. Contract integrity
// --------------------------------------------------

test("contract version remains stable", () => {
  assert.equal(NORMALIZE_CONTRACT_VERSION, 2);
});

test("rejects invented canonical field IDs", () => {
  assert.throws(() => requireCanonicalField("product.fakeField"));
  assert.throws(() => normalizeCanonicalInput("product.fakeField", "Test"));
});

test("canonical resolution ignores caller capabilities", () => {
  const supplied = {
    id: "product.tags",
    type: "boolean",
    nullable: true,
    editable: true,
  };
  const trusted = requireCanonicalField(supplied.id);
  assert.strictEqual(trusted, CANONICAL_FIELDS["product.tags"]);
  assert.notEqual(trusted.type, supplied.type);
});

test("canonical input rejects descriptors and uses the registered type", () => {
  const supplied = { id: "product.tags", type: "boolean", nullable: true };
  assert.throws(() => normalizeCanonicalInput(supplied, true));
  expectInvalid(() => normalizeCanonicalInput(supplied.id, true));
  const result = normalizeCanonicalInput(supplied.id, ["Summer"]);
  assert.deepEqual(result, ["Summer"]);
  assert.ok(Object.isFrozen(result));
});

test("canonical input applies trusted server-side constraints", () => {
  expectInvalid(() => normalizeCanonicalInput("product.tags", [], {
    allowEmpty: false,
  }));
  assert.deepEqual(normalizeCanonicalInput("product.tags", [], {
    allowEmpty: true,
  }), []);
});

test("invalid field descriptors are rejected", () => {
  assert.throws(
    () => normalizeFieldValue(
      {
        id: "product.title",
        type: "unknown",
        nullable: false,
      },
      "Test"
    ),
    TypeError
  );
});

test("unknown constraint properties are rejected", () => {
  assert.throws(
    () => normalizeFieldValue(
      fields.title,
      "Test",
      {
        constraints: {
          unsafe: true,
        },
      }
    ),
    TypeError
  );
});

test("decimal operators preserve exact strings for scalar, set and pair shapes", () => {
  const price = CANONICAL_FIELDS["variant.price"];
  for (const [operator, value, expected] of [
    ["eq", "12.5000", "12.5"],
    ["in", ["12.5000", "20.00"], ["12.5", "20"]],
    ["between", ["12.5000", "20.00"], ["12.5", "20"]],
  ]) {
    const normalized = normalizeOperatorOperand(price, operator, value);
    assert.deepEqual(normalized, expected);
    assert.ok((Array.isArray(normalized) ? normalized : [normalized]).every(item => typeof item === "string"));
  }
  for (const [operator, value] of [["eq", ["12.5"]], ["in", "12.5"], ["between", ["12.5"]],
    ["eq", 12.5], ["in", [12.5]], ["between", ["12.5", 20]], ["list_contains", "12.5"]]) {
    assert.throws(() => normalizeOperatorOperand(price, operator, value));
  }
  assert.equal(normalizeOperatorOperand(price, "is_null", undefined, { hasValue: false }), undefined);
});

test("Phase 1: same-row structured field operands normalize and validate strictly", () => {
  const price = CANONICAL_FIELDS["variant.price"];
  const title = CANONICAL_FIELDS["product.title"];
  const productId = CANONICAL_FIELDS["product.id"];

  // Approved comparisons
  for (const op of ["lt", "eq", "gt"]) {
    const operand = { kind: "field", field: "variant.compareAtPrice" };
    const result = normalizeOperatorOperand(price, op, operand);
    assert.deepEqual(result, { kind: "field", field: "variant.compareAtPrice" });
    assert.ok(Object.isFrozen(result));
  }

  // Malformed field operands
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "field", field: "variant.compareAtPrice", extra: true }));
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "not_a_field", field: "variant.compareAtPrice" }));
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "field", field: 123 }));
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "field" }));
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { field: "variant.compareAtPrice" }));

  // Unapproved field-to-field comparisons
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "field", field: "variant.sku" }));
  expectInvalid(() => normalizeOperatorOperand(price, "lt", { kind: "field", field: "product.title" }));
  expectInvalid(() => normalizeOperatorOperand(title, "eq", { kind: "field", field: "variant.compareAtPrice" }));
  assert.throws(() => normalizeOperatorOperand(price, "contains", { kind: "field", field: "variant.compareAtPrice" }), { code: FIELD_ERROR_CODES.UNSUPPORTED_OPERATION });
  expectInvalid(() => normalizeOperatorOperand(price, "between", { kind: "field", field: "variant.compareAtPrice" }));

  // Empty set for in operator is strictly rejected
  expectInvalid(() => normalizeOperatorOperand(productId, "in", []));
  expectInvalid(() => normalizeOperatorOperand(price, "in", []));
});

