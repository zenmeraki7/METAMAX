import { test } from "node:test";
import assert from "node:assert/strict";
import { compileProductQuery, listSqlFields } from "../../query/index.js";
import { createMetafieldRegistry, resolveField } from "../../fields/index.js";
const context = { shopId: "example.myshopify.com", generation: "generation-1", snapshotId: "snapshot-1",
  authorized: true, scopes: ["read_products"], completedDatasets: ["products"], coverageReady: true };
const predicate = (field = "product.title", operator = "eq", value = "Summer") => ({ type: "predicate", field, operator, value });
const fails = (fn, code) => assert.throws(fn, { code });
test("merchant values and tenant fences are parameters with stable query text", () => {
  const attack = "x'; DROP TABLE Shop; --";
  const query = compileProductQuery(predicate("product.title", "eq", attack), context);
  assert.equal(query.text.includes(attack), false);
  assert.deepEqual(query.values, [context.shopId, context.generation, context.snapshotId, attack, 100]);
  assert.equal(query.text, compileProductQuery(predicate(), context).text);
  assert.match(query.text, /s\."activeSnapshotId"=r\."id"/);
  assert.match(query.text, /s\."generation"=r\."generation"/);
  assert.match(query.text, /r\."status"='COMPLETED'/);
  assert.match(query.text, /s\."installationVerified"=true/);
  assert.equal(Object.isFrozen(query.values), true);
});
test("only genuine field/source identities with implemented SQL adapters compile", () => {
  assert.equal(listSqlFields().length, 8);
  assert.ok(compileProductQuery(predicate(resolveField("product.product_type")), context).text.includes("->>'productType'"));
  for (const field of ["variant.price", "product.totalInventory", "product.variantCount", "product.createdAt", "inventoryItem.sku"])
    fails(() => compileProductQuery(predicate(field), context), "UNSUPPORTED_SQL_SOURCE");
  const dynamic = createMetafieldRegistry(context.shopId, [{ owner: "product", namespace: "custom", key: "color", type: "single_line_text_field" }]).list()[0];
  fails(() => compileProductQuery(predicate(dynamic), context), "UNSUPPORTED_SQL_SOURCE");
  for (const field of ["product.title); DELETE FROM Shop;--", { ...resolveField("product.title") }])
    fails(() => compileProductQuery(predicate(field), context), "UNKNOWN_FIELD");
});
test("operators, nested trees and arrays are bounded and type checked", () => {
  const tree = { type: "or", children: [predicate("product.status", "in", ["active", "DRAFT"]),
    { type: "not", child: predicate("product.tracksInventory", "eq", "FALSE") }] };
  const query = compileProductQuery(tree, context);
  assert.deepEqual(query.values.slice(3), ["ACTIVE", "DRAFT", false, 100]);
  assert.match(query.text, /AND \(\(/);
  assert.match(query.text, / OR /);
  const tags = compileProductQuery(predicate("product.tags", "contains_all", [" Sale ", "Winter"]), context);
  assert.match(tags.text, /\?& \$4::text\[\]/);
  assert.deepEqual(tags.values[3], ["Sale", "Winter"]);
  fails(() => compileProductQuery(predicate("product.status", "eq", "DELETED"), context), "INVALID_ENUM");
  fails(() => compileProductQuery(predicate("product.title", "raw", "SQL"), context), "UNSUPPORTED_QUERY_OPERATOR");
  fails(() => compileProductQuery(predicate("product.title", "in", []), context), "INVALID_QUERY");
  fails(() => compileProductQuery(predicate("product.title", "in", new Array(1)), context), "INVALID_QUERY_OPERAND");
  let node = predicate(); for (let i = 0; i < 10; i++) node = { type: "not", child: node };
  fails(() => compileProductQuery(node, context), "QUERY_TOO_COMPLEX");
});
test("literal LIKE wildcards, cursor and limit are bound instead of inserted into SQL", () => {
  const query = compileProductQuery(predicate("product.title", "contains", "50%_off!"), context,
    { limit: 25, after: "gid://shopify/Product/123" });
  assert.equal(query.values[3], "%50!%!_off!!%");
  assert.deepEqual(query.values.slice(4), ["gid://shopify/Product/123", 25]);
  fails(() => compileProductQuery(null, context, { limit: 251 }), "INVALID_QUERY_LIMIT");
  fails(() => compileProductQuery(null, context, { sort: 'title;--' }), "INVALID_QUERY");
});
test("missing authorization, stale-shaped contexts, unsupported properties and getters fail closed", () => {
  fails(() => compileProductQuery(null, { ...context, authorized: false }), "QUERY_ACCESS_DENIED");
  fails(() => compileProductQuery(null, { ...context, snapshotId: null }), "QUERY_CONTEXT_REQUIRED");
  fails(() => compileProductQuery(null, { ...context, completedDatasets: [] }), "QUERY_ACCESS_DENIED");
  fails(() => compileProductQuery({ ...predicate(), sql: "OR true" }, context), "INVALID_QUERY");
  let invoked = false;
  const malicious = { type: "predicate", get field() { invoked = true; return "product.title"; }, operator: "eq", value: "x" };
  fails(() => compileProductQuery(malicious, context), "INVALID_FIELD_INPUT");
  assert.equal(invoked, false);
  assert.deepEqual(compileProductQuery(null, context).values, [context.shopId, context.generation, context.snapshotId, 100]);
});
