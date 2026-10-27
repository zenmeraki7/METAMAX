import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FIELDS, FIELD_LIMITS, FieldError, listFields, resolveField,
  resolveSource, resolveFieldValue, normalizeValue, validateValue,
  validateChange, assertValidChange, assertValidChanges, getCapabilities,
  assertFieldCapability, requireResolvedField,
} from "../../fields/index.js";

const runtime = { authorized: true, coverageReady: true, writeAdapterReady: true, undoJournalReady: true };
const productContext = { ...runtime, scopes: ["write_products"], completedDatasets: ["products"] };
const inventoryContext = { ...runtime, scopes: ["write_inventory"], completedDatasets: ["inventory_items"] };
const variantId = "gid://shopify/ProductVariant/9007199254740993123";
const product = { runId: "snapshot", data: {
  id: "gid://shopify/Product/1", title: "Test", tags: ["Summer"],
  featuredImage: null, variantsCount: { count: 1, precision: "EXACT" },
  variants: [{ id: variantId, price: "9007199254740993.123456", compareAtPrice: null,
    sku: "00123", inventoryItemId: "gid://shopify/InventoryItem/2" }],
} };
const fails = (fn, code) => assert.throws(fn, error => error instanceof FieldError && error.code === code);

test("canonical definitions and nested metadata cannot be mutated", () => {
  assert.equal(CANONICAL_FIELDS.length, 47);
  assert.equal(new Set(CANONICAL_FIELDS.map(field => field.id)).size, CANONICAL_FIELDS.length);
  assert.throws(() => { resolveField("product.title").sources.mirror.path[0] = "other"; }, TypeError);
  assert.throws(() => { resolveField("product.status").values.push("HIDDEN"); }, TypeError);
  assert.equal(listFields({ entity: "variant" }).length, 11);
  fails(() => listFields({ entity: "__proto__" }), "UNKNOWN_FIELD_ENTITY");
});

test("aliases resolve to one canonical contract; arbitrary paths and properties are rejected", () => {
  assert.equal(resolveField("product.product_type"), resolveField("product.productType"));
  for (const field of ["title", "__proto__", "constructor", "product.__proto__", "product.seo.title", {}, null])
    fails(() => requireResolvedField(field), "FIELD_NOT_FOUND");
  fails(() => resolveSource("product.title", "constructor"), "UNKNOWN_FIELD_SOURCE");
});

test("money normalization preserves precision and does not accept floating-point inputs", () => {
  assert.equal(normalizeValue("variant.price", "9007199254740993.123456"), "9007199254740993.123456");
  assert.equal(normalizeValue("variant.price", " 00019.23000 "), "19.23");
  assert.equal(normalizeValue("variant.price", "0.000"), "0");
  assert.equal(normalizeValue("variant.price", 0), "0");
  assert.equal(normalizeValue("variant.price", "+1"), "1");
  assert.equal(normalizeValue("variant.compareAtPrice", null), null);
  for (const value of [19.23, NaN, Infinity, "1e2", "-1", ".1", "1.", "", null, undefined, true])
    assert.equal(validateValue("variant.price", value).ok, false);
});

test("integers have explicit bounds and booleans never use JavaScript truthiness", () => {
  assert.equal(normalizeValue("inventoryLevel.available", "-10"), -10);
  assert.equal(normalizeValue("product.variantCount", "0"), 0);
  assert.equal(normalizeValue("inventoryItem.tracked", " FALSE "), false);
  for (const value of [1.5, Infinity, 2147483648, "1e2", " ", {}, true, "9".repeat(40)])
    assert.equal(validateValue("inventoryLevel.available", value).ok, false);
  for (const value of [1, 0, "0", "yes", [], {}])
    assert.equal(validateValue("inventoryItem.tracked", value).ok, false);
  assert.equal(validateValue("variant.position", 0).ok, false);
  assert.equal(validateValue("product.variantCount", -1).ok, false);
});

test("strings retain identifiers and HTML while rejecting malformed input", () => {
  assert.equal(normalizeValue("inventoryItem.sku", " 00123 "), " 00123 ");
  assert.equal(normalizeValue("product.descriptionHtml", " <p>Hi</p>\n"), " <p>Hi</p>\n");
  assert.equal(normalizeValue("product.title", "  Winter 🧥  "), "Winter 🧥");
  assert.equal(normalizeValue("product.handle", " Winter-Coat "), "winter-coat");
  for (const value of ["", " ", "a\0b", "\ud800", "x".repeat(FIELD_LIMITS.textLength + 1)])
    assert.equal(validateValue("product.title", value).ok, false);
  for (const value of ["winter coat", "-winter", "winter--coat", "winter/coat"])
    assert.equal(validateValue("product.handle", value).ok, false);
  assert.equal(normalizeValue("product.status", " unlisted "), "UNLISTED");
  assert.equal(validateValue("product.status", "ALL").ok, false);
});

test("lists require real arrays and never parse CSV implicitly", () => {
  assert.deepEqual(normalizeValue("product.tags", [" Summer ", "summer"]), ["Summer", "summer"]);
  assert.equal(validateValue("product.tags", [" Summer ", "Summer"]).ok, false);
  for (const value of ["one,two", [null], [" "], new Array(1), [1], Array(1001).fill("tag")])
    assert.equal(validateValue("product.tags", value).ok, false);
  const values = ["Summer"];
  assert.notEqual(normalizeValue("product.tags", values), values);
});

test("GIDs stay opaque and reject the wrong entity and numeric IDs", () => {
  assert.equal(normalizeValue("variant.id", variantId), variantId);
  for (const value of [123, "123", "gid://shopify/Product/123", "gid://shopify/ProductVariant/0", "gid://shopify/ProductVariant/1?x=2"])
    assert.equal(validateValue("variant.id", value).ok, false);
});

test("timestamps reject invalid calendar dates and preserve fractional revision precision", () => {
  const precise = "2026-10-26T01:02:03.123456Z";
  assert.equal(normalizeValue("product.updatedAt", precise), precise);
  assert.equal(normalizeValue("inventoryItem.updatedAt", new Date("2026-10-26T00:00:00Z")), "2026-10-26T00:00:00.000Z");
  assert.equal(validateValue("product.updatedAt", "2024-02-29T01:00:00+05:30").ok, true);
  for (const value of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-26", "2026-10-26T24:00:00Z", "2026-10-26T00:00:00+14:30", new Date(NaN), 0])
    assert.equal(validateValue("product.updatedAt", value).ok, false);
});

test("URLs reject active content and embedded credentials", () => {
  assert.equal(normalizeValue("product.featuredImageUrl", null), null);
  for (const value of ["javascript:alert(1)", "data:image/png;base64,x", "https://user:secret@example.com/a.png", "not-a-url"])
    assert.equal(validateValue("product.featuredImageUrl", value).ok, false);
});

test("source resolution matches current product snapshots and explicit variant targets", () => {
  assert.equal(resolveFieldValue("product.title", product), "Test");
  assert.equal(resolveFieldValue("product.featuredImageUrl", product), null);
  assert.equal(resolveFieldValue("product.variantCount", product), 1);
  assert.equal(resolveFieldValue("variant.price", product, { variantId }), "9007199254740993.123456");
  assert.equal(resolveFieldValue("variant.sku", product, { variantId }), "00123");
  assert.equal(resolveFieldValue("variant.inventoryItemId", { inventoryItem: { id: "gid://shopify/InventoryItem/2" } }, { source: "shopify" }), "gid://shopify/InventoryItem/2");
  fails(() => resolveFieldValue("variant.price", product), "VARIANT_TARGET_REQUIRED");
  fails(() => resolveFieldValue("variant.price", product, { variantId: "gid://shopify/ProductVariant/99" }), "VARIANT_TARGET_MISMATCH");
  fails(() => resolveFieldValue("variant.price", { data: { variants: [product.data.variants[0], product.data.variants[0]] } }, { variantId }), "VARIANT_TARGET_MISMATCH");
  fails(() => resolveFieldValue("product.variantCount", { data: { variantsCount: { count: 1, precision: "AT_LEAST" } } }), "INEXACT_FIELD_SOURCE");
  fails(() => resolveFieldValue("product.title", { data: {} }), "FIELD_VALUE_MISSING");
});

test("inventory source mapping verifies quantity identity and database timestamp names", () => {
  assert.equal(resolveFieldValue("inventoryLevel.available", { name: "available", quantity: -4 }), -4);
  assert.equal(resolveFieldValue("inventoryLevel.on_hand", { quantities: [{ name: "on_hand", quantity: 12 }] }, { source: "shopify" }), 12);
  fails(() => resolveFieldValue("inventoryLevel.available", { name: "on_hand", quantity: 12 }), "QUANTITY_TARGET_MISMATCH");
  fails(() => resolveFieldValue("inventoryLevel.available", { quantities: [{ name: "available", quantity: 1 }, { name: "available", quantity: 2 }] }, { source: "shopify" }), "QUANTITY_TARGET_MISMATCH");
  assert.equal(resolveFieldValue("location.updatedAt", { sourceUpdatedAt: new Date("2026-10-26T00:00:00Z") }), "2026-10-26T00:00:00.000Z");
});

test("capabilities fail closed on absent scopes or coverage and accept write-implies-read", () => {
  assert.equal(getCapabilities("product.title").editable, false);
  assert.equal(getCapabilities("product.title", productContext).editable, true);
  assert.equal(getCapabilities("product.title", { scopes: ["read_products"], completedDatasets: ["products"] }).editable, false);
  assert.equal(getCapabilities("product.title", { scopes: ["write_products"] }).editable, false);
  assert.equal(getCapabilities("inventoryItem.tracked", inventoryContext).editable, false);
  assert.equal(getCapabilities("inventoryItem.sku", inventoryContext).editable, true);
  assert.equal(getCapabilities("variant.sku", productContext).editable, false);
  assert.equal(getCapabilities("product.tags", productContext).sortable, false);
  assert.equal(getCapabilities("product.descriptionHtml", productContext).filterable, false);
  fails(() => assertFieldCapability("product.title", "edit"), "FIELD_CAPABILITY_DENIED");
  fails(() => assertFieldCapability("product.title", "constructor", productContext), "UNKNOWN_FIELD_CAPABILITY");
});

test("changes are strict, canonical, bounded and immutable", () => {
  assert.deepEqual(assertValidChange({ field: "product.product_type", operation: "set", value: "Coat" }, productContext), {
    field: "product.productType", operation: "set", value: "Coat",
  });
  assert.equal(validateChange({ field: "product.title", operation: "set", value: "Hi" }).ok, false);
  assert.equal(validateChange({ field: "product.id", operation: "set", value: "gid://shopify/Product/2" }, productContext).ok, false);
  assert.equal(validateChange({ field: "product.title", operation: "set", value: "Hi", shop: "other.myshopify.com" }, productContext).ok, false);
  fails(() => assertValidChanges([], productContext), "INVALID_FIELD_CHANGES");
  fails(() => assertValidChanges(Array(101).fill({}), productContext), "INVALID_FIELD_CHANGES");
  fails(() => assertValidChanges([
    { field: "product.productType", operation: "set", value: "A" },
    { field: "product.product_type", operation: "set", value: "B" },
  ], productContext), "DUPLICATE_FIELD_CHANGE");
  const changes = assertValidChanges([{ field: "product.tags", operation: "add_tags", value: ["Summer"] }], productContext);
  assert.ok(Object.isFrozen(changes[0].value));
});

test("only the reduced operation set is accepted, with explicit set values for empty fields", () => {
  assert.deepEqual(assertValidChange({ field: "product.tags", operation: "set", value: [] }, productContext).value, []);
  assert.equal(assertValidChange({ field: "variant.compareAtPrice", operation: "set", value: null }, productContext).value, null);
  assert.equal(assertValidChange({ field: "product.descriptionHtml", operation: "set", value: "" }, productContext).value, "");
  for (const operation of ["append", "prepend", "clear", "add", "remove", "multiply", "percentage"])
    assert.equal(validateChange({ field: "product.title", operation, value: "Hi" }, productContext).ok, false);
  assert.equal(validateChange({ field: "product.tags", operation: "add_tags", value: [] }, productContext).ok, false);
});

test("untrusted accessors and inherited fields are not executed or accepted", () => {
  let accessed = false;
  const change = { operation: "set", value: "Hi" };
  Object.defineProperty(change, "field", { get() { accessed = true; return "product.title"; } });
  assert.equal(validateChange(change, productContext).ok, false);
  assert.equal(accessed, false);
  fails(() => resolveFieldValue("product.title", { data: Object.create({ title: "inherited" }) }), "FIELD_VALUE_MISSING");
  const poisoned = JSON.parse('{"field":"product.title","operation":"set","value":"Hi","__proto__":{}}');
  assert.equal(validateChange(poisoned, productContext).ok, false);
  const error = validateValue("variant.price", "private-invalid-value");
  assert.ok(!JSON.stringify(error).includes("private-invalid-value"));
});
