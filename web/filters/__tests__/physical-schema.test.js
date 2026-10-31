import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { verifyMirrorSqlSchema, assertVerifiedMirrorSqlSchema, assertPhysicalColumn, assertCursorOrdering, assertVerifiedFieldBinding, revalidateMirrorSqlSchema } from "../../services/mirror-schema.server.js";
import { catalogPool, physicalMapping, physicalColumn } from "./catalog-fixture.js";
import { FilterInfrastructureError } from "../errors.js";

const verify = fixture => verifyMirrorSqlSchema({ database: fixture.pool,
  schema: createMirrorSqlSchema(physicalMapping()), mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1" });

test("physical schema capability requires catalog types and indexes in a read-only snapshot", async () => {
  const f = catalogPool({ title: physicalColumn("text") });
  const capability = await verify(f);
  assert.strictEqual(assertVerifiedMirrorSqlSchema(capability), capability);
  assertPhysicalColumn(capability, "product", "title", "text");
  assert.throws(() => assertVerifiedMirrorSqlSchema({ ...capability }));
  assert.throws(() => assertVerifiedMirrorSqlSchema(createMirrorSqlSchema(physicalMapping())));
  assert.throws(() => assertPhysicalColumn(capability, "variant", "title", "text"));
  assert.throws(() => assertPhysicalColumn(capability, "product", "title", "boolean"));
  assert.ok(f.state.commands[0].sql.includes("READ ONLY"));
  assert.equal(f.state.commands.at(-1).sql, "COMMIT");
  assert.equal(f.state.released, 1);
  for (const query of f.state.commands.filter(query => query.parameters)) {
    assert.equal(query.sql.includes("$1"), true);
    assert.equal(query.sql.includes("$2"), true);
    assert.equal(query.sql.includes("pg_catalog."), true);
  }
});

test("nonexistent tables, incompatible identities and missing scoped indexes fail verification", async () => {
  const changes = [f => { delete f.state.tables.products; }, f => { delete f.state.tables.variants.columns.product_id; },
    f => { f.state.tables.products.columns.shop_id.type = "uuid"; },
    f => { f.state.tables.variants.columns.product_id.type = "int8"; },
    f => { f.state.tables.variants.columns.product_id.collation = "999"; },
    f => { f.state.tables.products.columns.id.notNull = false; },
    f => { f.state.tables.products.indexes[0].unique = false; },
    f => { f.state.tables.variants.indexes[0].columns = ["product_id"]; },
    f => { f.state.identifierLimit = "5"; }];
  for (const change of changes) {
    const f = catalogPool(); change(f);
    await assert.rejects(() => verify(f), { code: "FIELD_CONTRACT_MISMATCH" });
    assert.equal(f.state.commands.at(-1).sql, "ROLLBACK");
    assert.equal(f.state.released, 1);
  }
});

test("catalog drift and infrastructure failures cannot reuse bootstrap provenance", async () => {
  const f = catalogPool();
  const capability = await verify(f);
  f.state.tables.products.oid = "999";
  await assert.rejects(() => revalidateMirrorSqlSchema(capability), { code: "FIELD_CONTRACT_MISMATCH" });
  f.state.failure = new Error("private database details");
  await assert.rejects(() => verify(f), FilterInfrastructureError);
});

test("canonical approvals bind a field to its verified table/column and reject mutable descriptors", async () => {
  const f = catalogPool({ title: physicalColumn("text"), vendor: physicalColumn("text") });
  const fieldMappings = [{ fieldId: "product.title", entity: "product", column: "title", type: "text" }];
  const capability = await verifyMirrorSqlSchema({ database: f.pool, schema: createMirrorSqlSchema(physicalMapping()),
    mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", fieldMappings });
  fieldMappings[0].column = "vendor";
  assertVerifiedFieldBinding(capability, "product.title", "product", "title", "text");
  assert.throws(() => assertVerifiedFieldBinding(capability, "product.title", "product", "vendor", "text"));
  const getter = { fieldId: "product.title", entity: "product", column: "title", type: "text" };
  Object.defineProperty(getter, "column", { get() { assert.fail("Mapping getter executed"); } });
  await assert.rejects(() => verifyMirrorSqlSchema({ database: f.pool, schema: createMirrorSqlSchema(physicalMapping()),
    mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", fieldMappings: [getter] }));
});

test("cursor pagination requires index ordering and system C collation matching the encoder", async () => {
  const f = catalogPool();
  assertCursorOrdering(await verify(f));
  for (const changes of [index => { index.collations[2] = "public.C"; }, index => { index.columns = ["id", "shop_id", "generation_id"]; }]) {
    const fixture = catalogPool(); changes(fixture.state.tables.products.indexes[0]);
    const capability = await verify(fixture);
    assert.throws(() => assertCursorOrdering(capability), { code: "FIELD_CONTRACT_MISMATCH" });
  }
});
