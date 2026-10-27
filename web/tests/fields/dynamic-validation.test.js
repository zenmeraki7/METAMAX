import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FIELDS, createMetafieldRegistry, requireResolvedField, resolveField,
  normalizeFieldValue, normalizeValue, validateFieldValue, requireValidFieldValue,
  validateValue, validateFieldValues, validateEditOperation,
} from "../../fields/index.js";

const shopId = "example.myshopify.com";
const types = ["single_line_text_field", "multi_line_text_field", "number_integer",
  "number_decimal", "boolean", "list.single_line_text_field"];
const registry = createMetafieldRegistry(shopId, types.map((type, i) => ({
  owner: i % 2 ? "variant" : "product", namespace: "custom", key: `field_${i}`,
  type, definitionVersion: `definition-${i}`, validations: [],
})), { generation: "generation-1", snapshotId: "snapshot-1" });
const descriptors = registry.list().map(field => requireResolvedField(field.id, { shopId, metafields: registry }));
const read = { purpose: "read" };

test("all resolved dynamic types reach normalization and validation without a canonical lookup", () => {
  const inputs = [" e\u0301 ", "line one\nline two", "-9007199254740991", "-0010.500", " FALSE ", [" x ", " x ", ""]];
  const expected = [" é ", "line one\nline two", -9007199254740991, "-10.5", false, [" x ", " x ", ""]];
  descriptors.forEach((field, i) => {
    assert.deepEqual(normalizeFieldValue(field, inputs[i]), expected[i]);
    assert.deepEqual(requireValidFieldValue(field, inputs[i], read), expected[i]);
    assert.deepEqual(validateFieldValue(field, inputs[i], read), {
      valid: true, field: field.id, value: expected[i], code: null, message: null,
    });
    assert.deepEqual(normalizeValue(field, inputs[i]), expected[i]);
    assert.deepEqual(validateValue(field, inputs[i]).value, expected[i]);
    assert.equal(requireValidFieldValue(field, null, read), null);
  });
});

test("dynamic validation preserves parser errors and does not borrow product price or tag rules", () => {
  assert.equal(validateFieldValue(descriptors[3], "1e2", read).code, "INVALID_FIELD_VALUE");
  assert.equal(validateFieldValue(descriptors[2], "9007199254740992", read).valid, false);
  assert.equal(validateFieldValue(descriptors[4], 1, read).valid, false);
  assert.equal(validateFieldValue(descriptors[0], undefined, read).code, "MISSING_VALUE");
  assert.equal(validateFieldValue(descriptors[5], "a,b", read).valid, false);
  assert.equal(validateFieldValue("product.tags", [""]).valid, false);
  assert.equal(validateFieldValue("variant.price", "-10.5").code, "BELOW_MINIMUM");
});

test("metadata validation does not enable dynamic filters, writes, imports, exports or undo", () => {
  for (const field of descriptors) {
    for (const purpose of ["edit", "filter", "import", "export", "undo"])
      assert.equal(validateFieldValue(field, null, { purpose }).code, "NOT_SUPPORTED");
    assert.equal(validateFieldValue(field, null).code, "NOT_SUPPORTED");
    assert.equal(validateEditOperation(field.id, "set", null).valid, false);
  }
});

test("forged, copied, serialized and raw dynamic references cannot enter the value pipeline", () => {
  const genuine = descriptors[3];
  let invoked = false;
  const getter = { get id() { invoked = true; return genuine.id; }, get type() { invoked = true; return "decimal"; } };
  for (const reference of [genuine.id, { ...genuine }, JSON.parse(JSON.stringify(genuine)),
    Object.create(genuine), Object.freeze({ ...genuine, capabilities: { editable: true } }), getter]) {
    assert.equal(validateFieldValue(reference, "-1", read).code, "UNKNOWN_FIELD");
    assert.throws(() => normalizeFieldValue(reference, "-1"), { code: "UNKNOWN_FIELD" });
  }
  assert.equal(invoked, false);
  assert.throws(() => requireResolvedField(genuine.id, { shopId: "other.myshopify.com", metafields: registry }), { code: "SHOP_MISMATCH" });
});

test("canonical IDs, canonical identities and branded fixed descriptors retain their constraints", () => {
  const title = CANONICAL_FIELDS.find(field => field.id === "product.title");
  for (const reference of ["product.title", title, resolveField("product.title")]) {
    assert.equal(normalizeFieldValue(reference, " Summer "), "Summer");
    assert.equal(validateFieldValue(reference, " ").valid, false);
    assert.equal(requireValidFieldValue(reference, "Summer"), "Summer");
  }
  const fixed = resolveField("variant.compare_at_price");
  assert.equal(validateFieldValue(fixed, "-1").code, "BELOW_MINIMUM");
  assert.equal(validateFieldValue({ ...title }, "Summer").code, "UNKNOWN_FIELD");
});

test("batch validation retains dynamic descriptors and canonicalizes fixed aliases", () => {
  const result = validateFieldValues([
    { field: descriptors[3], value: "+0019.9900" },
    { field: "variant.compare_at_price", value: null },
    { field: descriptors[4], value: "yes" },
  ], read);
  assert.equal(result.valid, false);
  assert.equal(result.results[0].value, "19.99");
  assert.equal(result.results[0].field, descriptors[3].id);
  assert.equal(result.results[1].field, "variant.compareAtPrice");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, descriptors[4].id);
  assert.equal(result.errors[0].value, undefined);
  assert.equal(Object.isFrozen(result.results), true);
});
