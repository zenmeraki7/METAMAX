import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetafieldRegistry, validateFieldValue, normalizeFieldValue,
  checkMetafieldAccess, checkFieldAvailability } from "../../fields/index.js";
const shopId = "example.myshopify.com", read = { purpose: "read" };
const rule = (name, value) => ({ name, value });
function field(options = {}) {
  return createMetafieldRegistry(shopId, [{ owner: "product", namespace: "custom", key: "value",
    type: "single_line_text_field", definitionVersion: "definition-1", validations: [],
    access: { admin: "PUBLIC_READ_WRITE", storefront: "NONE", customerAccount: "NONE" }, ...options,
  }]).list()[0];
}
const context = { authorized: true, shopId, scopes: ["read_products"], appId: "123" };
const value = (descriptor, input) => validateFieldValue(descriptor, input, read);

test("definition types and owners are checked and value validation requires the full validations projection", () => {
  assert.throws(() => field({ ownerType: "PRODUCTVARIANT" }), { code: "INVALID_METAFIELD_DEFINITION" });
  assert.throws(() => field({ owner: "customer" }), { code: "UNSUPPORTED_OWNER" });
  assert.throws(() => field({ type: "json" }), { code: "UNSUPPORTED_METAFIELD_TYPE" });
  const missing = field({ validations: undefined });
  assert.equal(normalizeFieldValue(missing, "raw"), "raw");
  assert.equal(value(missing, "raw").code, "METAFIELD_VALIDATIONS_REQUIRED");
  assert.equal(value(field(), "raw").valid, true);
  assert.equal(value(field(), null).valid, true);
});

test("Shopify decimal range, precision and definition numeric limits are exact", () => {
  const decimal = field({ type: "number_decimal" });
  for (const input of ["9999999999999.999999999", "-9999999999999.999999999", "-10.5"])
    assert.equal(value(decimal, input).valid, true);
  assert.equal(value(decimal, "10000000000000").code, "ABOVE_MAXIMUM");
  assert.equal(value(decimal, "-10000000000000").code, "BELOW_MINIMUM");
  assert.equal(value(decimal, "0.0000000001").code, "MAX_PRECISION_EXCEEDED");
  const limited = field({ type: "number_decimal", validations: [rule("min", "-0.01"), rule("max", "1.99"), rule("max_precision", "2")] });
  assert.equal(value(limited, "-0.0100").value, "-0.01");
  assert.equal(value(limited, "-0.010000001").code, "BELOW_MINIMUM");
  assert.equal(value(limited, "1.990000001").code, "ABOVE_MAXIMUM");
  assert.equal(value(limited, "1.001").code, "MAX_PRECISION_EXCEEDED");
  const integer = field({ type: "number_integer", validations: [rule("min", "-2"), rule("max", "+10")] });
  assert.equal(value(integer, "-2").valid, true);
  assert.equal(value(integer, "11").code, "ABOVE_MAXIMUM");
});

test("text/list definition rules enforce lengths, choices, newlines, bytes and item limits", () => {
  const text = field({ validations: [rule("min", "2"), rule("max", "4"), rule("choices", '["Blue","Red"]')] });
  for (const [input, code] of [["R", "BELOW_MINIMUM_LENGTH"], ["Green", "ABOVE_MAXIMUM_LENGTH"], ["Pink", "INVALID_CHOICE"]])
    assert.equal(value(text, input).code, code);
  assert.equal(value(text, "Blue").valid, true);
  assert.equal(value(field(), "a\nb").code, "INVALID_SINGLE_LINE_TEXT");
  assert.equal(value(field({ type: "multi_line_text_field" }), "a\nb").valid, true);
  assert.equal(value(field(), "\u{1f600}".repeat(20000)).code, "METAFIELD_SIZE_LIMIT");
  const list = field({ type: "list.single_line_text_field", validations: [rule("list.min", "1"), rule("list.max", "2"), rule("choices", '["Red","Blue"]')] });
  assert.equal(value(list, ["Red", "Blue"]).valid, true);
  assert.equal(value(list, []).code, "BELOW_MINIMUM_ITEMS");
  assert.equal(value(list, ["Red", "Red", "Red"]).code, "ABOVE_MAXIMUM_ITEMS");
  assert.equal(value(list, ["Green"]).code, "INVALID_CHOICE");
  assert.equal(value(list, ["Red\n"]).code, "INVALID_SINGLE_LINE_TEXT");
  const unrestricted = field({ type: "list.single_line_text_field" });
  assert.equal(value(unrestricted, Array(128).fill("x")).valid, true);
  assert.equal(value(unrestricted, Array(129).fill("x")).code, "ABOVE_MAXIMUM_ITEMS");
  assert.equal(value(unrestricted, Array(128).fill("x".repeat(600))).code, "METAFIELD_SIZE_LIMIT");
});

test("unsupported, incompatible, duplicate and malformed rules are rejected without invoking accessors", () => {
  for (const [type, validations, code] of [
    ["single_line_text_field", [rule("regex", "(a+)+$")], "UNSUPPORTED_METAFIELD_VALIDATION"],
    ["boolean", [rule("min", "1")], "UNSUPPORTED_METAFIELD_VALIDATION"],
    ["single_line_text_field", [rule("choices", "bad JSON")], "INVALID_METAFIELD_DEFINITION"],
    ["number_decimal", [rule("max_precision", "10")], "INVALID_METAFIELD_DEFINITION"],
    ["number_integer", [rule("min", "1.1")], "INVALID_METAFIELD_DEFINITION"],
    ["number_integer", [rule("max", "9007199254740992")], "INVALID_METAFIELD_DEFINITION"],
    ["number_decimal", [rule("max", "10000000000000")], "INVALID_METAFIELD_DEFINITION"],
    ["number_decimal", [rule("min", "0.0000000001")], "INVALID_METAFIELD_DEFINITION"],
    ["number_decimal", [rule("min", "0.010000001"), rule("max", "0.01")], "INVALID_METAFIELD_DEFINITION"],
    ["list.single_line_text_field", [rule("list.max", "129")], "INVALID_METAFIELD_DEFINITION"],
    ["single_line_text_field", [rule("min", "5"), rule("max", "2")], "INVALID_METAFIELD_DEFINITION"],
    ["single_line_text_field", [rule("min", "1"), rule("min", "2")], "INVALID_METAFIELD_DEFINITION"],
  ]) assert.throws(() => field({ type, validations }), { code });
  let invoked = false;
  assert.throws(() => field({ validations: [{ get name() { invoked = true; return "min"; }, value: "1" }] }), { code: "INVALID_FIELD_INPUT" });
  assert.throws(() => field({ access: { get admin() { invoked = true; return "PUBLIC_READ_WRITE"; } } }), { code: "INVALID_FIELD_INPUT" });
  assert.equal(invoked, false);
  const rules = [rule("min", "2")], access = { admin: "PUBLIC_READ_WRITE" };
  const frozen = field({ validations: rules, access });
  rules[0].value = "100"; access.admin = "PRIVATE";
  assert.equal(value(frozen, "OK").valid, true);
  assert.equal(checkMetafieldAccess(frozen, "read", context).allowed, true);
  assert.equal(Object.isFrozen(frozen.metafieldContract.validations[0]), true);
});

test("both supported owners require product scopes plus installation authorization and tenant identity", () => {
  for (const owner of ["product", "variant"]) {
    const descriptor = field({ owner, ownerType: owner === "product" ? "PRODUCT" : "PRODUCTVARIANT" });
    assert.deepEqual(descriptor.readScopes, ["read_products"]);
    assert.deepEqual(descriptor.writeScopes, ["write_products"]);
    assert.equal(checkMetafieldAccess(descriptor, "read", context).allowed, true);
    assert.equal(checkMetafieldAccess(descriptor, "write", context).reason, "OWNER_SCOPE_MISSING");
    assert.equal(checkMetafieldAccess(descriptor, "read", { ...context, scopes: ["read_inventory"] }).reason, "OWNER_SCOPE_MISSING");
    assert.equal(checkMetafieldAccess(descriptor, "write", { ...context, scopes: ["write_products"] }).allowed, true);
    assert.equal(checkMetafieldAccess(descriptor, "read", { ...context, authorized: false }).reason, "NOT_AUTHORIZED");
    assert.equal(checkMetafieldAccess(descriptor, "read", { ...context, shopId: "other.myshopify.com" }).reason, "SHOP_MISMATCH");
    assert.equal(checkFieldAvailability(descriptor.id, "edit", context).available, false);
    assert.equal(validateFieldValue(descriptor, "valid").code, "NOT_SUPPORTED");
  }
});

test("Admin restrictions and app namespaces cannot be bypassed through storefront flags or scopes", () => {
  const publicRead = field({ access: { admin: "PUBLIC_READ", storefront: "PUBLIC_READ" } });
  const writeContext = { ...context, scopes: ["write_products"] };
  assert.equal(checkMetafieldAccess(publicRead, "read", context).allowed, true);
  assert.equal(checkMetafieldAccess(publicRead, "write", writeContext).reason, "DEFINITION_ACCESS_DENIED");
  const own = field({ namespace: "app--123--private", access: { admin: "MERCHANT_READ" } });
  assert.equal(checkMetafieldAccess(own, "write", writeContext).allowed, true);
  assert.equal(checkMetafieldAccess(own, "read", { ...context, appId: "456" }).reason, "APP_NAMESPACE_DENIED");
  assert.equal(checkMetafieldAccess(own, "read", { ...context, appId: undefined }).reason, "APP_NAMESPACE_DENIED");
  const otherApp = field({ namespace: "app--456", access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" } });
  assert.equal(checkMetafieldAccess(otherApp, "read", writeContext).reason, "APP_NAMESPACE_DENIED");
  assert.equal(checkMetafieldAccess(field({ access: undefined }), "read", context).reason, "DEFINITION_ACCESS_UNKNOWN");
  assert.equal(checkMetafieldAccess(field({ access: { admin: "PRIVATE", storefront: "PUBLIC_READ" } }), "read", context).reason, "DEFINITION_ACCESS_DENIED");
  assert.throws(() => field({ access: { admin: "ALL" } }), { code: "INVALID_METAFIELD_DEFINITION" });
  assert.throws(() => checkMetafieldAccess({ ...own }, "read", context), { code: "UNKNOWN_FIELD" });
});
