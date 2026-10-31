import test from "node:test";
import assert from "node:assert/strict";
import { serializeCanonicalFilter, FILTER_SERIALIZATION_VERSION } from "../serialization.js";
import { fingerprintFilter, fingerprintBoundFilter, fingerprintFilterAst, fingerprintFilterExecution } from "../fingerprint.js";
import { serializeFilterAst } from "../ast.js";

const ast = value => ({ version: 1, root: { kind: "condition", field: "product.title", operator: "eq", value } });
const binding = () => ({
  shopId: "alpha.myshopify.com", operation: "filter", operationId: "operation123",
  generationId: "generation123", coverageRevision: "revision123", registryVersion: "registry123",
  targetingSnapshotId: null,
});

test("canonical serialization sorts operand object keys independently of AST structure", () => {
  const a = ast({ z: [1, { b: true, a: false }], a: "x" });
  const b = ast({ a: "x", z: [1, { a: false, b: true }] });
  assert.notEqual(serializeFilterAst(a), serializeFilterAst(b));
  assert.equal(serializeCanonicalFilter(a), serializeCanonicalFilter(b));
  assert.equal(fingerprintFilter(a), fingerprintFilter(b));
  assert.equal(JSON.parse(serializeCanonicalFilter(a)).serializationVersion, FILTER_SERIALIZATION_VERSION);
});

test("fingerprints preserve array and logical child order without claiming semantic equivalence", () => {
  assert.notEqual(fingerprintFilter(ast(["a", "b"])), fingerprintFilter(ast(["b", "a"])));
  const children = [ast("a").root, ast("b").root];
  const group = children => ({ version: 1, root: { kind: "group", operator: "AND", children } });
  assert.notEqual(fingerprintFilter(group(children)), fingerprintFilter(group([...children].reverse())));
});

test("canonical identity preserves exact decimal strings, missing and null values", () => {
  assert.notEqual(fingerprintFilter(ast("0.00")), fingerprintFilter(ast("0")));
  assert.throws(() => fingerprintFilter(ast(-0)));
  const missing = ast(null); delete missing.root.value;
  assert.notEqual(fingerprintFilter(missing), fingerprintFilter(ast(null)));
  assert.notEqual(fingerprintFilter(ast("കേരളം")), fingerprintFilter(ast("മലയാളം")));
});

test("bound fingerprints include shop, operation, snapshot and registry identity", () => {
  const input = ast("x");
  const original = fingerprintBoundFilter(input, binding());
  assert.match(original, /^[a-f0-9]{64}$/);
  for (const key of Object.keys(binding())) {
    const changed = { ...binding(), [key]: key === "targetingSnapshotId" ? "target123" : key === "operation" ? "export" : `changed_${key}` };
    assert.notEqual(fingerprintBoundFilter(input, changed), original);
  }
  assert.notEqual(original, fingerprintFilter(input));
});

test("binding property insertion order does not change canonical identity", () => {
  const original = binding();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(fingerprintBoundFilter(ast("x"), original), fingerprintBoundFilter(ast("x"), reordered));
});

test("serialization and fingerprinting never execute untrusted getters or toJSON", () => {
  const raw = ast("x"); raw.toJSON = () => assert.fail("toJSON executed");
  assert.throws(() => serializeCanonicalFilter(raw));
  const bad = binding();
  Object.defineProperty(bad, "shopId", { get() { assert.fail("Getter executed"); } });
  assert.throws(() => fingerprintBoundFilter(ast("x"), bad));
  assert.throws(() => fingerprintBoundFilter(ast("x"), { ...binding(), actor: "forged" }));
});

function execution(input = ast("x"), changes = {}) {
  return { ast: input, shopId: "alpha.myshopify.com", operation: "filter", generationId: "generation123",
    coverageRevision: "revision123", validationVersion: 1, astVersion: 1, canonicalVersion: 1,
    operatorVersion: 1, bindingVersion: 2, definitionRevisions: [], ...changes };
}
const dynamicId = "product.metafield.abcdefgh1234";
const dynamicAst = () => ({ version: 1, root: { kind: "condition", field: dynamicId, operator: "eq", value: "cotton" } });
const revision = (fieldId = dynamicId, definitionToken = "Definition_token-123456") => ({ fieldId, definitionToken });

test("named AST and execution identities remain separate and support real shop domains", () => {
  assert.strictEqual(fingerprintFilter, fingerprintFilterAst);
  const options = execution();
  assert.match(fingerprintFilterExecution(options), /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprintFilterAst(options.ast), fingerprintFilterExecution(options));
  assert.notEqual(fingerprintFilterExecution(options), fingerprintFilterExecution({ ...options, operation: "export" }));
  assert.throws(() => fingerprintFilterExecution({ ...options, operation: "browser_operation" }));
  assert.throws(() => fingerprintFilterExecution({ ...options, shopId: "alpha\n.myshopify.com" }));
});

test("shop identity validation permits domains without weakening revision tokens", () => {
  for (const shopId of ["example-store.myshopify.com", "internal_shop-123", "x".repeat(255)]) {
    assert.match(fingerprintFilterExecution(execution(ast("x"), { shopId })), /^[a-f0-9]{64}$/);
  }
  for (const shopId of [null, 123, "", " ", " leading.myshopify.com", "trailing.myshopify.com ",
    "x".repeat(256), "shop\u0000.myshopify.com", "shop\u007f.myshopify.com"]) {
    assert.throws(() => fingerprintFilterExecution(execution(ast("x"), { shopId })), /shop identity/);
  }
  assert.throws(() => fingerprintFilterExecution(execution(dynamicAst(), {
    definitionRevisions: [revision(dynamicId, "revision.with.periods")],
  })), /Invalid definition token/);
  assert.throws(() => fingerprintFilterExecution(execution(ast("x"), { coverageRevision: "coverage.with.periods" })));
});

test("execution approval identity and phase are separate fingerprint inputs", () => {
  const options = execution(ast("x"), { operation: "bulk_edit", executionContractId: "contract123", approvalRevision: "approval123" });
  const original = fingerprintFilterExecution(options);
  for (const changes of [{ executionContractId: "otherContract" }, { approvalRevision: "newRevision" }, { phase: "preview" }]) {
    assert.notEqual(fingerprintFilterExecution({ ...options, ...changes }), original);
  }
  assert.throws(() => fingerprintFilterExecution({ ...options, phase: "untrusted" }));
});

test("definition token lengths match the resolver and adapter contract", () => {
  for (const length of [16, 256]) {
    assert.match(fingerprintFilterExecution(execution(dynamicAst(), {
      definitionRevisions: [revision(dynamicId, "a".repeat(length))],
    })), /^[a-f0-9]{64}$/);
  }
  for (const length of [0, 1, 15, 257]) {
    assert.throws(() => fingerprintFilterExecution(execution(dynamicAst(), {
      definitionRevisions: [revision(dynamicId, "a".repeat(length))],
    })), /Invalid definition token/);
  }
});

test("execution identity changes with every code contract version", () => {
  const options = execution();
  const original = fingerprintFilterExecution(options);
  for (const key of ["validationVersion", "canonicalVersion", "operatorVersion", "bindingVersion", "normalizationVersion", "constraintsVersion"]) {
    assert.notEqual(fingerprintFilterExecution({ ...options, [key]: 999 }), original);
    for (const value of [0, -1, 1.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => fingerprintFilterExecution({ ...options, [key]: value }));
    }
  }
  assert.throws(() => fingerprintFilterExecution({ ...options, astVersion: 2 }));
});

test("dynamic revision coverage exactly matches AST references", () => {
  const input = dynamicAst();
  const good = execution(input, { definitionRevisions: [revision()] });
  assert.match(fingerprintFilterExecution(good), /^[a-f0-9]{64}$/);
  assert.throws(() => fingerprintFilterExecution(execution(input)));
  assert.throws(() => fingerprintFilterExecution({ ...good, definitionRevisions: [] }));
  assert.throws(() => fingerprintFilterExecution(execution(ast("x"), { definitionRevisions: [revision()] })));
  assert.throws(() => fingerprintFilterExecution({ ...good, definitionRevisions: [revision("variant.metafield.abcdefgh1234")] }));
  assert.notEqual(fingerprintFilterExecution(good), fingerprintFilterExecution({ ...good,
    definitionRevisions: [revision(dynamicId, "Definition_token-987654")],
  }));
  assert.throws(() => fingerprintBoundFilter(input, binding()));
  assert.match(fingerprintBoundFilter(input, { ...binding(), definitionRevisions: [revision()] }), /^[a-f0-9]{64}$/);
});

test("revision order is ordinal, locale-independent and duplicate AST fields require one revision", t => {
  t.mock.method(String.prototype, "localeCompare", () => assert.fail("Locale-dependent sorting used"));
  const first = "product.metafield.aB123456", second = "product.metafield.aa123456";
  const input = { version: 1, root: { kind: "group", operator: "AND", children: [
    { ...dynamicAst().root, field: first }, { ...dynamicAst().root, field: second }, { ...dynamicAst().root, field: first },
  ] } };
  const options = execution(input, { definitionRevisions: [revision(second), revision(first)] });
  assert.equal(fingerprintFilterExecution(options), fingerprintFilterExecution({ ...options, definitionRevisions: [revision(first), revision(second)] }));
});

test("revision arrays reject excessive, sparse, accessor-backed and decorated arrays", () => {
  const input = dynamicAst();
  const getter = [revision()];
  Object.defineProperty(getter, "0", { get() { assert.fail("Array getter executed"); } });
  for (const definitionRevisions of [null, {}, new Array(1), getter, Array(1001).fill(revision()),
    Object.assign([revision()], { extra: true }), [revision(), revision()]]) {
    assert.throws(() => fingerprintFilterExecution(execution(input, { definitionRevisions })));
  }
});

test("revision descriptors reject extra keys, malformed IDs and accessors without running them", () => {
  const accessor = revision();
  Object.defineProperty(accessor, "definitionToken", { get() { assert.fail("Revision getter executed"); } });
  for (const entry of [accessor, { ...revision(), extra: true }, revision("product.title"), revision("product.metafield.short"),
    revision(dynamicId, "bad token"), new Date(), { fieldId: dynamicId }]) {
    assert.throws(() => fingerprintFilterExecution(execution(dynamicAst(), { definitionRevisions: [entry] })));
  }
  const options = execution();
  Object.defineProperty(options, "shopId", { get() { assert.fail("Options getter executed"); } });
  assert.throws(() => fingerprintFilterExecution(options));
});
