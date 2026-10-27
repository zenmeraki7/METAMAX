import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FIELDS, FieldError, createMetafieldRegistry, resolveField,
  listResolvedFields, getFieldSource, requiredDatasets, checkSourceCoverage,
} from "../../fields/index.js";

const shopId = "example.myshopify.com";
const context = { shopId, generation: "generation-1", snapshotId: "snapshot-1" };
const material = { owner: "product", namespace: "custom", key: "material", type: "single_line_text_field", definitionVersion: "definition-1" };
const fabric = { owner: "variant", namespace: "custom", key: "fabric", type: "single_line_text_field", definitionVersion: "definition-2" };
const materialId = "metafield:product:custom.material";
const fabricId = "metafield:variant:custom.fabric";
const binding = { generation: context.generation, snapshotId: context.snapshotId };

function registry(definitions = [material, fabric], bound = binding, shop = shopId) {
  return createMetafieldRegistry(shop, definitions, bound);
}

function resolve(id = materialId, source = registry()) {
  return resolveField(id, { shopId: source.shopId, metafields: source });
}

function entry(definition = material, sourceContext = context) {
  return { ...sourceContext, complete: true,
    ownerType: definition.owner === "product" ? "PRODUCT" : "PRODUCTVARIANT",
    namespace: definition.namespace, key: definition.key, shopifyType: definition.type,
    definitionVersion: definition.definitionVersion };
}

function coverage() {
  return { ...context, datasets: { products: true, variants: true, metafields: true },
    definitions: { [materialId]: entry(), [fabricId]: entry(fabric) } };
}

const fails = (fn, code) => assert.throws(fn, error => error instanceof FieldError && error.code === code);

test("fixed IDs, canonical objects and resolved descriptors can be combined with dynamic descriptors", () => {
  const source = registry();
  const resolved = listResolvedFields({ shopId, metafields: source });
  assert.deepEqual(requiredDatasets(["product.title", resolveField("variant.price"), resolve(materialId, source), resolve(fabricId, source)]),
    ["metafields", "products", "variants"]);
  assert.ok(requiredDatasets(resolved).includes("metafields"));
  assert.deepEqual(requiredDatasets([CANONICAL_FIELDS[0]]), ["products"]);
  assert.equal(getFieldSource(resolve()).dataset, "metafields");
  assert.deepEqual(checkSourceCoverage([resolveField("product.title")], { products: true }),
    { ready: true, required: ["products"], missing: [] });
});

test("each required dynamic definition must have its own complete matching coverage entry", () => {
  const source = registry(), materialField = resolve(materialId, source), fabricField = resolve(fabricId, source);
  const result = checkSourceCoverage(["product.title", materialField, fabricField, materialField], coverage(), context);
  assert.equal(result.ready, true);
  assert.deepEqual(result.required, ["metafields", "products", "variants"]);
  assert.deepEqual(result.requiredDefinitions, [materialId, fabricId]);
  assert.deepEqual(result.missingDefinitions, []);
  assert.deepEqual(result.definitionFailures, []);
  const partial = coverage();
  delete partial.definitions[fabricId];
  const unavailable = checkSourceCoverage([materialField, fabricField], partial, context);
  assert.equal(unavailable.ready, false);
  assert.deepEqual(unavailable.missingDefinitions, [fabricId]);
  assert.equal(unavailable.definitionFailures[0].reason, "DEFINITION_NOT_COVERED");
});

test("a metafields dataset flag alone cannot establish per-definition coverage", () => {
  const field = resolve();
  const coarse = coverage();
  coarse.definitions = {};
  assert.equal(checkSourceCoverage([field], coarse, context).ready, false);
  const other = coverage();
  other.definitions = { [fabricId]: entry(fabric) };
  assert.equal(checkSourceCoverage([field], other, context).ready, false);
  const missingDataset = coverage();
  missingDataset.datasets.metafields = false;
  const result = checkSourceCoverage([field], missingDataset, context);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["metafields"]);
  assert.deepEqual(result.missingDefinitions, []);
});

test("coverage completion must be the exact own boolean true", () => {
  for (const complete of [false, undefined, "true", 1]) {
    const value = coverage();
    value.definitions[materialId].complete = complete;
    assert.equal(checkSourceCoverage([resolve()], value, context).definitionFailures[0].reason, "DEFINITION_NOT_COMPLETE");
  }
  const inherited = coverage();
  inherited.definitions[materialId] = Object.create(entry());
  assert.equal(checkSourceCoverage([resolve()], inherited, context).ready, false);
});

test("definition identity, type and version cannot be substituted", () => {
  for (const [key, value] of [
    ["ownerType", "PRODUCTVARIANT"], ["namespace", "other"], ["key", "other"],
    ["shopifyType", "boolean"], ["definitionVersion", "definition-old"],
  ]) {
    const snapshot = coverage();
    snapshot.definitions[materialId][key] = value;
    const result = checkSourceCoverage([resolve()], snapshot, context);
    assert.equal(result.ready, false);
    assert.equal(result.definitionFailures[0].reason, "DEFINITION_IDENTITY_MISMATCH");
  }
});

test("definition records cannot come from another tenant, generation or snapshot", () => {
  for (const [key, value] of [["shopId", "other.myshopify.com"], ["generation", "old-generation"], ["snapshotId", "old-snapshot"]]) {
    const snapshot = coverage();
    snapshot.definitions[materialId][key] = value;
    const result = checkSourceCoverage([resolve()], snapshot, context);
    assert.equal(result.ready, false);
    assert.equal(result.definitionFailures[0].reason, "DEFINITION_CONTEXT_MISMATCH");
  }
});

test("dynamic coverage requires independently supplied expected published context", () => {
  const field = resolve();
  fails(() => checkSourceCoverage([field], coverage()), "COVERAGE_CONTEXT_REQUIRED");
  fails(() => checkSourceCoverage([field], { products: true, metafields: true }, context), "SHOP_MISMATCH");
  fails(() => checkSourceCoverage([field], { ...coverage(), definitions: [] }, context), "INVALID_COVERAGE");
  fails(() => checkSourceCoverage([field], { ...coverage(), datasets: true }, context), "INVALID_COVERAGE");
  fails(() => checkSourceCoverage([field], coverage(), { ...context, generation: "" }), "COVERAGE_CONTEXT_REQUIRED");
});

test("coverage envelopes and descriptor bindings reject stale snapshots or generations", () => {
  for (const [key, value] of [["generation", "generation-old"], ["snapshotId", "snapshot-old"]]) {
    fails(() => checkSourceCoverage([resolve()], { ...coverage(), [key]: value }, context), "COVERAGE_CONTEXT_MISMATCH");
    const stale = registry([material], { ...binding, [key]: value });
    fails(() => checkSourceCoverage([resolve(materialId, stale)], coverage(), context), "DYNAMIC_COVERAGE_CONTEXT_MISMATCH");
  }
});

test("mixed-shop or conflicting definition descriptors cannot be bundled", () => {
  const foreign = registry([fabric], binding, "other.myshopify.com");
  fails(() => requiredDatasets([resolve(), resolve(fabricId, foreign)]), "SHOP_MISMATCH");
  fails(() => checkSourceCoverage([resolve(materialId, registry([material], binding, "other.myshopify.com"))], coverage(), context), "SHOP_MISMATCH");
  const changed = registry([{ ...material, definitionVersion: "definition-new" }]);
  fails(() => requiredDatasets([resolve(), resolve(materialId, changed)]), "DYNAMIC_DEFINITION_CONFLICT");
});

test("unversioned or unbound metadata cannot make dynamic coverage ready", () => {
  const unbound = createMetafieldRegistry(shopId, [material]);
  const unboundField = resolve(materialId, unbound);
  assert.deepEqual(requiredDatasets([unboundField]), ["metafields", "products"]);
  fails(() => checkSourceCoverage([unboundField], coverage(), context), "DYNAMIC_COVERAGE_BINDING_REQUIRED");
  const { definitionVersion, ...unversioned } = material;
  const field = resolve(materialId, registry([unversioned]));
  const result = checkSourceCoverage([field], coverage(), context);
  assert.equal(result.ready, false);
  assert.equal(result.definitionFailures[0].reason, "DEFINITION_VERSION_REQUIRED");
});

test("serialized, copied, forged and raw-string dynamic references are not trusted", () => {
  const field = resolve();
  for (const reference of [materialId, { ...field }, JSON.parse(JSON.stringify(field)), Object.freeze({ ...field }), { dynamic: true, source: field.source }]) {
    assert.equal(getFieldSource(reference), null);
    fails(() => requiredDatasets([reference]), "FIELD_SOURCE_NOT_FOUND");
  }
  fails(() => requiredDatasets([{ ...resolveField("product.title") }]), "FIELD_SOURCE_NOT_FOUND");
});

test("coverage input getters are rejected without execution and results are immutable", () => {
  let called = false;
  const value = coverage();
  Object.defineProperty(value.definitions[materialId], "complete", { get() { called = true; return true; } });
  fails(() => checkSourceCoverage([resolve()], value, context), "INVALID_FIELD_INPUT");
  assert.equal(called, false);
  const missing = coverage();
  missing.definitions = {};
  const result = checkSourceCoverage([resolve()], missing, context);
  assert.throws(() => result.missingDefinitions.push("other"), TypeError);
  assert.throws(() => { result.definitionFailures[0].reason = "other"; }, TypeError);
});

test("registry binding and definition version tokens are validated without weakening metadata resolution", () => {
  for (const bound of [{ generation: "g" }, { snapshotId: "s" }, { ...binding, shopId }, { generation: " ", snapshotId: "s" }, []])
    fails(() => registry([material], bound), "INVALID_COVERAGE_CONTEXT");
  for (const definitionVersion of [0, false, "", " x", "x\n", "x".repeat(257), "\ud800"])
    fails(() => registry([{ ...material, definitionVersion }]), "INVALID_DEFINITION_VERSION");
  const field = resolve();
  assert.equal(field.definitionVersion, "definition-1");
  assert.deepEqual(field.coverageContext, binding);
  assert.equal(field.capabilities.filterable, false);
  assert.equal(field.capabilities.editable, false);
});
