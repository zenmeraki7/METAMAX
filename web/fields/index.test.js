import test from "node:test";
import assert from "node:assert/strict";
import * as fields from "./index.js";
import { SOURCE_DATASETS } from "./sources.js";

test("public Field Engine API exposes only the approved stable surface", () => {
  assert.deepEqual(Object.keys(fields).sort(), [
    "FIELD_CAPABILITY_CONTRACT_VERSION", "FIELD_CAPABILITY_VERSIONS", "getFieldCapability", "CANONICAL_FIELD_COUNT", "CANONICAL_REGISTRY_INFO", "getCanonicalField",
    "requireCanonicalField", "listCanonicalFields", "FIELD_TYPES",
    "FIELD_ERROR_CODES", "FieldError", "isFieldType", "isNumericType", "isSortableType",
    "normalizeFieldValue", "normalizeOperatorOperand", "POLICY_CONTEXT",
    "WRITE_OPERATIONS", "WRITE_OPERAND_KIND", "WRITE_OPERATION_OPERANDS",
    "normalizeWriteOperand", "validateFinalWriteValue", "getFieldConstraints", "getFieldPolicy",
    "assertFieldWriteOperation", "listFieldWriteOperations", "getFieldClearResult",
    "FIELD_ACCESS", "FIELD_ORIGINS", "createFieldService",
  ].sort());
});

test("public normalization works with trusted registry definitions and policies", () => {
  const price = fields.requireCanonicalField("variant.price");
  assert.equal(fields.normalizeOperatorOperand(price, "lt", "-1.00", {
    constraints: fields.getFieldConstraints(price.id, fields.POLICY_CONTEXT.FILTER),
  }), "-1");
  assert.throws(() => fields.validateFinalWriteValue(price.id, fields.WRITE_OPERATIONS.SET, "-1"), {
    code: fields.FIELD_ERROR_CODES.INVALID_VALUE,
  });
});

test("production dataset registry includes metafields before resolver initialization", () => {
  assert.equal(SOURCE_DATASETS.METAFIELDS, "metafields");
  assert.ok(Object.isFrozen(SOURCE_DATASETS));
  assert.equal(typeof fields.createFieldService, "function");
});
