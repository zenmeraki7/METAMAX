import test from "node:test";
import assert from "node:assert/strict";

import { FIELD_ERROR_CODES, FieldError } from "./types.js";
import { requireCanonicalField } from "./canonical.js";
import { normalizeFieldValue, normalizeOperatorOperand, NORMALIZE_LIMITS } from "./normalize.js";

import {
  normalizeWriteValue,
  normalizeSupportedWrite,
  compareExactDecimals,
  validateVariantPriceState,
  WRITE_CONTEXT_RULES,
} from "./write-domain.js";

test("rejects negative variant price", () => {
  assert.throws(() =>
    normalizeWriteValue("variant.price", "-1")
  );
});

test("accepts zero variant price", () => {
  assert.equal(
    normalizeWriteValue("variant.price", "0"),
    "0"
  );
});

test("accepts positive variant price", () => {
  assert.equal(
    normalizeWriteValue("variant.price", "125.50"),
    "125.5"
  );
});

test("rejects negative compare-at price", () => {
  assert.throws(() =>
    normalizeWriteValue(
      "variant.compareAtPrice",
      "-0.01"
    )
  );
});

test("allows clearing compare-at price", () => {
  assert.equal(
    normalizeWriteValue(
      "variant.compareAtPrice",
      null
    ),
    null
  );
});

test("rejects null selling price", () => {
  assert.throws(() =>
    normalizeWriteValue("variant.price", null)
  );
});

test("rejects negative inventory cost", () => {
  assert.throws(() =>
    normalizeWriteValue(
      "inventoryItem.unitCost",
      "-10"
    )
  );
});

test("allows clearing inventory cost", () => {
  assert.equal(
    normalizeWriteValue(
      "inventoryItem.unitCost",
      null
    ),
    null
  );
});

test("rejects excess canonical decimal scale", () => {
  assert.throws(() =>
    normalizeWriteValue(
      "variant.price",
      "12.123456789"
    )
  );
});

test("rejects noncanonical numeric input", () => {
  assert.throws(() =>
    normalizeWriteValue("variant.price", -1)
  );
});

test("blocks writes to read-only fields", () => {
  assert.throws(() =>
    normalizeWriteValue("variant.id", "123")
  );
});

test("blocks unsupported adapter fields", () => {
  assert.throws(() =>
    normalizeSupportedWrite(
      "product.title",
      "New title",
      ["variant.price"]
    )
  );
});

test("compares decimals without floating point", () => {
  assert.equal(
    compareExactDecimals("0.10", "0.1"),
    0
  );

  assert.equal(
    compareExactDecimals("0.09", "0.1"),
    -1
  );

  assert.equal(
    compareExactDecimals("100.01", "100"),
    1
  );
});

test("rejects compare-at below price when policy enabled", () => {
  assert.throws(() =>
    validateVariantPriceState(
      {
        price: "100",
        compareAtPrice: "90",
      },
      {
        rule:
          WRITE_CONTEXT_RULES
            .COMPARE_AT_NOT_BELOW_PRICE,
      }
    )
  );
});

test("allows compare-at below price without optional policy", () => {
  assert.deepEqual(
    validateVariantPriceState({
      price: "100",
      compareAtPrice: "90",
    }),
    {
      price: "100",
      compareAtPrice: "90",
    }
  );
});

test("rejects missing final price state", () => {
  assert.throws(() =>
    validateVariantPriceState({
      compareAtPrice: "120",
    })
  );
});

test("monetary domain rejection returns the correct field error", () => {
  for (const fieldId of ["variant.price", "variant.compareAtPrice", "inventoryItem.unitCost"]) {
    assert.throws(() => normalizeWriteValue(fieldId, "-0.0001"), error =>
      error instanceof FieldError &&
      error.code === FIELD_ERROR_CODES.INVALID_VALUE &&
      error.fieldId === fieldId
    );
    assert.equal(normalizeWriteValue(fieldId, "-0.0000"), "0");
  }
});

test("shared normalization and filter operands still accept signed money", () => {
  const field = requireCanonicalField("variant.price");
  assert.equal(normalizeFieldValue(field, "-1.00"), "-1");
  assert.equal(normalizeOperatorOperand(field, "lt", "-1.00"), "-1");
});

test("write normalization enforces canonical precision boundaries", () => {
  assert.equal(normalizeWriteValue("variant.price", "9999999999999999.9999"), "9999999999999999.9999");
  assert.throws(() => normalizeWriteValue("variant.price", "10000000000000000"), {
    code: FIELD_ERROR_CODES.INVALID_VALUE,
  });
});

test("write normalization rejects forged descriptors and unknown IDs", () => {
  for (const fieldId of ["variant.fakeField", { id: "variant.price", type: "string", editable: true }]) {
    assert.throws(() => normalizeWriteValue(fieldId, "-1"), {
      code: FIELD_ERROR_CODES.UNKNOWN_FIELD,
    });
  }
});

test("caller constraints cannot bypass write rules", () => {
  assert.throws(() => normalizeWriteValue("variant.price", "-1", {
    allowNegative: true,
  }), { code: FIELD_ERROR_CODES.INVALID_VALUE });
});

test("supported writes enforce both the allowlist and canonical editability", () => {
  const supported = Object.freeze(["variant.price", "variant.compareAtPrice"]);
  assert.equal(normalizeSupportedWrite("variant.price", "12.50", supported), "12.5");
  assert.equal(normalizeSupportedWrite("variant.compareAtPrice", null, supported), null);
  assert.throws(() => normalizeSupportedWrite("product.title", "Title", supported), {
    code: FIELD_ERROR_CODES.UNSUPPORTED_OPERATION,
  });
  assert.throws(() => normalizeSupportedWrite("variant.id", "123", ["variant.id"]), {
    code: FIELD_ERROR_CODES.READ_ONLY,
  });
  for (const allowlist of [undefined, null, {}, "variant.price", [42]]) {
    assert.throws(() => normalizeSupportedWrite("variant.price", "1", allowlist), TypeError);
  }
});

test("exact comparison preserves large values and signed ordering", () => {
  for (const [left, right, expected] of [
    ["9999999999999999.9998", "9999999999999999.9999", -1],
    ["-2", "-1.9999", -1],
    ["-1", "0", -1],
    ["-0", "0", 0],
    ["1.0001", "1", 1],
  ]) {
    assert.equal(compareExactDecimals(left, right), expected);
  }
  for (const value of [1, null, "1e2", "01", "NaN", "1".repeat(NORMALIZE_LIMITS.maxDecimalLength + 1)]) {
    assert.throws(() => compareExactDecimals(value, "0"), TypeError);
    assert.throws(() => compareExactDecimals("0", value), TypeError);
  }
});

test("contextual pricing allows equal prices and cleared compare-at values", () => {
  for (const compareAtPrice of ["100.00", "120", null]) {
    const result = validateVariantPriceState({ price: "100", compareAtPrice }, {
      rule: WRITE_CONTEXT_RULES.COMPARE_AT_NOT_BELOW_PRICE,
    });
    assert.equal(result.price, "100");
    assert.ok(Object.isFrozen(result));
  }
});

test("contextual pricing rejects unknown rules and incomplete final state", () => {
  assert.throws(() => validateVariantPriceState({ price: "1", compareAtPrice: null }, {
    rule: "browser_defined_policy",
  }), TypeError);
  for (const state of [null, [], "invalid"]) {
    assert.throws(() => validateVariantPriceState(state), TypeError);
  }
  assert.throws(() => validateVariantPriceState({ price: "1" }), {
    code: FIELD_ERROR_CODES.INVALID_VALUE,
  });
});

test("write-domain uses shared field constraints for text, enums and list uniqueness", () => {
  assert.throws(() => normalizeWriteValue("product.title", ""), { code: FIELD_ERROR_CODES.INVALID_VALUE });
  assert.throws(() => normalizeWriteValue("product.vendor", "a".repeat(256)), { code: FIELD_ERROR_CODES.INVALID_VALUE });
  assert.equal(normalizeWriteValue("product.status", "ACTIVE"), "ACTIVE");
  assert.throws(() => normalizeWriteValue("product.status", "invalid"), { code: FIELD_ERROR_CODES.INVALID_VALUE });
  assert.throws(() => normalizeWriteValue("product.tags", ["a", "a"]), { code: FIELD_ERROR_CODES.INVALID_VALUE });
});

test("write-domain validates actual operation and final value using the shared registry", () => {
  assert.equal(normalizeWriteValue("variant.price", "10", { operation: "decrease" }), "10");
  assert.throws(() => normalizeWriteValue("variant.price", "-10", { operation: "decrease" }), { code: FIELD_ERROR_CODES.INVALID_VALUE });
  assert.equal(normalizeWriteValue("variant.compareAtPrice", null, { operation: "clear" }), null);
  assert.throws(() => normalizeWriteValue("variant.price", null, { operation: "clear" }), { code: FIELD_ERROR_CODES.UNSUPPORTED_OPERATION });
  assert.throws(() => normalizeWriteValue("product.title", "new", { operation: "append" }), { code: FIELD_ERROR_CODES.UNSUPPORTED_OPERATION });
  assert.throws(() => normalizeSupportedWrite("product.tags", ["a"], ["product.tags"], "clear"), { code: FIELD_ERROR_CODES.INVALID_VALUE });
});
