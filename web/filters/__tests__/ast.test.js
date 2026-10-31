import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFilterAst, inspectFilterAst, serializeFilterAst, FilterAstError,
  FILTER_AST_LIMITS as L, FILTER_AST_ERROR_CODES as E, FILTER_AST_INFO,
} from "../ast.js";

const condition = (changes = {}) => ({ kind: "condition", field: "product.title", operator: "eq", value: "Summer", ...changes });
const ast = (root = condition()) => ({ version: 1, root });
const group = (children, operator = "AND") => ({ kind: "group", operator, children });
const reject = (value, code) => assert.throws(() => parseFilterAst(value), error =>
  error instanceof FilterAstError && error.status === 400 && (!code || error.code === code));

test("parser creates an independent immutable tree and caches trusted results", () => {
  const input = ast(group([condition({ value: ["one", { nested: true }] })]));
  const parsed = parseFilterAst(input);
  input.root.children[0].value[1].nested = false;
  assert.equal(parsed.root.children[0].value[1].nested, true);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.root.children));
  assert.ok(Object.isFrozen(parsed.root.children[0].value[1]));
  assert.strictEqual(parseFilterAst(parsed), parsed);
  assert.strictEqual(inspectFilterAst(parsed), inspectFilterAst(parsed));
});

test("inspection reports exact nodes, depth, bytes and sorted distinct fields", () => {
  const input = ast(group([
    condition({ field: "variant.price" }),
    group([condition(), condition()], "OR"),
  ]));
  const info = inspectFilterAst(input);
  assert.equal(info.nodes, 5);
  assert.equal(info.conditions, 3);
  assert.equal(info.groups, 2);
  assert.equal(info.maxDepth, 3);
  assert.equal(info.uniqueFields, 2);
  assert.deepEqual(info.fieldIds, ["product.title", "variant.price"]);
  assert.equal(info.byteSize, Buffer.byteLength(serializeFilterAst(input), "utf8"));
  assert.ok(Object.isFrozen(info.fieldIds));
});

test("serialization round-trips deterministically and preserves child order", () => {
  const input = ast(group([condition(), condition({ field: "product.vendor" })]));
  const text = serializeFilterAst(input);
  assert.equal(serializeFilterAst(JSON.parse(text)), text);
  assert.notEqual(serializeFilterAst(ast(group([...input.root.children].reverse()))), text);
});

test("syntax accepts opaque dynamic IDs and leaves authorization and compatibility to later stages", () => {
  assert.equal(parseFilterAst(ast(condition({ field: "product.metafield.m01234567" }))).root.field, "product.metafield.m01234567");
  assert.equal(parseFilterAst(ast(condition({ field: "product.notRegistered", operator: "not_registered" }))).root.operator, "not_registered");
  assert.equal(FILTER_AST_INFO.executionComplexityValidatedHere, false);
  assert.ok(Object.isFrozen(FILTER_AST_INFO.nodeKinds));
  assert.ok(Object.isFrozen(FILTER_AST_INFO.groupOperators));
});

test("presence of operand is preserved independently of null", () => {
  const node = condition(); delete node.value;
  assert.equal(Object.hasOwn(parseFilterAst(ast(node)).root, "value"), false);
  assert.equal(parseFilterAst(ast(condition({ value: null }))).root.value, null);
  reject(ast(condition({ value: undefined })), E.INVALID_VALUE);
});

test("finite JSON-compatible numbers reject negative zero and unsafe integers", () => {
  reject(ast(condition({ value: -0 })), E.INVALID_VALUE);
  assert.equal(parseFilterAst(ast(condition({ value: 1.25 }))).root.value, 1.25);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    reject(ast(condition({ value })), E.INVALID_VALUE);
  }
});

test("invalid roots, versions, nodes and unknown properties fail closed", () => {
  for (const value of [null, [], "{}", {}, { version: 1 }, ast({}), ast(condition({ sql: "SELECT" }))]) reject(value);
  reject({ version: 2, root: condition() }, E.UNSUPPORTED_VERSION);
  reject(ast(condition({ kind: "raw_sql" })), E.INVALID_NODE);
  reject({ ...ast(), shop: "forged" }, E.INVALID_AST);
});

test("logical groups are nonempty and NOT has exactly one child", () => {
  assert.equal(parseFilterAst(ast(group([condition()], "NOT"))).root.operator, "NOT");
  for (const node of [group([]), group([condition()], "and"), group([condition(), condition()], "NOT")]) {
    reject(ast(node), E.INVALID_NODE);
  }
});

test("field and operator identifiers cannot contain expressions or forged descriptors", () => {
  for (const field of ["products.title; DROP TABLE products", { id: "product.title" }, "a".repeat(161)]) {
    reject(ast(condition({ field })), E.INVALID_NODE);
  }
  for (const operator of ["EQ", "eq OR TRUE", "x".repeat(65), {}]) reject(ast(condition({ operator })), E.INVALID_NODE);
});

test("getters and toJSON functions are rejected without execution", () => {
  const node = condition();
  Object.defineProperty(node, "field", { get() { assert.fail("Getter executed"); } });
  reject(ast(node), E.INVALID_AST);
  reject(ast(condition({ value: { toJSON() { assert.fail("toJSON executed"); } } })), E.INVALID_VALUE);
  const root = ast();
  Object.defineProperty(root, "version", { get() { assert.fail("Version getter executed"); } });
  reject(root, E.INVALID_AST);
});

test("prototype pollution keys, symbols and custom prototypes are prohibited", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const value = Object.create(null); value[key] = "unsafe";
    reject(ast(condition({ value })), E.INVALID_VALUE);
  }
  const node = condition(); node[Symbol("extra")] = true;
  reject(ast(node), E.INVALID_AST);
  reject(ast(Object.assign(Object.create({ inherited: true }), condition())), E.INVALID_NODE);
});

test("arrays reject sparse elements, properties, symbols, accessors and custom prototypes", () => {
  const getter = ["value"];
  Object.defineProperty(getter, "0", { get() { assert.fail("Array getter executed"); } });
  const symbol = ["value"]; symbol[Symbol("extra")] = true;
  const custom = ["value"]; Object.setPrototypeOf(custom, Object.create(Array.prototype));
  for (const value of [new Array(1), Object.assign(["value"], { extra: true }), getter, symbol, custom]) {
    reject(ast(condition({ value })), E.INVALID_AST);
  }
  reject(ast(group(new Array(1))), E.INVALID_AST);
});

test("cycles and shared references cannot impersonate independent tree nodes", () => {
  const cyclic = group([]); cyclic.children.push(cyclic);
  reject(ast(cyclic), E.INVALID_AST);
  const shared = condition(); reject(ast(group([shared, shared])), E.INVALID_AST);
  const value = {}; value.self = value;
  reject(ast(condition({ value })), E.INVALID_AST);
  const item = {}; reject(ast(condition({ value: [item, item] })), E.INVALID_AST);
});

test("unsupported runtime objects and functions are not JSON operands", () => {
  for (const value of [1n, Symbol("x"), () => 1, new Date(), new Map(), new Set()]) {
    reject(ast(condition({ value })), E.INVALID_VALUE);
  }
});

test("node and tree-depth limits accept their boundary and reject excess", () => {
  assert.equal(inspectFilterAst(ast(group(Array.from({ length: L.MAX_NODES - 1 }, () => condition())))).nodes, L.MAX_NODES);
  reject(ast(group(Array.from({ length: L.MAX_NODES }, () => condition()))), E.LIMIT_EXCEEDED);
  let node = condition();
  for (let i = 1; i < L.MAX_DEPTH; i++) node = group([node]);
  assert.equal(inspectFilterAst(ast(node)).maxDepth, L.MAX_DEPTH);
  reject(ast(group([node])), E.LIMIT_EXCEEDED);
});

test("operand size, key count, array length and nesting bounds are enforced", () => {
  reject(ast(condition({ value: "é".repeat(L.MAX_VALUE_STRING_BYTES / 2 + 1) })), E.LIMIT_EXCEEDED);
  reject(ast(condition({ value: Array(101).fill(null) })), E.INVALID_AST);
  reject(ast(condition({ value: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, i])) })), E.LIMIT_EXCEEDED);
  reject(ast(condition({ value: { ["é".repeat(129)]: true } })), E.INVALID_VALUE);
  let value = null;
  for (let i = 0; i < L.MAX_VALUE_DEPTH + 1; i++) value = [value];
  reject(ast(condition({ value })), E.LIMIT_EXCEEDED);
});

test("complete serialized size includes JSON escaping and container syntax", () => {
  reject(ast(condition({ value: "\u0000".repeat(22000) })), E.LIMIT_EXCEEDED);
  const emptyContainers = Array.from({ length: 5 }, () =>
    Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => [])));
  reject(ast(condition({ value: emptyContainers })), E.LIMIT_EXCEEDED);
});

function makeAst(field, value = "Nike") {
  return {
    version: 1,
    root: { kind: "condition", field, operator: "eq", value },
  };
}

test("accepts valid canonical field", () => {
  assert.equal(parseFilterAst(makeAst("product.title")).root.field, "product.title");
});

for (const field of [
  "Product.title", "product..title", "product.title-foo", "product.",
]) {
  test(`rejects invalid field: ${field}`, () => {
    assert.throws(() => parseFilterAst(makeAst(field)));
  });
}

test("accepts opaque dynamic metafield ID", () => {
  const field = "product.metafield.abcdefgh1234";
  assert.equal(parseFilterAst(makeAst(field)).root.field, field);
});

test("rejects negative zero", () => {
  reject(makeAst("variant.price", -0), E.INVALID_VALUE);
  assert.match(serializeFilterAst(makeAst("variant.price", 0)), /"value":0/);
});

test("rejects nested negative zero", () => {
  reject(makeAst("product.tags", [-0]), E.INVALID_VALUE);
  reject(makeAst("product.tags", [{ n: -0 }]), E.INVALID_VALUE);
});

test("preserves exact decimal strings", () => {
  assert.equal(parseFilterAst(makeAst("variant.price", "0.00")).root.value, "0.00");
});

test("rejects unsafe integers", () => {
  assert.throws(() => parseFilterAst(makeAst("variant.price", Number.MAX_SAFE_INTEGER + 1)));
});

test("rejects oversized serialized AST", () => {
  assert.throws(() => parseFilterAst(makeAst("product.title", "x".repeat(L.MAX_BYTES))));
});

test("rejects cyclic references", () => {
  const value = {}; value.self = value;
  assert.throws(() => parseFilterAst(makeAst("product.title", value)));
});

test("rejects shared references", () => {
  const shared = { x: 1 };
  assert.throws(() => parseFilterAst(makeAst("product.title", [shared, shared])));
});

test("rejects accessor-backed operands", () => {
  let called = false;
  const value = {};
  Object.defineProperty(value, "test", {
    enumerable: true,
    get() { called = true; return 1; },
  });
  assert.throws(() => parseFilterAst(makeAst("product.title", value)));
  assert.equal(called, false);
});

test("does not call untrusted toJSON", () => {
  let called = false;
  const input = makeAst("product.title");
  input.toJSON = () => { called = true; return {}; };
  assert.throws(() => parseFilterAst(input));
  assert.equal(called, false);
});

test("rejects prototype pollution", () => {
  assert.throws(() => parseFilterAst(makeAst("product.title", JSON.parse('{"__proto__":{"admin":true}}'))));
});

test("reuses trusted AST", () => {
  const parsed = parseFilterAst(makeAst("product.title"));
  assert.strictEqual(parseFilterAst(parsed), parsed);
  assert.strictEqual(inspectFilterAst(parsed), inspectFilterAst(parsed));
});

test("serialized byte size is exact", () => {
  const parsed = parseFilterAst(makeAst("product.title", "കേരളം"));
  assert.equal(inspectFilterAst(parsed).byteSize, Buffer.byteLength(serializeFilterAst(parsed), "utf8"));
});

test("distinguishes missing and null operands", () => {
  const missing = parseFilterAst({
    version: 1,
    root: { kind: "condition", field: "product.title", operator: "is_empty" },
  });
  const explicitNull = parseFilterAst(makeAst("product.title", null));
  assert.equal(Object.hasOwn(missing.root, "value"), false);
  assert.equal(Object.hasOwn(explicitNull.root, "value"), true);
});

test("supported field syntax preserves the legacy canonical limit", () => {
  const atLimit = `product.${"a".repeat(120)}`;
  for (const field of [atLimit, "product.metafield.short", "product.metafield.namespace.key"]) {
    assert.equal(parseFilterAst(makeAst(field)).root.field, field);
  }
  reject(makeAst(`${atLimit}a`), E.INVALID_NODE);
});

test("field identifiers contribute to the request-wide serialized byte budget", () => {
  const field = `product.${"a".repeat(120)}`;
  const input = ast(group(Array.from({ length: 900 }, () => condition({ field, value: null }))));
  reject(input, E.LIMIT_EXCEEDED);
});

test("rejects malformed Unicode in scalar and nested string operands and object keys", () => {
  for (const value of ["\ud800", "\udfff", "x\ud800y"]) {
    reject(makeAst("product.title", value), E.INVALID_VALUE);
    reject(makeAst("product.title", [value]), E.INVALID_VALUE);
    reject(makeAst("product.title", { [value]: "text" }), E.INVALID_VALUE);
  }
  reject(makeAst("product.\ud800", "text"), E.INVALID_NODE);
  reject(ast(condition({ operator: "eq\ud800" })), E.INVALID_NODE);
});

test("valid astral Unicode and Malayalam preserve exact UTF-8 byte accounting", () => {
  for (const value of ["🙂 കേരളം", { "🙂": "മലയാളം" }]) {
    const parsed = parseFilterAst(makeAst("product.title", value));
    assert.equal(inspectFilterAst(parsed).byteSize, Buffer.byteLength(serializeFilterAst(parsed), "utf8"));
  }
  assert.equal(parseFilterAst(makeAst("product.title", "-0")).root.value, "-0");
});
