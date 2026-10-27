import { test } from "node:test";
import assert from "node:assert/strict";
import { createBulkQueryCoordinator } from "../integrations/shopify/bulk-query-coordinator.js";
const shop = "example.myshopify.com", generation = "generation-1";
const id = n => `gid://shopify/BulkOperation/${n}`;
function database() {
  const rows = [], merchant = { generation, status: "ACTIVE", installationVerified: true };
  const match = (row, where) => Object.entries(where).every(([key, value]) =>
    key === "appId_shop_requestKey" ? match(row, value) : value && typeof value === "object" && "not" in value ? row[key] !== value.not : row[key] === value);
  const model = {
    async findUnique({ where }) { const row = rows.find(row => match(row, where)); return row ? { ...row } : null; },
    async findMany({ where }) { return rows.filter(row => match(row, where)).map(row => ({ ...row })); },
    async create({ data }) { const row = { ...data }; rows.push(row); return { ...row }; },
    async update({ where, data }) { const row = rows.find(row => match(row, where)); assert.ok(row); Object.assign(row, data); return { ...row }; },
    async updateMany({ where, data }) { const found = rows.filter(row => match(row, where)); found.forEach(row => Object.assign(row, data)); return { count: found.length }; },
  };
  let tail = Promise.resolve();
  const db = { bulkQueryClaim: model, $executeRaw: async () => 1, $queryRaw: async () => [{ ...merchant }],
    $transaction(fn) { const result = tail.then(() => fn(db)); tail = result.catch(() => {}); return result; } };
  return { db, rows, merchant };
}
const input = (key, consumer = "sync") => ({ shop, generation, key, consumer, find: async () => null, start: async () => id(Number(key.replace(/\D/g, "")) + 1) });
test("independent sync and export consumers share five slots and release only on terminal evidence", async () => {
  const { db, rows } = database();
  const sync = createBulkQueryCoordinator({ db, appId: "app-1" }), exporter = createBulkQueryCoordinator({ db, appId: "app-1" });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? exporter : sync).launch(input(`key${i}`, i % 2 ? "export" : "sync"))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5);
  assert.equal(results.filter(result => result.status === "rejected")[0].reason.code, "BULK_CAPACITY_UNAVAILABLE");
  assert.equal(new Set(rows.map(row => row.slot)).size, 5);
  await assert.rejects(() => sync.complete({ shop, id: id(1), status: "RUNNING" }), TypeError);
  await sync.complete({ shop, id: id(1), status: "COMPLETED" });
  assert.equal(await exporter.launch(input("key9", "export")), id(10));
});
test("an ambiguous launch holds its slot and cannot be launched twice, but can recover by exact identity", async () => {
  const { db, rows } = database(); const coordinator = createBulkQueryCoordinator({ db, appId: "app-1" });
  let launches = 0;
  const request = { ...input("key1"), start: async () => { launches++; throw Error("response lost"); } };
  await assert.rejects(() => coordinator.launch(request), /response lost/);
  assert.equal(rows[0].state, "UNKNOWN"); assert.equal(rows[0].slot, 0);
  await assert.rejects(() => coordinator.launch(request), { code: "BULK_LAUNCH_UNCERTAIN" });
  assert.equal(launches, 1);
  assert.equal(await coordinator.launch({ ...request, find: async () => id(2) }), id(2));
  assert.equal(rows[0].state, "ACTIVE");
});
test("duplicate scheduling is idempotent and definitive rejection frees capacity", async () => {
  const { db, rows } = database(); const coordinator = createBulkQueryCoordinator({ db, appId: "app-1" });
  let launches = 0;
  const request = { ...input("key2"), start: async () => { launches++; return id(3); } };
  const results = await Promise.allSettled([coordinator.launch(request), coordinator.launch(request)]);
  assert.equal(launches, 1); assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(await coordinator.launch(request), id(3));
  const rejected = { ...input("key4"), start: async () => { throw Object.assign(Error("rejected"), { definitiveBulkRejection: true }); } };
  await assert.rejects(() => coordinator.launch(rejected), /rejected/);
  assert.equal(rows.find(row => row.requestKey === "key4").slot, null);
  assert.equal(await coordinator.launch(input("key4")), id(5));
});
test("apps and shops have distinct capacity while stale installations cannot start", async () => {
  const { db, merchant } = database();
  const first = createBulkQueryCoordinator({ db, appId: "app-1" }), second = createBulkQueryCoordinator({ db, appId: "app-2" });
  for (let i = 0; i < 5; i++) await first.launch(input(`key${i}`));
  assert.equal(await second.launch(input("key9", "export")), id(10));
  merchant.generation = "new-generation";
  await assert.rejects(() => first.launch(input("key9")), { code: "INSTALLATION_CHANGED" });
});
