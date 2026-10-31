import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorSqlSchema, assertMirrorSqlSchema, quoteIdentifier, quoteQualifiedTable } from "../mirror-schema.js";
import * as publicApi from "../index.js";

const mappings = () => ({
  products: { table: "SnapshotProduct", id: "id", shop: "shopId", generation: "generationId" },
  variants: { table: "SnapshotVariant", productId: "productId", shop: "shopId", generation: "generationId" },
});

test("schema records are independently captured, frozen and privately issued", () => {
  const raw = mappings(), schema = createMirrorSqlSchema(raw);
  assert.strictEqual(assertMirrorSqlSchema(schema), schema);
  for (const value of [schema, schema.products, schema.variants]) assert.ok(Object.isFrozen(value));
  raw.products.table = "ChangedTable";
  assert.equal(schema.products.table, "SnapshotProduct");
  assert.throws(() => { schema.products.shop = "otherShop"; }, TypeError);
  for (const forged of [raw, { ...schema }, structuredClone(schema), null]) assert.throws(() => assertMirrorSqlSchema(forged));
  assert.equal(Object.hasOwn(publicApi, "createMirrorSqlSchema"), false);
});

test("identifiers enforce allowlisting and the 63-byte boundary", () => {
  assert.equal(quoteIdentifier("x".repeat(63)), `"${"x".repeat(63)}"`);
  for (const value of ["", "x".repeat(64), "table;SELECT1", 'table"', "public.products", " table", "a\n", "1table", "കേരളം", null]) {
    assert.throws(() => quoteIdentifier(value));
    assert.throws(() => createMirrorSqlSchema({ ...mappings(), products: { ...mappings().products, table: value } }));
  }
});

test("schema qualification quotes namespace and table independently", () => {
  const raw = mappings();
  raw.products.schema = "mirror"; raw.variants.schema = "mirror";
  const schema = createMirrorSqlSchema(raw);
  assert.equal(quoteQualifiedTable(schema.products.schema, schema.products.table), '"mirror"."SnapshotProduct"');
  assert.throws(() => quoteQualifiedTable("mirror;SET search_path=evil", "SnapshotProduct"));
  assert.throws(() => quoteQualifiedTable("mirror", "other.SnapshotProduct"));
});

test("mapping records reject missing keys, extras, symbols, prototypes and column collisions", () => {
  const missing = mappings(); delete missing.products.id;
  const cases = [missing, { ...mappings(), extra: true }, Object.assign(mappings(), { [Symbol("extra")]: true }),
    { ...mappings(), products: { ...mappings().products, id: "shopId" } },
    { ...mappings(), variants: { ...mappings().variants, generation: "productId" } },
    { ...mappings(), products: { ...mappings().products, extra: "column" } },
    { ...mappings(), variants: Object.assign(Object.create({}), mappings().variants) },
    [], null];
  for (const raw of cases) assert.throws(() => createMirrorSqlSchema(raw));
});

test("root and nested getters are rejected without execution", () => {
  for (const root of [true, false]) {
    const raw = mappings();
    Object.defineProperty(root ? raw : raw.products, root ? "products" : "table", {
      get() { assert.fail("Untrusted getter executed"); },
    });
    assert.throws(() => createMirrorSqlSchema(raw));
  }
});
