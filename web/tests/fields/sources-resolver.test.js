import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FIELDS, DATASETS, FieldError, getCanonicalField, getFieldSource,
  requireFieldSource, listFieldSources, listDatasetFields, requiredDatasets,
  checkSourceCoverage, makeMetafieldId, parseMetafieldId, createMetafieldRegistry,
  resolveField, requireResolvedField, listResolvedFields, validateChange,
  getCapabilities,
} from "../../fields/index.js";

const shop = "example.myshopify.com", otherShop = "other.myshopify.com";
const material = { owner: "product", namespace: "custom", key: "material", name: "Material", type: "single_line_text_field" };
const weight = { owner: "variant", namespace: "custom", key: "weight_value", name: "Weight Value", type: "number_decimal" };
const materialId = "metafield:product:custom.material";
const weightId = "metafield:variant:custom.weight_value";
const runtime = { authorized: true, coverageReady: true, writeAdapterReady: true };
const fails = (fn, code) => assert.throws(fn, error => error instanceof FieldError && error.code === code);

test("every canonical field has one immutable source identity", () => {
  const sources = listFieldSources();
  assert.equal(sources.length, CANONICAL_FIELDS.length);
  for (const field of CANONICAL_FIELDS) {
    const source = requireFieldSource(field.id);
    assert.equal(source.field, field.id);
    assert.ok(source.requires.includes(source.dataset));
    assert.equal(typeof source.path, "string");
    assert.ok(Object.isFrozen(source.storage.path));
    assert.ok(Object.isFrozen(source.requires));
  }
  assert.throws(() => sources.push({}), TypeError);
  assert.equal(getFieldSource("variant.compare_at_price"), getFieldSource("variant.compareAtPrice"));
});

test("logical datasets are distinct from existing physical storage", () => {
  const variant = requireFieldSource("variant.price");
  assert.equal(variant.dataset, DATASETS.VARIANTS);
  assert.equal(variant.storage.dataset, "products");
  assert.equal(variant.storage.model, "SnapshotProduct");
  const location = requireFieldSource("location.name");
  assert.equal(location.dataset, DATASETS.LOCATIONS);
  assert.equal(location.storage.dataset, "inventory_locations");
  assert.deepEqual(requiredDatasets(["product.title", "variant.price", "variant.price"]), ["products", "variants"]);
});

test("quantities and location relationships have explicit dependencies without invented aggregates", () => {
  const quantity = requireFieldSource("inventoryLevel.available");
  assert.equal(quantity.mode, "quantity");
  assert.deepEqual(quantity.requires, ["inventory_items", "inventory_levels", "inventory_quantities"]);
  assert.equal(requireFieldSource("inventoryLevel.locationId").mode, "relationship");
  assert.deepEqual(requiredDatasets(["inventoryLevel.locationId"]), ["inventory_items", "inventory_levels", "locations"]);
  assert.equal(getFieldSource("inventory.available"), null);
  assert.equal(getFieldSource("google.category"), null);
  assert.deepEqual(listDatasetFields(DATASETS.GOOGLE_SHOPPING), []);
  assert.equal(getCapabilities("inventoryLevel.available", {
    ...runtime, scopes: ["read_inventory"], completedDatasets: ["inventory_quantities"],
  }).readable, false);
  assert.equal(getCapabilities("inventoryLevel.available", {
    ...runtime, scopes: ["read_inventory"], completedDatasets: ["inventory_items", "inventory_levels", "inventory_quantities"],
  }).readable, true);
  assert.equal(getCapabilities("location.name", {
    ...runtime, scopes: ["read_locations"], completedDatasets: ["inventory_locations"],
  }).readable, true);
});

test("unknown field IDs and dataset identifiers never become source paths", () => {
  for (const id of [null, {}, "__proto__", "constructor", "product.title; DROP TABLE x", materialId]) {
    assert.equal(getCanonicalField(id), null);
    assert.equal(getFieldSource(id), null);
    fails(() => requireFieldSource(id), "FIELD_SOURCE_NOT_FOUND");
  }
  fails(() => listDatasetFields("SnapshotProduct"), "UNKNOWN_DATASET");
  fails(() => requiredDatasets("product.title"), "INVALID_FIELD_LIST");
  fails(() => requiredDatasets(Array(1001).fill("product.title")), "INVALID_FIELD_LIST");
  fails(() => requiredDatasets(new Array(1)), "FIELD_SOURCE_NOT_FOUND");
});

test("coverage requires own true values and never coerces booleans", () => {
  const fields = ["product.title", "variant.price"];
  assert.deepEqual(checkSourceCoverage(fields, { products: true, variants: true }), {
    ready: true, required: ["products", "variants"], missing: [],
  });
  assert.deepEqual(checkSourceCoverage(fields, { products: true, variants: "true" }).missing, ["variants"]);
  assert.equal(checkSourceCoverage(fields, { products: true, variants: 1 }).ready, false);
  for (const coverage of [null, [], true, Object.create({ products: true, variants: true })])
    fails(() => checkSourceCoverage(fields, coverage), "INVALID_COVERAGE");
  let accessed = false;
  const coverage = { products: true };
  Object.defineProperty(coverage, "variants", { get() { accessed = true; return true; } });
  fails(() => checkSourceCoverage(fields, coverage), "INVALID_FIELD_INPUT");
  assert.equal(accessed, false);
  assert.ok(Object.isFrozen(checkSourceCoverage(fields, {}).missing));
});

test("fixed field resolution preserves aliases and provides scoped capabilities", () => {
  const price = resolveField("variant.price");
  assert.equal(price.dynamic, false);
  assert.equal(price.source.dataset, "variants");
  assert.equal(price.capabilities.editable, false);
  assert.equal(resolveField("variant.compare_at_price"), resolveField("variant.compareAtPrice"));
  assert.equal(resolveField("unknown"), null);
  fails(() => requireResolvedField("unknown"), "FIELD_NOT_FOUND");
  const editable = resolveField("product.title", { ...runtime, scopes: ["write_products"], completedDatasets: ["products"] });
  assert.equal(editable.capabilities.editable, true);
  assert.equal(resolveField("product.title").capabilities.editable, false);
});

test("dynamic IDs round-trip with bounded deterministic owner/namespace/key identity", () => {
  assert.equal(makeMetafieldId(material), materialId);
  assert.deepEqual(parseMetafieldId(materialId), { owner: "product", namespace: "custom", key: "material" });
  assert.ok(Object.isFrozen(parseMetafieldId(materialId)));
  for (const id of [null, {}, "metafield:order:custom.material", "metafield:product:custom.a.b", "metafield:product:custom.a/../b", "metafield:product:custom.", "metafield:product:custom." + "x".repeat(256)])
    assert.equal(parseMetafieldId(id), null);
  fails(() => makeMetafieldId({ ...material, owner: "constructor" }), "UNSUPPORTED_OWNER");
  fails(() => makeMetafieldId({ ...material, namespace: "$app" }), "INVALID_METAFIELD_IDENTITY");
  fails(() => makeMetafieldId({ ...material, key: "a.b" }), "INVALID_METAFIELD_IDENTITY");
});

test("registries resolve exactly scoped immutable metadata without granting value permissions", () => {
  const registry = createMetafieldRegistry(shop, [material, weight]);
  const context = { shopId: shop, metafields: registry };
  const field = resolveField(materialId, context);
  assert.equal(field.type, "text");
  assert.equal(field.ownerType, "PRODUCT");
  assert.equal(field.shopId, shop);
  assert.equal(resolveField(weightId, context).ownerType, "PRODUCTVARIANT");
  assert.equal(resolveField(weightId, context).type, "decimal");
  assert.equal(field.source.path, null);
  assert.deepEqual(field.source.requires, ["products", "metafields"]);
  assert.deepEqual(resolveField(weightId, context).source.requires, ["variants", "metafields"]);
  assert.equal(field.capabilities.filterable, false);
  assert.equal(field.capabilities.export, false);
  assert.equal(field.capabilities.editable, false);
  assert.equal(listResolvedFields(context).length, 49);
  assert.equal(listResolvedFields().length, 47);
  assert.equal(registry.has(materialId), true);
  assert.equal(registry.get("missing"), null);
  assert.ok(Object.isFrozen(registry.list()));
  assert.throws(() => field.source.requires.push("other"), TypeError);
  assert.equal(validateChange({ field: materialId, operation: "set", value: "cotton" }, { scopes: ["write_products"], completedDatasets: ["products", "metafields"] }).ok, false);
});

test("all six supported metafield type names map explicitly", () => {
  const types = {
    single_line_text_field: "text", multi_line_text_field: "text", number_integer: "integer",
    number_decimal: "decimal", boolean: "boolean", "list.single_line_text_field": "string_list",
  };
  for (const [type, expected] of Object.entries(types)) {
    const registry = createMetafieldRegistry(shop, [{ ...material, type }]);
    assert.equal(registry.get(materialId).type, expected);
  }
  for (const type of ["json", "date", "product_reference", "constructor", "__proto__", { name: "boolean" }])
    fails(() => createMetafieldRegistry(shop, [{ ...material, type }]), "UNSUPPORTED_METAFIELD_TYPE");
});

test("registry snapshots are isolated from later definition mutations", () => {
  const definitions = [{ ...material }];
  const registry = createMetafieldRegistry(shop, definitions);
  definitions[0].name = "Changed";
  definitions[0].key = "other";
  definitions.push(weight);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(materialId).label, "Material");
});

test("cross-shop registries are rejected for both resolution and listing", () => {
  const registry = createMetafieldRegistry(shop, [material]);
  fails(() => resolveField(materialId, { shopId: otherShop, metafields: registry }), "SHOP_MISMATCH");
  fails(() => listResolvedFields({ shopId: otherShop, metafields: registry }), "SHOP_MISMATCH");
  fails(() => resolveField(materialId, { metafields: registry }), "SHOP_CONTEXT_REQUIRED");
  assert.equal(resolveField(materialId, { shopId: shop }), null);
  assert.equal(resolveField("metafield:product:custom.unknown", { shopId: shop, metafields: registry }), null);
});

test("duck-typed or serialized registry impostors are never consulted", () => {
  let called = false;
  const impostor = { shopId: shop, get() { called = true; return {}; }, list() { called = true; return []; } };
  fails(() => resolveField(materialId, { shopId: shop, metafields: impostor }), "INVALID_REGISTRY");
  fails(() => listResolvedFields({ shopId: shop, metafields: impostor }), "INVALID_REGISTRY");
  assert.equal(called, false);
  const real = createMetafieldRegistry(shop, [material]);
  fails(() => resolveField(materialId, { shopId: shop, metafields: JSON.parse(JSON.stringify(real)) }), "INVALID_REGISTRY");
});

test("definition shape, duplicates, accessors and attempts to set capabilities fail closed", () => {
  fails(() => createMetafieldRegistry(shop, [material, material]), "DUPLICATE_METAFIELD");
  for (const definition of [null, [], {}, { ...material, capabilities: { editable: true } }, { ...material, type: "unsupported" }])
    assert.throws(() => createMetafieldRegistry(shop, [definition]), FieldError);
  fails(() => createMetafieldRegistry(shop, new Array(1)), "INVALID_DEFINITION");
  fails(() => createMetafieldRegistry(shop, Array(10001).fill(material)), "INVALID_DEFINITIONS");
  fails(() => createMetafieldRegistry("invalid-shop", [material]), "SHOP_CONTEXT_REQUIRED");
  let accessed = false;
  const definition = { ...material };
  Object.defineProperty(definition, "type", { get() { accessed = true; return "boolean"; } });
  fails(() => createMetafieldRegistry(shop, [definition]), "INVALID_FIELD_INPUT");
  assert.equal(accessed, false);
});
