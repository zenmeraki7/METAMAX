import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_TYPES as T, getFieldType, requireFieldType, listFieldTypes,
  isComparableType, isSearchableType, isSortableType,
} from "../../fields/types.js";
import { normalizeValue, normalizeFieldValue, FieldNormalizationError } from "../../fields/normalize.js";
import { validateFieldValue, requireValidFieldValue, validateFieldValues } from "../../fields/validate.js";

test("type metadata is immutable, own-property safe and covers existing representations", () => {
  assert.equal(listFieldTypes().length, 11);
  assert.equal(getFieldType("constructor"), null);
  assert.equal(getFieldType({ toString() { throw new Error("executed"); } }), null);
  assert.throws(() => requireFieldType("__proto__"), TypeError);
  assert.equal(isComparableType(T.DECIMAL), true);
  assert.equal(isSearchableType(T.TEXT_ARRAY), true);
  assert.equal(isSortableType(T.ENUM), false);
  assert.equal(isSortableType(T.BOOLEAN), false);
  assert.equal(isSortableType("unknown"), false);
  assert.equal(getFieldType(T.INTEGER).storage, "safe_integer");
  assert.throws(() => listFieldTypes().push({}), TypeError);
  assert.throws(() => { getFieldType(T.TEXT).kind = "other"; }, TypeError);
});

test("decimal representation is signed and exact without accepting floating point coercion", () => {
  for (const [input, expected] of [["-0010.500", "-10.5"], ["+0019.9900", "19.99"],
    ["-0.000", "0"], [42, "42"], [-42, "-42"], [-0, "0"],
    ["9007199254740993.000000000000000001", "9007199254740993.000000000000000001"]]) {
    assert.equal(normalizeValue(T.DECIMAL, input), expected);
  }
  for (const input of [0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1e2", ".5", "1.", "$1", "1,000", true, {}])
    assert.throws(() => normalizeValue(T.DECIMAL, input), FieldNormalizationError);
  assert.throws(() => normalizeValue(T.DECIMAL, "0".repeat(257)), FieldNormalizationError);
});

test("integer conversion checks BigInt bounds before Number and leaves field bounds to validation", () => {
  assert.equal(normalizeValue(T.INTEGER, String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeValue(T.INTEGER, String(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
  assert.equal(normalizeValue(T.INTEGER, "+2147483648"), 2147483648);
  assert.equal(normalizeValue(T.INTEGER, "-0"), 0);
  for (const input of ["9007199254740992", "-9007199254740992", "1e2", "1.0", 1.5, true])
    assert.throws(() => normalizeValue(T.INTEGER, input), FieldNormalizationError);
  assert.equal(validateFieldValue("product.totalInventory", 2147483648, { purpose: "read" }).code, "ABOVE_MAXIMUM");
  assert.equal(validateFieldValue("variant.position", "-1", { purpose: "read" }).code, "BELOW_MINIMUM");
});

test("generic text preserves whitespace and normalizes NFC without applying field policy", () => {
  assert.equal(normalizeValue(T.TEXT, " e\u0301 "), " é ");
  assert.equal(normalizeValue(T.ENUM, " active "), "active");
  assert.deepEqual(normalizeValue(T.TEXT_ARRAY, [" e\u0301 ", " e\u0301 "]), [" é ", " é "]);
  assert.equal(normalizeFieldValue("product.title", "  Summer  "), "Summer");
  assert.equal(normalizeFieldValue("product.status", " unlisted "), "UNLISTED");
  assert.equal(normalizeFieldValue("product.status", " deleted "), "DELETED");
  assert.deepEqual(normalizeFieldValue("product.tags", [" Sale ", "Sale"]), ["Sale", "Sale"]);
  assert.equal(validateFieldValue("product.tags", [" Sale ", "Sale"]).code, "DUPLICATE_TAG");
  assert.throws(() => normalizeValue(T.TEXT_ARRAY, "Summer,Sale"), FieldNormalizationError);
});

test("field validation distinguishes missing, null, capability and field constraints", () => {
  assert.equal(normalizeValue(T.DECIMAL, null), null);
  assert.equal(normalizeFieldValue("variant.price", "-25"), "-25");
  assert.equal(validateFieldValue("variant.price", "-25").code, "BELOW_MINIMUM");
  assert.equal(validateFieldValue("variant.price", "-0." + "0".repeat(100) + "1").code, "BELOW_MINIMUM");
  assert.equal(validateFieldValue("variant.price", null).code, "NULL_NOT_ALLOWED");
  assert.equal(validateFieldValue("variant.price", undefined).code, "MISSING_VALUE");
  assert.equal(requireValidFieldValue("variant.compare_at_price", null), null);
  assert.equal(validateFieldValue("product.status", "DELETED").code, "INVALID_ENUM");
  assert.equal(validateFieldValue("product.status", "UNLISTED").valid, true);
  assert.equal(validateFieldValue("product.totalInventory", 1).code, "NOT_SUPPORTED");
  assert.equal(validateFieldValue("product.totalInventory", 1, { purpose: "read" }).valid, true);
  assert.equal(validateFieldValue("inventoryItem.tracked", true).valid, false);
  assert.equal(validateFieldValue("unknown", "x").code, "UNKNOWN_FIELD");
  assert.equal(validateFieldValue("product.title", "x", { purpose: null }).code, "INVALID_PURPOSE");
  assert.equal(validateFieldValue("product.title", "x", { purpose: "constructor" }).code, "INVALID_PURPOSE");
  assert.throws(() => requireValidFieldValue("variant.price", "-1"), { name: "FieldValidationError", code: "BELOW_MINIMUM", field: "variant.price" });
});

test("batch validation reports mixed results without invoking getters or accepting sparse inputs", () => {
  const result = validateFieldValues([{ field: "variant.price", value: "0019.9900" },
    { field: "product.title", value: "" }, { field: "variant.compare_at_price", value: null }]);
  assert.equal(result.valid, false);
  assert.equal(result.results[0].value, "19.99");
  assert.equal(result.results[2].field, "variant.compareAtPrice");
  assert.equal(result.errors.length, 1);
  assert.equal(Object.isFrozen(result.results), true);
  assert.equal(validateFieldValues([]).valid, true);
  let invoked = false;
  const entry = { get field() { invoked = true; return "product.title"; }, value: "x" };
  assert.throws(() => validateFieldValues([entry]), { code: "INVALID_FIELD_INPUT" });
  assert.equal(invoked, false);
  assert.throws(() => validateFieldValues(new Array(1)), { code: "INVALID_FIELD_INPUT" });
  assert.throws(() => validateFieldValues(new Array(1001)), TypeError);
  assert.throws(() => validateFieldValues([{ field: "product.title", value: "x", extra: true }]), { code: "INVALID_FIELD_INPUT" });
});
