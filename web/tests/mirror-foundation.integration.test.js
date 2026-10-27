import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../shared/db.js";
import { createBulkQueryCoordinator } from "../integrations/shopify/bulk-query-coordinator.js";
import { pinSnapshot, releaseSnapshotPin, pruneRetiredSnapshots } from "../mirror/retention.js";
import { compileProductQuery } from "../query/compiler.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Use node scripts/test-mirror-foundation.js");
const shops = [];
async function fixture() {
  const domain = `test-foundation-${randomUUID()}.myshopify.com`; shops.push(domain);
  return prisma.shop.create({ data: { domain, installationVerified: true } });
}
async function run(merchant, overrides = {}) {
  return prisma.snapshotRun.create({ data: { shop: merchant.domain, generation: merchant.generation,
    status: "COMPLETED", expectedProducts: 0, importedProducts: 0, completedAt: new Date(), ...overrides } });
}
after(async () => {
  await prisma.snapshotRetentionPin.deleteMany({ where: { shop: { in: shops } } });
  await prisma.bulkQueryClaim.deleteMany({ where: { shop: { in: shops } } });
  await prisma.shop.updateMany({ where: { domain: { in: shops } }, data: { activeSnapshotId: null } });
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } }); await prisma.$disconnect();
});
test("publication FK rejects cross-shop, cross-installation and deleted snapshot pointers", async () => {
  const a = await fixture(), b = await fixture(), snapshot = await run(a);
  await assert.rejects(() => prisma.shop.update({ where: { domain: b.domain }, data: { activeSnapshotId: snapshot.id } }), { code: "P2003" });
  const old = await run(a, { generation: randomUUID() });
  await assert.rejects(() => prisma.shop.update({ where: { domain: a.domain }, data: { activeSnapshotId: old.id } }), { code: "P2003" });
  await prisma.shop.update({ where: { domain: a.domain }, data: { activeSnapshotId: snapshot.id } });
  await assert.rejects(() => prisma.snapshotRun.delete({ where: { id: snapshot.id } }), { code: "P2003" });
  await assert.rejects(() => prisma.snapshotDataset.create({ data: { runId: snapshot.id, name: "products", expectedRecords: 2, importedRecords: 1 } }));
});
test("pins and publication pointer protect snapshots during bounded retention cleanup", async () => {
  const merchant = await fixture(), retired = await run(merchant), current = await run(merchant);
  await prisma.shop.update({ where: { domain: merchant.domain }, data: { activeSnapshotId: current.id } });
  const pin = { shop: merchant.domain, generation: merchant.generation, snapshotId: retired.id, kind: "EXPORT", ownerId: "export-1" };
  await pinSnapshot(pin); await pinSnapshot(pin);
  assert.equal(await prisma.snapshotRetentionPin.count({ where: { shop: merchant.domain } }), 1);
  await assert.rejects(() => prisma.snapshotRun.delete({ where: { id: retired.id } }), { code: "P2003" });
  const policy = { shop: merchant.domain, generation: merchant.generation, before: new Date(Date.now() + 1000) };
  assert.equal((await pruneRetiredSnapshots(policy)).count, 0);
  await releaseSnapshotPin(pin); assert.equal((await pruneRetiredSnapshots(policy)).count, 1);
  assert.ok(await prisma.snapshotRun.findUnique({ where: { id: current.id } }));
});
test("Postgres serializes independent sync/export coordinators into five shared slots", async () => {
  const merchant = await fixture(), appId = `test-${randomUUID()}`;
  const a = createBulkQueryCoordinator({ db: prisma, appId }), b = createBulkQueryCoordinator({ db: prisma, appId });
  const input = i => ({ shop: merchant.domain, generation: merchant.generation, key: `request-${i}`,
    consumer: i % 2 ? "export" : "sync", find: async () => null, start: async () => `gid://shopify/BulkOperation/${i + 1}` });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? b : a).launch(input(i))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "BULK_CAPACITY_UNAVAILABLE").length, 3);
  const claims = await prisma.bulkQueryClaim.findMany({ where: { appId, shop: merchant.domain } });
  assert.equal(new Set(claims.map(claim => claim.slot)).size, 5);
  await a.complete({ shop: merchant.domain, id: claims[0].operationId, status: "COMPLETED" });
  assert.equal(await b.launch(input(99)), "gid://shopify/BulkOperation/100");
});
test("compiled SQL binds injected text and reads only the current published tenant snapshot", async () => {
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const a = await fixture(), b = await fixture(), first = await run(a), second = await run(a), other = await run(b);
    const attack = "Summer' OR TRUE; --", productId = "gid://shopify/Product/123";
    for (const snapshot of [first, second, other]) await prisma.snapshotProduct.create({ data: {
      runId: snapshot.id, productId, data: { id: productId, title: attack, tags: ["Sale"], tracksInventory: false },
    } });
    await prisma.shop.update({ where: { domain: a.domain }, data: { activeSnapshotId: first.id } });
    await prisma.shop.update({ where: { domain: b.domain }, data: { activeSnapshotId: other.id } });
    const context = { shopId: a.domain, generation: a.generation, snapshotId: first.id,
      authorized: true, scopes: ["read_products"], completedDatasets: ["products"], coverageReady: true };
    const pred = (field, operator, value) => ({ type: "predicate", field, operator, value });
    const query = compileProductQuery(pred("product.title", "eq", attack), context);
    assert.equal((await client.query(query)).rows.length, 1);
    assert.equal((await client.query(compileProductQuery(pred("product.tags", "contains_all", ["Sale"]), context))).rows.length, 1);
    assert.equal((await client.query(compileProductQuery(pred("product.tracksInventory", "eq", false), context))).rows.length, 1);
    await prisma.shop.update({ where: { domain: a.domain }, data: { activeSnapshotId: second.id } });
    assert.equal((await client.query(query)).rows.length, 0);
  } finally { await client.end(); }
});

async function importFixture({ loseFirstResponse = false } = {}) {
  const merchant = await fixture();
  const { reserveCatalogSync } = await import("../domains/sync/sync.request.js");
  const { processCatalogImport } = await import("../domains/sync/sync.import.js");
  const { claimSnapshotLease, releaseSnapshotLease } = await import("../domains/sync/sync.lease.js");
  const snapshot = await prisma.$transaction(tx => reserveCatalogSync(tx, merchant));
  const operations = new Map(); let created = 0;
  const options = { bulkAppId: `test-${merchant.domain}`,
    async graphql(_shop, query, variables) {
      if (query.includes("FindCatalogExport")) return { bulkOperations: { nodes: [...operations.values()], pageInfo: { hasNextPage: false } } };
      if (query.includes("StartCatalogExport")) {
        const id = `gid://shopify/BulkOperation/${++created}`;
        operations.set(id, { id, query: variables.query, status: "COMPLETED", rootObjectCount: "0", objectCount: "0", url: null });
        if (loseFirstResponse) { loseFirstResponse = false; throw Error("accepted but response lost"); }
        return { bulkOperationRunQuery: { bulkOperation: { id }, userErrors: [] } };
      }
      return { bulkOperation: operations.get(variables.id) };
    },
  };
  async function step() {
    await prisma.snapshotRun.update({ where: { id: snapshot.id }, data: { nextCheckAt: new Date(0) } });
    const current = await prisma.snapshotRun.findUnique({ where: { id: snapshot.id } });
    const { token } = await claimSnapshotLease(current, { includeIngestion: true });
    try { return await processCatalogImport(current, token, options); }
    finally { await releaseSnapshotLease(current, token); }
  }
  return { merchant, snapshot, step, get created() { return created; } };
}
test("the real importer verifies every empty dataset before reconciliation and publication", async () => {
  const f = await importFixture();
  for (let i = 0; i < 6; i++) await f.step();
  const snapshot = await prisma.snapshotRun.findUnique({ where: { id: f.snapshot.id } });
  assert.equal(snapshot.status, "RECONCILING");
  assert.equal(f.created, 3);
  const datasets = await prisma.snapshotDataset.findMany({ where: { runId: snapshot.id } });
  assert.equal(datasets.length, 4); assert.ok(datasets.every(row => row.expectedRecords === 0n && row.importedRecords === 0n));
  const claims = await prisma.bulkQueryClaim.findMany({ where: { shop: f.merchant.domain } });
  assert.equal(claims.length, 3); assert.ok(claims.every(row => row.state === "RELEASED" && row.slot === null));
  assert.equal((await prisma.shop.findUnique({ where: { domain: f.merchant.domain } })).activeSnapshotId, null);
  const { claimSnapshotLease } = await import("../domains/sync/sync.lease.js");
  await prisma.snapshotRun.update({ where: { id: snapshot.id }, data: { nextCheckAt: new Date(0) } });
  const { token } = await claimSnapshotLease(snapshot);
  const { publishRun } = await import("../domains/sync/sync.repository.js");
  await publishRun(snapshot, token, 0);
  assert.equal((await prisma.shop.findUnique({ where: { domain: f.merchant.domain } })).activeSnapshotId, snapshot.id);
});
test("the importer recovers an accepted operation after response loss without another launch", async () => {
  const f = await importFixture({ loseFirstResponse: true });
  await assert.rejects(f.step(), /accepted but response lost/);
  assert.equal(f.created, 1);
  assert.equal((await prisma.bulkQueryClaim.findFirst({ where: { shop: f.merchant.domain } })).state, "UNKNOWN");
  await f.step(); assert.equal(f.created, 1);
  assert.equal((await prisma.snapshotRun.findUnique({ where: { id: f.snapshot.id } })).status, "WAITING");
  await f.step();
  assert.equal((await prisma.bulkQueryClaim.findFirst({ where: { shop: f.merchant.domain } })).state, "RELEASED");
});
