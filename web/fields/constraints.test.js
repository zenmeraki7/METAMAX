import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS, requireCanonicalField } from "./canonical.js";
import { FIELD_ERROR_CODES as C } from "./types.js";
import { normalizeFieldValue, normalizeOperatorOperand } from "./normalize.js";
import {
  CONSTRAINTS_VERSION, FIELD_CONSTRAINT_REGISTRY, FIELD_CONSTRAINT_REGISTRY_INFO,
  POLICY_CONTEXT as P, WRITE_OPERATIONS as O, WRITE_OPERATION_OPERANDS,
  assertFieldConstraintRegistry, getFieldConstraints, getFieldPolicy,
  assertFieldWriteOperation, listFieldWriteOperations, normalizeWriteOperand,
  getFieldClearResult, validateFinalWriteValue, resolveDynamicFieldPolicy,
  createDynamicFieldPolicy,
} from "./constraints.js";

test("UNLISTED has the same canonical read, filter, and write domain as the installed API", () => {
  const field=requireCanonicalField('product.status');
  for(const context of [P.READ,P.FILTER,P.WRITE]) {
    const constraints=getFieldConstraints(field.id,context);
    assert.equal(normalizeFieldValue(field,'UNLISTED',{constraints}),'UNLISTED');
    assert.throws(()=>normalizeFieldValue(field,'UNKNOWN',{constraints}),{code:C.INVALID_VALUE});
  }
  assert.equal(normalizeOperatorOperand(field,'eq','UNLISTED',{hasValue:true,constraints:getFieldConstraints(field.id,P.FILTER)}),'UNLISTED');
  assert.equal(normalizeWriteOperand(field.id,O.SET,'UNLISTED'),'UNLISTED');
});

test("versioned constraint registry covers every canonical field and is immutable", () => {
  assert.equal(CONSTRAINTS_VERSION, 5);
  assert.equal(assertFieldConstraintRegistry(), true);
  assert.equal(FIELD_CONSTRAINT_REGISTRY_INFO.fieldCount, Object.keys(CANONICAL_FIELDS).length);
  assert.ok(Object.isFrozen(FIELD_CONSTRAINT_REGISTRY));
  for (const id of Object.keys(CANONICAL_FIELDS)) {
    const entry = FIELD_CONSTRAINT_REGISTRY[id];
    assert.equal(entry.fieldId, id);
    assert.ok(Object.isFrozen(entry));
    for (const context of Object.values(P)) {
      assert.strictEqual(getFieldConstraints(id, context), entry[context]);
      assert.ok(Object.isFrozen(entry[context]));
    }
  }
});

test("read, filter and write policies remain separate", () => {
  const field = requireCanonicalField("product.title");
  const longTitle = "a".repeat(256);
  assert.equal(normalizeFieldValue(field, longTitle, { constraints: getFieldConstraints(field.id, P.READ) }), longTitle);
  assert.throws(() => normalizeOperatorOperand(field, "eq", longTitle, {
    constraints: getFieldConstraints(field.id, P.FILTER),
  }), { code: C.INVALID_VALUE });
  assert.throws(() => normalizeWriteOperand(field.id, O.SET, longTitle), { code: C.INVALID_VALUE });
  assert.equal(normalizeFieldValue(field, "", { constraints: getFieldConstraints(field.id, P.READ) }), "");
  assert.throws(() => normalizeWriteOperand(field.id, O.SET, ""), { code: C.INVALID_VALUE });
});

test("signed money stays valid for reads and filters while writes reject it", () => {
  const field = requireCanonicalField("variant.price");
  assert.equal(normalizeFieldValue(field, "-10", { constraints: getFieldConstraints(field.id) }), "-10");
  assert.equal(normalizeOperatorOperand(field, "lt", "-10", {
    constraints: getFieldConstraints(field.id, P.FILTER),
  }), "-10");
  assert.throws(() => normalizeWriteOperand(field.id, O.SET, "-10"), { code: C.INVALID_VALUE });
});

test("enum representation constraints are trusted and enforced", () => {
  for (const [id, allowed, forbidden] of [
    ["product.status", "ACTIVE", "active"],
    ["variant.inventoryPolicy", "DENY", "ALLOW"],
  ]) {
    assert.equal(normalizeWriteOperand(id, O.SET, allowed), allowed);
    assert.throws(() => normalizeWriteOperand(id, O.SET, forbidden), { code: C.INVALID_VALUE });
    assert.ok(Object.isFrozen(getFieldConstraints(id).enumValues));
  }
});

test("lookups reject invented IDs, descriptors and contexts", () => {
  for (const id of ["product.fakeField", { id: "product.title", editable: true }]) {
    assert.throws(() => getFieldConstraints(id), { code: C.UNKNOWN_FIELD });
    assert.throws(() => normalizeWriteOperand(id, O.SET, "Title"), { code: C.UNKNOWN_FIELD });
  }
  assert.throws(() => getFieldPolicy("product.title", "browser_policy"), { code: C.INVALID_VALUE });
});

test("operation metadata is immutable and has no write permissions in read or filter contexts", () => {
  for (const context of [P.READ, P.FILTER]) {
    const policy = getFieldPolicy("variant.price", context);
    assert.deepEqual(policy.operations, []);
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.operations));
  }
  assert.deepEqual(listFieldWriteOperations("product.title"), [O.SET]);
  assert.deepEqual(listFieldWriteOperations("variant.id"), []);
  assert.deepEqual(Object.keys(WRITE_OPERATION_OPERANDS).sort(), Object.values(O).sort());
});

test("read-only fields and unregistered operations fail closed", () => {
  assert.throws(() => assertFieldWriteOperation("variant.id", O.SET), { code: C.READ_ONLY });
  assert.throws(() => assertFieldWriteOperation("product.title", O.APPEND), { code: C.UNSUPPORTED_OPERATION });
  assert.throws(() => assertFieldWriteOperation("variant.price", "evaluate_sql"), { code: C.UNSUPPORTED_OPERATION });
});

test("CLEAR rejects supplied values and yields the registered result", () => {
  assert.equal(normalizeWriteOperand("product.vendor", O.CLEAR), undefined);
  for (const value of [null, "", [], false]) {
    assert.throws(() => normalizeWriteOperand("product.vendor", O.CLEAR, value), { code: C.INVALID_VALUE });
  }
  assert.equal(getFieldClearResult("product.vendor"), null);
  const tags = getFieldClearResult("product.tags");
  assert.deepEqual(tags, []);
  assert.ok(Object.isFrozen(tags));
  assert.throws(() => getFieldClearResult("product.title"), { code: C.UNSUPPORTED_OPERATION });
});

test("SET requires an operand and respects canonical types and write limits", () => {
  assert.throws(() => normalizeWriteOperand("product.title", O.SET), { code: C.INVALID_VALUE });
  assert.throws(() => normalizeWriteOperand("variant.taxable", O.SET, "true"), { code: C.INVALID_VALUE });
  assert.equal(normalizeWriteOperand("variant.taxable", O.SET, false), false);
  assert.equal(normalizeWriteOperand("product.vendor", O.SET, null), null);
  assert.equal(normalizeWriteOperand("variant.price", O.SET, "12.5000"), "12.5");
});

test("relative arithmetic uses nonnegative exact operands and rejects excess precision", () => {
  assert.equal(normalizeWriteOperand("variant.price", O.INCREASE, "1.2500"), "1.25");
  assert.equal(normalizeWriteOperand("variant.price", O.DECREASE, "150"), "150");
  for (const operand of ["-1", 1, "1e2", "01", "12.12345", "10000000000000000"]) {
    assert.throws(() => normalizeWriteOperand("variant.price", O.INCREASE, operand), { code: C.INVALID_VALUE });
  }
});

test("multipliers have a separate exact precision contract from money amounts", () => {
  assert.equal(normalizeWriteOperand("variant.price", O.MULTIPLY, "0.123456789012345678"), "0.123456789012345678");
  for (const operand of ["0.1234567890123456789", "1".repeat(39), "-0.1", 0.1]) {
    assert.throws(() => normalizeWriteOperand("variant.price", O.MULTIPLY, operand), { code: C.INVALID_VALUE });
  }
});

test("list mutations require nonempty, unique, bounded lists", () => {
  for (const operation of [O.ADD_ITEMS, O.REMOVE_ITEMS]) {
    const result = normalizeWriteOperand("product.tags", operation, ["Summer"]);
    assert.deepEqual(result, ["Summer"]);
    assert.ok(Object.isFrozen(result));
    for (const operand of [[], ["Summer", "Summer"], [1], Array(101).fill("tag"), new Array(1)]) {
      assert.throws(() => normalizeWriteOperand("product.tags", operation, operand), { code: C.INVALID_VALUE });
    }
  }
});

test("operand byte budget accounts for UTF-8 across complete lists", () => {
  // Each item fits the per-string limit, but together they exceed 64 KiB.
  const operand = Array.from({ length: 20 }, (_, i) => `${i}${"é".repeat(2000)}`);
  assert.throws(() => normalizeWriteOperand("product.tags", O.ADD_ITEMS, operand), { code: C.INVALID_VALUE });
});

test("list operand accessors, custom properties and overridden array methods never run", () => {
  const getter = ["tag"];
  Object.defineProperty(getter, "0", { get() { assert.fail("Getter executed"); } });
  const overridden = ["tag"];
  overridden.some = () => assert.fail("Overridden method executed");
  const inherited = ["tag"];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  for (const value of [getter, overridden, inherited]) {
    assert.throws(() => normalizeWriteOperand("product.tags", O.ADD_ITEMS, value), { code: C.INVALID_VALUE });
  }
});

test("final-value validation rejects a negative result despite a valid decrease operand", () => {
  assert.equal(normalizeWriteOperand("variant.price", O.DECREASE, "150"), "150");
  assert.throws(() => validateFinalWriteValue("variant.price", O.DECREASE, "-50"), { code: C.INVALID_VALUE });
  assert.equal(validateFinalWriteValue("variant.price", O.DECREASE, "0"), "0");
  assert.throws(() => validateFinalWriteValue("variant.price", O.MULTIPLY, "1.12345"), { code: C.INVALID_VALUE });
});

test("final lists must be unique and CLEAR must match its exact strategy", () => {
  assert.throws(() => validateFinalWriteValue("product.tags", O.SET, ["a", "a"]), { code: C.INVALID_VALUE });
  assert.deepEqual(validateFinalWriteValue("product.tags", O.CLEAR, []), []);
  assert.equal(validateFinalWriteValue("product.vendor", O.CLEAR, null), null);
  assert.throws(() => validateFinalWriteValue("product.vendor", O.CLEAR, ""), { code: C.INVALID_VALUE });
  assert.throws(() => validateFinalWriteValue("product.tags", O.CLEAR, ["a"]), { code: C.INVALID_VALUE });
});

function dynamicOptions(changes = {}) {
  const fieldId = "product.metafield.m01234567";
  return {
    shopId: "alpha.myshopify.com", fieldId, context: P.READ,
    trustedPolicyResolver: async () => createDynamicFieldPolicy({
      shopId: "alpha.myshopify.com", definitionToken: "Definition_token-123456",
      field: { id: fieldId, type: "string", nullable: true, editable: false, derived: false },
    }),
    ...changes,
  };
}

test("dynamic policy lookup forwards scoped identity and context without browser constraints", async () => {
  let received;
  const options = dynamicOptions();
  const expected = await options.trustedPolicyResolver();
  const result = await resolveDynamicFieldPolicy({
    ...options, constraints: { allowEmpty: true },
    trustedPolicyResolver: async input => { received = input; return expected; },
  });
  assert.deepEqual(received, { shopId: options.shopId, fieldId: options.fieldId, context: P.READ });
  assert.deepEqual(result, expected);
  assert.ok(Object.isFrozen(result));
});

test("dynamic policies require the trusted service, matching ownership and verification", async () => {
  await assert.rejects(() => resolveDynamicFieldPolicy(dynamicOptions({ trustedPolicyResolver: null })), { code: C.MISSING_DEPENDENCY });
  const options = dynamicOptions();
  const valid = await options.trustedPolicyResolver();
  for (const changes of [
    { shopId: "beta.myshopify.com" }, { fieldId: "product.metafield.m98765432" },
    { verified: false }, { definitionToken: "short" }, { field: { id: "product.title" } },
    { definitionToken: "a".repeat(257) }, { definitionToken: "invalid token with spaces" },
  ]) {
    await assert.rejects(() => resolveDynamicFieldPolicy({ ...options, trustedPolicyResolver: async () => ({ ...valid, ...changes }) }), { code: C.INVALID_DEFINITION });
  }
  await assert.rejects(() => resolveDynamicFieldPolicy({ ...options, context: P.WRITE }), { code: C.READ_ONLY });
});

test("dynamic policy entry cannot override canonical identities or use invalid shop identities", async () => {
  let called = false;
  const options = dynamicOptions({ trustedPolicyResolver: async () => { called = true; } });
  await assert.rejects(() => resolveDynamicFieldPolicy({ ...options, fieldId: "product.title" }), { code: C.UNKNOWN_FIELD });
  await assert.rejects(() => resolveDynamicFieldPolicy({ ...options, shopId: " bad " }), { code: C.INVALID_VALUE });
  assert.equal(called, false);
});

test("dynamic policy constraints and operations are validated despite a verified flag", async () => {
  const options = dynamicOptions();
  const valid = await options.trustedPolicyResolver();
  for (const changes of [
    { read: { maxItems: 10 } }, { filter: { maxLength: -1 } },
    { write: { allowNegative: false } }, { read: { column: "untrusted" } },
  ]) {
    await assert.rejects(() => resolveDynamicFieldPolicy({
      ...options, trustedPolicyResolver: async () => ({ ...valid, ...changes }),
    }), { code: C.INVALID_DEFINITION });
  }
  const editable = { ...valid.field, editable: true };
  assert.throws(() => createDynamicFieldPolicy({
    shopId: options.shopId, field: editable, definitionToken: valid.definitionToken,
    writePolicy: { operations: [O.INCREASE] },
  }), { code: C.INVALID_DEFINITION });
});

test("dynamic policy accessors are rejected without executing callbacks", async () => {
  const options = dynamicOptions();
  const valid = await options.trustedPolicyResolver();
  const bad = { ...valid };
  Object.defineProperty(bad, "verified", { get() { assert.fail("Getter executed"); } });
  await assert.rejects(() => resolveDynamicFieldPolicy({ ...options, trustedPolicyResolver: async () => bad }), { code: C.INVALID_DEFINITION });
});

test("FIELD-001: JSON dynamic field cannot be editable and rejects write policy", async () => {
  const options = dynamicOptions();
  const valid = await options.trustedPolicyResolver();
  const jsonField = { ...valid.field, type: "json", editable: true };
  assert.throws(() => createDynamicFieldPolicy({
    shopId: options.shopId, field: jsonField, definitionToken: valid.definitionToken,
  }), { code: C.INVALID_DEFINITION });

  const readOnlyJson = { ...valid.field, type: "json", editable: false };
  assert.throws(() => createDynamicFieldPolicy({
    shopId: options.shopId, field: readOnlyJson, definitionToken: valid.definitionToken,
    writePolicy: { operations: [O.SET] },
  }), { code: C.READ_ONLY });

  const editableNoPolicy = { ...valid.field, editable: true };
  assert.throws(() => createDynamicFieldPolicy({
    shopId: options.shopId, field: editableNoPolicy, definitionToken: valid.definitionToken,
    writePolicy: null,
  }), { code: C.INVALID_DEFINITION });
});
