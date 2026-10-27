import assert from "node:assert/strict";
import { getFieldCapabilities, checkFieldAvailability } from "../fields/capabilities.js";
import { listFieldOperations, validateEditOperation } from "../fields/operations.js";
import { createMetafieldRegistry, resolveField } from "../fields/resolve.js";
import { requiredDatasets, checkSourceCoverage } from "../fields/sources.js";

const capabilities = getFieldCapabilities("variant.price");
assert.equal(capabilities.edit, true); // Declaration, not permission to execute.
console.log("Declared capabilities:", capabilities);

const operations = listFieldOperations("variant.price");
assert.deepEqual(operations.map(operation => operation.id), ["set"]);
console.log("Supported operations:", operations);

const price = validateEditOperation("variant.price", "set", "0019.9900");
assert.equal(price.valid, true);
assert.equal(price.value, "19.99");
console.log("Normalized price:", price);

const rejected = validateEditOperation("variant.price", "add_tags", ["Sale"]);
assert.equal(rejected.valid, false);
assert.equal(rejected.code, "OPERATION_NOT_SUPPORTED");
console.log("Rejected operation:", rejected);

const tags = validateEditOperation("product.tags", "add_tags", ["Summer", "Sale"]);
assert.equal(tags.valid, true);
assert.deepEqual(tags.value, ["Summer", "Sale"]);
console.log("Validated tags:", tags);

// Illustrative fixture only. In production, obtain these facts from verified
// installation/authentication, current granted scopes, mirror coverage and the
// field-specific gateway registry. Never accept them from request JSON.
const context = {
  authorized: true,
  scopes: ["write_products"],
  completedDatasets: ["products"],
  coverageReady: true,
  writeAdapterReady: false,
};
const blocked = checkFieldAvailability("variant.price", "edit", context);
assert.deepEqual(blocked, { available: false, reason: "WRITE_ADAPTER_NOT_READY" });
console.log("Runtime availability:", blocked);

// Missing scope/coverage information is checked before adapter readiness.
const incomplete = checkFieldAvailability("variant.price", "edit", {
  authorized: true, writeAdapterReady: false,
});
assert.deepEqual(incomplete, { available: false, reason: "DATASET_NOT_READY" });
console.log("Incomplete runtime context:", incomplete);

// A trusted backend must supply both verified definition revisions and durable
// per-definition coverage. These are local examples, not real coverage records.
const expected = { shopId: "example.myshopify.com", generation: "generation-1", snapshotId: "snapshot-1" };
const registry = createMetafieldRegistry(expected.shopId, [{
  owner: "product", namespace: "custom", key: "material", type: "single_line_text_field",
  definitionVersion: "definition-1",
}], { generation: expected.generation, snapshotId: expected.snapshotId });
const material = resolveField("metafield:product:custom.material", { shopId: expected.shopId, metafields: registry });
assert.deepEqual(requiredDatasets(["product.title", material]), ["metafields", "products"]);
const coverage = { ...expected, datasets: { products: true, metafields: true }, definitions: {
  [material.id]: { ...expected, complete: true, ownerType: "PRODUCT", namespace: "custom", key: "material",
    shopifyType: "single_line_text_field", definitionVersion: "definition-1" },
} };
const complete = checkSourceCoverage([material], coverage, expected);
assert.equal(complete.ready, true);
assert.deepEqual(complete.missingDefinitions, []);
const incompleteDefinition = checkSourceCoverage([material], { ...coverage, definitions: {} }, expected);
assert.equal(incompleteDefinition.ready, false);
assert.deepEqual(incompleteDefinition.missingDefinitions, [material.id]);
console.log("Dynamic per-definition coverage:", complete);
console.log("PASS: Field integration example assertions passed. No external services were used.");
