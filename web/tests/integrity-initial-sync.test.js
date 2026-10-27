import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { registerShopInTransaction } from "../domains/lifecycle/lifecycle.repository.js";
import { repairVariantProjection } from "../scripts/repair-variant-projection.js";

if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const namespace = `integrity_test_${randomUUID().replaceAll("-", "")}`;
const root = new URL("../prisma/migrations/", import.meta.url);
const sql = (name) => readFileSync(new URL(`${name}/migration.sql`, root), "utf8");
let client, db;
const names = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^20261025\d+_/.test(entry.name))
  .map((entry) => entry.name).sort();
const baseline = names.filter((name) => name < "202610250011");
const newMigrations = names.filter((name) => name >= "202610250011" && name <= "202610250012_inventory_repair_schedules");
async function migrate(name) {
  // Test-only namespace substitution. No application tables or history change.
  const source = sql(name).replaceAll('"public"', `"${namespace}"`).replaceAll("public.shopify_sessions", `${namespace}.shopify_sessions`);
  await client.query("BEGIN");
  try { await client.query(source); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function fixture(shop, { verified = true, status = "NOT_STARTED", installationGeneration = "g", installationStatus = "ACTIVE" } = {}) {
  await client.query('INSERT INTO "Shop" (domain,generation,"installationVerified","updatedAt") VALUES ($1,\'g\',$2,now())', [shop, verified]);
  await client.query('INSERT INTO "CatalogSyncState" (shop,generation,status,"updatedAt") VALUES ($1,\'g\',$2,now())', [shop, status]);
  await client.query('INSERT INTO "InstallationState" ("shopHash",generation,status,"updatedAt") VALUES ($1,$2,$3,now())', [createHash("sha256").update(shop).digest("hex"), installationGeneration, installationStatus]);
}
async function rejectsCheck(query, constraint, values = []) {
  await assert.rejects(client.query(query, values), (error) => error.code === "23514" && error.constraint === constraint);
}
before(async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = url.hostname.replace("-pooler.", ".");
  client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  const history = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations"')).rows;
  assert.equal(history.filter((row) => !row.finished_at && !row.rolled_back_at).length, 0, "Unresolved migration history; stop before applying new SQL");
  for (const name of baseline) {
    const row = history.find((entry) => entry.migration_name === name && entry.finished_at && !entry.rolled_back_at);
    assert.ok(row, `Prerequisite ${name} must have succeeded`);
    assert.equal(row.checksum, createHash("sha256").update(readFileSync(new URL(`${name}/migration.sql`, root))).digest("hex"), `Applied history differs for ${name}`);
  }
  await client.query(`CREATE SCHEMA "${namespace}"`);
  await client.query(`SET search_path TO "${namespace}"`);
  for (const name of baseline) await migrate(name);
  await fixture("verified.myshopify.com");
  await fixture("unverified.myshopify.com", { verified: false });
  await fixture("stale.myshopify.com", { installationGeneration: "old" });
  await fixture("uninstalled.myshopify.com", { installationStatus: "UNINSTALLED" });
  await fixture("started.myshopify.com", { status: "PENDING" });
  await client.query('UPDATE "CatalogSyncState" SET "requiredDatasets"=NULL WHERE shop=\'verified.myshopify.com\'');
  // NOT VALID checks must preserve legacy rows while rejecting future bad writes.
  await client.query('INSERT INTO "CatalogRepair" (shop,kind,attempts) VALUES (\'verified.myshopify.com\',\'PRODUCT\',-1)');
  for (const name of newMigrations) await migrate(name);
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), options: `-c search_path=${namespace}` }, { schema: namespace }) });
});
after(async () => {
  await db?.$disconnect();
  if (client) {
    // Only the namespace created by this test may be dropped.
    assert.match(namespace, /^integrity_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await client.end();
  }
});

test("the complete migration chain preserves all existing models and backfills only verified current installations", async () => {
  assert.equal(newMigrations.length, 2);
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [namespace])).rows;
  assert.equal(tables.length, 23, "20 existing models, one new model, and two session tables");
  assert.deepEqual((await client.query('SELECT shop FROM "InitialSyncRequest" ORDER BY shop')).rows.map((row) => row.shop), ["verified.myshopify.com"]);
  const schedules = (await client.query('SELECT shop,kind::text FROM "CatalogRepair" WHERE kind::text LIKE \'INVENTORY_%\' ORDER BY shop,kind::text')).rows;
  assert.deepEqual(schedules.map((row) => row.shop), ["started.myshopify.com", "started.myshopify.com", "verified.myshopify.com", "verified.myshopify.com"]);
  assert.deepEqual((await client.query('SELECT "requiredDatasets" FROM "CatalogSyncState" WHERE shop=\'verified.myshopify.com\'')).rows[0].requiredDatasets, ["products", "variants"]);
  await assert.rejects(client.query('UPDATE "CatalogSyncState" SET "requiredDatasets"=NULL WHERE shop=\'verified.myshopify.com\''), { code: "23502" });
});

test("initial requests enforce composite identity, states, leases, completion, and cascading deletion", async () => {
  const request = await db.initialSyncRequest.findUnique({ where: { shop_generation: { shop: "verified.myshopify.com", generation: "g" } } });
  assert.equal(request.status, "PENDING");
  assert.equal(request.attempts, 0);
  await assert.rejects(client.query('INSERT INTO "InitialSyncRequest" (shop,generation) VALUES (\'verified.myshopify.com\',\'g\')'), { code: "23505" });
  for (const [assignment, constraint] of [
    ["status='UNKNOWN'", "InitialSyncRequest_status_check"],
    ["attempts=-1", "InitialSyncRequest_attempts_check"],
    ["\"leaseToken\"='token'", "InitialSyncRequest_lease_check"],
    ["status='COMPLETED'", "InitialSyncRequest_completion_check"],
  ]) await rejectsCheck(`UPDATE "InitialSyncRequest" SET ${assignment} WHERE shop='verified.myshopify.com'`, constraint);
  await client.query('UPDATE "InitialSyncRequest" SET status=\'COMPLETED\',"completedAt"=now() WHERE shop=\'verified.myshopify.com\'');
  await fixture("cascade.myshopify.com");
  await client.query('INSERT INTO "InitialSyncRequest" (shop,generation) VALUES (\'cascade.myshopify.com\',\'g\')');
  await client.query('DELETE FROM "Shop" WHERE domain=\'cascade.myshopify.com\'');
  assert.equal((await client.query('SELECT * FROM "InitialSyncRequest" WHERE shop=\'cascade.myshopify.com\'')).rowCount, 0);
});

test("NOT VALID integrity checks leave legacy violations visible and reject new invalid state", async () => {
  const constraints = (await client.query("SELECT conname,convalidated FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname IN ('InventoryChange_revision_check','InventoryChange_lease_check','SnapshotInventoryChange_revision_check','CatalogRepair_lease_check','CatalogRepair_attempts_check','SnapshotDataset_counts_check','SnapshotRun_attempts_check')", [namespace])).rows;
  assert.equal(constraints.length, 7);
  assert.ok(constraints.every((row) => !row.convalidated));
  assert.equal((await client.query('SELECT attempts FROM "CatalogRepair" WHERE shop=\'verified.myshopify.com\' AND kind=\'PRODUCT\'')).rows[0].attempts, -1);
  await rejectsCheck('UPDATE "CatalogRepair" SET attempts=0,"leaseToken"=\'x\' WHERE shop=\'verified.myshopify.com\' AND kind=\'PRODUCT\'', "CatalogRepair_lease_check");
  await rejectsCheck('UPDATE "CatalogRepair" SET "pagesInWindow"=-1 WHERE shop=\'verified.myshopify.com\' AND kind=\'PRODUCT\'', "CatalogRepair_attempts_check");
  await client.query('INSERT INTO "SnapshotRun" (id,shop,generation) VALUES (\'integrity-run\',\'verified.myshopify.com\',\'g\')');
  await rejectsCheck('UPDATE "SnapshotRun" SET attempts=-1 WHERE id=\'integrity-run\'', "SnapshotRun_attempts_check");
  await rejectsCheck('INSERT INTO "SnapshotDataset" ("runId",name,"expectedRecords","importedRecords") VALUES (\'integrity-run\',\'products\',1,2)', "SnapshotDataset_counts_check");
  await rejectsCheck('INSERT INTO "SnapshotInventoryChange" ("runId","inventoryItemId",revision,"appliedRevision") VALUES (\'integrity-run\',\'item\',1,2)', "SnapshotInventoryChange_revision_check");
  await rejectsCheck('INSERT INTO "InventoryChange" (shop,"inventoryItemId",revision,"updatedAt") VALUES (\'verified.myshopify.com\',\'item\',0,now())', "InventoryChange_revision_check");
  await rejectsCheck('INSERT INTO "InventoryChange" (shop,"inventoryItemId","leaseToken","updatedAt") VALUES (\'verified.myshopify.com\',\'item\',\'x\',now())', "InventoryChange_lease_check");
});

test("registration creates inventory schedules idempotently without replacing the existing automatic import", async () => {
  const shop = "new-registration.myshopify.com";
  const first = await db.$transaction((tx) => registerShopInTransaction(tx, shop));
  const second = await db.$transaction((tx) => registerShopInTransaction(tx, shop));
  assert.equal(second.activeRunId, first.activeRunId);
  assert.equal(await db.snapshotRun.count({ where: { shop } }), 1);
  assert.equal(await db.catalogRepair.count({ where: { shop } }), 5);
});

test("applied migration 008 repair audits malformed JSON and duplicate IDs without partial writes", async () => {
  await client.query('INSERT INTO "SnapshotRun" (id,shop,generation) VALUES (\'repair-run\',\'verified.myshopify.com\',\'g\')');
  const repair = (apply) => repairVariantProjection(client, { shop: "verified.myshopify.com", runId: "repair-run", apply });
  await client.query('INSERT INTO "SnapshotProduct" ("runId","productId",data) VALUES (\'repair-run\',\'p1\',$1)', [JSON.stringify({ variants: {} })]);
  assert.equal((await repair(true)).malformedProducts, 1);
  const variants = [{ id: "v1", inventoryItemId: "", inventoryItem: { id: "i1" } }];
  await client.query('UPDATE "SnapshotProduct" SET data=$1 WHERE "runId"=\'repair-run\'', [JSON.stringify({ variants: [...variants, ...variants, null] })]);
  const refused = await repair(true);
  assert.equal(refused.status, "needs_reconciliation");
  assert.equal(refused.duplicateIds, 1);
  assert.equal(refused.invalidVariants, 1);
  assert.equal((await client.query('SELECT * FROM "Variant" WHERE "snapshotId"=\'repair-run\'')).rowCount, 0);
  await client.query('UPDATE "SnapshotProduct" SET data=$1 WHERE "runId"=\'repair-run\'', [JSON.stringify({ variants })]);
  assert.equal((await repair(false)).inserted, 0);
  assert.equal((await repair(true)).inserted, 1);
  assert.equal((await repair(true)).inserted, 0);
  assert.equal((await client.query('SELECT "inventoryItemId" FROM "Variant" WHERE "snapshotId"=\'repair-run\'')).rows[0].inventoryItemId, "i1");
  await client.query('UPDATE "Variant" SET "inventoryItemId"=\'conflict\' WHERE "snapshotId"=\'repair-run\'');
  assert.equal((await repair(true)).conflictingRows, 1);
  assert.equal((await client.query('SELECT status FROM "SnapshotRun" WHERE id=\'repair-run\'')).rows[0].status, "INGESTING");
});
