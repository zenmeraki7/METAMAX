import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { verifyMirrorSqlSchema, assertVerifiedMirrorSchema, getVerifiedMirrorSchemaState,
  invalidateVerifiedMirrorSqlSchema, revalidateMirrorSqlSchema } from "../mirror-schema-verify.js";
import { catalogPool, physicalMapping, physicalColumn } from "./catalog-fixture.js";
import * as publicApi from "../index.js";
import * as serverSchema from "../../services/mirror-schema.server.js";
import * as schemaAdapter from "../mirror-schema-verify.js";

const options = fixture => ({ database: fixture.pool, schema: createMirrorSqlSchema(physicalMapping()),
  mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
  fieldMappings: [{ fieldId: "product.title", entity: "product", column: "title", type: "text" }] });

test("schema adapter delegates the declared contract to the real server implementation", () => {
  const exports = ["verifyMirrorSqlSchema", "assertVerifiedMirrorSqlSchema", "invalidateVerifiedMirrorSqlSchema",
    "assertPhysicalColumn", "assertVerifiedFieldBinding", "assertCursorOrdering", "revalidateMirrorSqlSchema"];
  assert.deepEqual(Object.keys(serverSchema).sort(), [...exports].sort());
  for (const name of exports) {
    assert.equal(typeof serverSchema[name], "function");
    if (name !== "verifyMirrorSqlSchema") assert.strictEqual(schemaAdapter[name], serverSchema[name]);
  }
});

test("requested verifier module shares private provenance and exposes only immutable metadata", async () => {
  const f = catalogPool({ title: physicalColumn("text") });
  const capability = await verifyMirrorSqlSchema(options(f));
  assert.strictEqual(assertVerifiedMirrorSchema(capability), capability);
  const view = getVerifiedMirrorSchemaState(capability);
  assert.equal(view.productsTable, '"mirror"."products"');
  assert.equal(view.columns["product.title"].column, "title");
  assert.throws(() => { view.columns["product.title"].column = "vendor"; }, TypeError);
  assert.throws(() => { view.columns["product.title"] = {}; }, TypeError);
  assert.equal(view.columns instanceof Map, false);
  assert.equal(Object.hasOwn(view, "database"), false);
  assert.throws(() => getVerifiedMirrorSchemaState({ ...capability }));
  assert.equal(Object.hasOwn(publicApi, "verifyMirrorSqlSchema"), false);
});

test("supplied db/namespace/revision/columns interface adapts to the consistent catalog verifier", async () => {
  const f = catalogPool({ title: physicalColumn("text") });
  const capability = await verifyMirrorSqlSchema({ db: f.pool, schema: createMirrorSqlSchema(physicalMapping()),
    namespace: "mirror", revision: "mirror_v1", sourceContractVersion: "sources_v1",
    columns: { "product.title": { entity: "product", column: "title", type: "text" } } });
  assert.equal(getVerifiedMirrorSchemaState(capability).revision, "mirror_v1");
  assert.equal(f.state.commands[0].sql.includes("REPEATABLE READ READ ONLY"), true);
  await assert.rejects(() => verifyMirrorSqlSchema({ db: { query() { assert.fail("Query-only adapter invoked"); } },
    schema: createMirrorSqlSchema(physicalMapping()), namespace: "mirror", revision: "mirror_v1",
    sourceContractVersion: "sources_v1", columns: {} }), /pool required/);
});

test("verification rejects incompatible field storage and mutable server metadata before querying", async () => {
  const f = catalogPool();
  for (const mapping of [
    { fieldId: "product.title", entity: "product", column: "title", type: "text[]" },
    { fieldId: "product.metafield.abcdefgh1234", entity: "product", column: "value", type: "text" },
    { fieldId: "inventoryItem.unitCost", entity: "inventoryItem", column: "value", type: "numeric" },
  ]) await assert.rejects(() => verifyMirrorSqlSchema({ ...options(f), fieldMappings: [mapping] }));
  const bad = options(f);
  Object.defineProperty(bad, "fieldMappings", { get() { assert.fail("Configuration getter executed"); } });
  await assert.rejects(() => verifyMirrorSqlSchema(bad));
  assert.equal(f.state.commands.length, 0);
});

test("explicit rechecks revoke drifted capabilities and migrations cannot revive old ones", async () => {
  const f = catalogPool({ title: physicalColumn("text") });
  const original = await verifyMirrorSqlSchema(options(f));
  f.state.tables.products.oid = "999";
  await assert.rejects(() => revalidateMirrorSqlSchema(original), { code: "FIELD_CONTRACT_MISMATCH" });
  assert.throws(() => assertVerifiedMirrorSchema(original));
  const replacement = await verifyMirrorSqlSchema(options(f));
  assertVerifiedMirrorSchema(replacement);
  invalidateVerifiedMirrorSqlSchema(replacement);
  assert.throws(() => assertVerifiedMirrorSchema(replacement));
});
