import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES, CANONICAL_FIELDS, getFieldCapabilities, hasFieldCapability,
  requireFieldCapability, listFieldsByCapability, listFieldCapabilities,
  checkFieldAvailability, getCapabilities, getEditOperation, listEditOperations,
  listFieldOperations, supportsFieldOperation, requireFieldOperation,
  validateEditOperation, requireValidEditOperation, validateFieldValue,
  validateChange, assertValidChange, FieldError,
} from "../../fields/index.js";

const ready = {
  authorized: true, coverageReady: true, writeAdapterReady: true, undoJournalReady: true,
  scopes: ["write_products"], completedDatasets: ["products"],
};
const fails = (fn, code) => assert.throws(fn, error => error instanceof FieldError && error.code === code);

test("declared capabilities do not imply runtime availability", () => {
  const declared = getFieldCapabilities("product.title");
  assert.deepEqual(declared, { filter: true, edit: true, import: true, export: true, undo: true });
  assert.ok(Object.isFrozen(declared));
  assert.equal(getCapabilities("product.title").editable, false);
  assert.equal(checkFieldAvailability("product.title", "edit").reason, "CONTEXT_REQUIRED");
  assert.equal(checkFieldAvailability("product.title", "edit", ready).available, true);
  assert.equal(getCapabilities("product.title", ready).editable, true);
  assert.equal(getCapabilities("product.title", ready).importable, true);
  assert.equal(getCapabilities("product.title", ready).undoable, true);
});

test("restrictions only reduce canonical declarations and cannot be bypassed using scopes", () => {
  const unrestricted = { ...ready, scopes: ["write_products", "write_inventory", "read_locations"],
    completedDatasets: ["products", "inventory_items", "inventory_levels", "inventory_quantities", "inventory_locations"] };
  for (const id of ["variant.sku", "variant.barcode", "inventoryItem.tracked", "inventoryItem.requiresShipping", "inventoryLevel.available", "product.totalInventory"]) {
    assert.equal(hasFieldCapability(id, CAPABILITIES.EDIT), false);
    assert.equal(checkFieldAvailability(id, "edit", unrestricted).reason, "CAPABILITY_NOT_SUPPORTED");
    assert.deepEqual(listFieldOperations(id), []);
  }
  assert.equal(hasFieldCapability("inventoryItem.sku", "edit"), true);
  assert.equal(hasFieldCapability("product.handle", "undo"), false);
  assert.equal(hasFieldCapability("product.status", "undo"), false);
  assert.equal(hasFieldCapability("google.category", "edit"), false);
  assert.equal(hasFieldCapability("metafield:product:custom.material", "export"), false);
});

test("capability helpers canonicalize aliases and expose immutable bounded lists", () => {
  assert.deepEqual(getFieldCapabilities("product.product_type"), getFieldCapabilities("product.productType"));
  assert.equal(requireFieldCapability("product.product_type", "edit").id, "product.productType");
  assert.equal(listFieldCapabilities().length, CANONICAL_FIELDS.length);
  assert.ok(listFieldsByCapability("edit").every(field => hasFieldCapability(field.id, "edit")));
  assert.throws(() => listFieldsByCapability("edit").push({}), TypeError);
  assert.throws(() => { listFieldCapabilities()[0].capabilities.edit = false; }, TypeError);
  assert.equal(getFieldCapabilities("constructor"), null);
  fails(() => requireFieldCapability("constructor", "edit"), "UNKNOWN_FIELD");
  fails(() => requireFieldCapability("variant.sku", "edit"), "CAPABILITY_NOT_SUPPORTED");
  for (const capability of ["constructor", "__proto__", {}, null])
    fails(() => hasFieldCapability("product.title", capability), "UNKNOWN_FIELD_CAPABILITY");
});

test("runtime gates require exact booleans, scopes and actual dataset requirements", () => {
  assert.equal(checkFieldAvailability("product.title", "edit", []).reason, "CONTEXT_REQUIRED");
  for (const authorized of [undefined, false, 1, "true"])
    assert.equal(checkFieldAvailability("product.title", "edit", { ...ready, authorized }).reason, "NOT_AUTHORIZED");
  assert.equal(checkFieldAvailability("product.title", "edit", { ...ready, coverageReady: "true" }).reason, "DATASET_NOT_READY");
  assert.equal(checkFieldAvailability("product.title", "edit", { ...ready, completedDatasets: [] }).reason, "DATASET_NOT_READY");
  assert.equal(checkFieldAvailability("product.title", "edit", { ...ready, scopes: ["read_products"] }).reason, "WRITE_SCOPE_MISSING");
  assert.equal(checkFieldAvailability("product.title", "export", { ...ready, scopes: [] }).reason, "READ_SCOPE_MISSING");
  for (const writeAdapterReady of [undefined, false, 1, "true"])
    assert.equal(checkFieldAvailability("product.title", "edit", { ...ready, writeAdapterReady }).reason, "WRITE_ADAPTER_NOT_READY");
  assert.equal(checkFieldAvailability("product.title", "import", { ...ready, writeAdapterReady: false }).reason, "WRITE_ADAPTER_NOT_READY");
  assert.equal(checkFieldAvailability("product.title", "undo", { ...ready, undoJournalReady: false }).reason, "UNDO_JOURNAL_NOT_READY");
  assert.equal(checkFieldAvailability("unknown", "export", ready).reason, "UNKNOWN_FIELD");
  assert.ok(Object.isFrozen(checkFieldAvailability("product.title", "edit", ready)));
});

test("read capability needs coverage and permission but no write adapter", () => {
  const context = { ...ready, scopes: ["read_products"], writeAdapterReady: false, undoJournalReady: false };
  assert.equal(checkFieldAvailability("product.title", "filter", context).available, true);
  assert.equal(checkFieldAvailability("product.title", "export", context).available, true);
  assert.equal(checkFieldAvailability("product.descriptionHtml", "filter", context).reason, "CAPABILITY_NOT_SUPPORTED");
  assert.equal(checkFieldAvailability("product.title", "export", { ...context, coverageReady: false }).available, false);
});

test("accessors are not invoked by availability checks", () => {
  let accessed = false;
  const context = { ...ready };
  Object.defineProperty(context, "writeAdapterReady", { get() { accessed = true; return true; } });
  fails(() => checkFieldAvailability("product.title", "edit", context), "INVALID_FIELD_INPUT");
  assert.equal(accessed, false);
});

test("the operation catalogue exposes only set, add_tags, remove_tags", () => {
  assert.deepEqual(listEditOperations().map(operation => operation.id), ["set", "add_tags", "remove_tags"]);
  assert.equal(listEditOperations().every(operation => operation.requiresCurrentValue === false), true);
  assert.equal(getEditOperation("add_tags").mutationFamily, "tagsAdd");
  assert.equal(getEditOperation("remove_tags").mutationFamily, "tagsRemove");
  for (const id of ["append", "prepend", "clear", "add", "remove", "percentage", "multiply", "replace", "round", "constructor", "__proto__", {}, null]) {
    assert.equal(getEditOperation(id), null);
    assert.equal(supportsFieldOperation("product.title", id), false);
  }
  assert.throws(() => listEditOperations().push({}), TypeError);
  assert.throws(() => { getEditOperation("set").id = "other"; }, TypeError);
});

test("field operation allowlists resolve aliases without enabling unsupported fields", () => {
  assert.deepEqual(listFieldOperations("product.product_type").map(operation => operation.id), ["set"]);
  assert.deepEqual(listFieldOperations("product.tags").map(operation => operation.id), ["set", "add_tags", "remove_tags"]);
  assert.equal(supportsFieldOperation("variant.price", "set"), true);
  assert.equal(supportsFieldOperation("variant.price", "add_tags"), false);
  assert.equal(supportsFieldOperation("variant.sku", "set"), false);
  assert.equal(supportsFieldOperation("inventoryItem.sku", "set"), true);
  fails(() => requireFieldOperation("product.id", "set"), "OPERATION_NOT_SUPPORTED");
  fails(() => requireFieldOperation("product.title", "constructor"), "UNKNOWN_OPERATION");
  fails(() => requireFieldOperation("constructor", "set"), "UNKNOWN_FIELD");
});

test("operation input validation is reusable without granting execution availability", () => {
  const input = "9007199254740993.123456";
  assert.equal(requireValidEditOperation("variant.price", "set", input), input);
  assert.equal(validateFieldValue("variant.price", input, { purpose: "edit" }).value, input);
  assert.equal(validateEditOperation("variant.price", "set", 1.5).valid, false);
  assert.equal(validateEditOperation("variant.price", "set", null).valid, false);
  assert.equal(validateEditOperation("variant.compare_at_price", "set", null).valid, true);
  assert.equal(validateEditOperation("product.title", "set", " ").valid, false);
  assert.equal(validateEditOperation("product.tags", "set", []).valid, true);
  assert.equal(validateFieldValue("inventoryItem.tracked", true, { purpose: "edit" }).valid, false);
  assert.equal(validateFieldValue("product.title", "Hi", { purpose: "constructor" }).valid, false);
  assert.equal(validateChange({ field: "variant.price", operation: "set", value: input }).ok, false);
  assert.equal(assertValidChange({ field: "variant.price", operation: "set", value: input }, ready).value, input);
});

test("tag operations require bounded dense lists and reject normalized duplicates", () => {
  assert.deepEqual(requireValidEditOperation("product.tags", "add_tags", [" Summer ", "Cafe\u0301"]), ["Summer", "Café"]);
  assert.deepEqual(requireValidEditOperation("product.tags", "remove_tags", ["Summer"]), ["Summer"]);
  for (const operation of ["set", "add_tags", "remove_tags"]) {
    assert.equal(validateEditOperation("product.tags", operation, ["Summer", " Summer "]).code, "DUPLICATE_TAG");
    assert.equal(validateEditOperation("product.tags", operation, ["Café", "Cafe\u0301"]).code, "DUPLICATE_TAG");
    for (const input of [[null], [undefined], [1], [" "], ["a\0b"], new Array(1), ["\ud800"], ["x".repeat(1025)], ["\u0344".repeat(513)]])
      assert.equal(validateEditOperation("product.tags", operation, input).valid, false);
  }
  for (const operation of ["add_tags", "remove_tags"]) {
    assert.equal(validateEditOperation("product.tags", operation, "a,b").code, "INVALID_TAGS");
    assert.equal(validateEditOperation("product.tags", operation, []).code, "INVALID_TAG_COUNT");
    assert.equal(validateEditOperation("product.tags", operation, Array(251).fill("tag")).code, "INVALID_TAG_COUNT");
    const input = Array.from({ length: 250 }, (_, i) => `tag-${i}`);
    const result = validateEditOperation("product.tags", operation, input);
    assert.equal(result.valid, true);
    assert.notEqual(result.value, input);
    assert.ok(Object.isFrozen(result.value));
  }
});

test("operation validation does not invoke list accessors or expose rejected values", () => {
  let accessed = false;
  const input = ["tag"];
  Object.defineProperty(input, "0", { get() { accessed = true; return "tag"; } });
  assert.equal(validateEditOperation("product.tags", "add_tags", input).valid, false);
  assert.equal(accessed, false);
  assert.ok(!JSON.stringify(validateEditOperation("variant.price", "set", "private-invalid-value")).includes("private-invalid-value"));
});
