import test from "node:test";
import assert from "node:assert/strict";
import { createBulkOperationRunner } from "./bulk-operation-runner.server.js";
import { createCursorService } from "../filters/pagination.js";
import { randomBytes } from "node:crypto";

test("remote bulk cancellation persists local fencing before an uncertain external response", async () => {
  const calls = [];
  const runner = createBulkOperationRunner({
    database: {},
    ingestionWriter: {},
    syncRunService: {
      getSyncRun: async () => ({
        generationId: "g",
        bulkOperationId: "gid://shopify/BulkOperation/5",
      }),
      async cancelGeneration() {
        calls.push("cancelled");
      },
    },
    shopifyClient: {
      async request(query, options) {
        assert.deepEqual(calls, ["cancelled"]);
        assert.equal(options.variables.id, "gid://shopify/BulkOperation/5");
        throw Error("connection lost");
      },
    },
  });
  await assert.rejects(
    () =>
      runner.cancelBulkCatalogExport({
        shopId: "unit.myshopify.com",
        runId: "1",
      }),
    /connection lost/,
  );
  assert.deepEqual(calls, ["cancelled"]);
});

test("failed and unrelated exports cannot be treated as empty-store completion", async () => {
  const run = {
    runId: "1",
    generationId: "g",
    status: "RUNNING",
    fence: "2",
    bulkOperationId: "gid://shopify/BulkOperation/5",
  };
  for (const op of [
    { id: run.bulkOperationId, status: "FAILED", objectCount: "0" },
    {
      id: "gid://shopify/BulkOperation/6",
      status: "COMPLETED",
      objectCount: "0",
    },
  ]) {
    const runner = createBulkOperationRunner({
      database: {
        connect() {
          assert.fail("Unverified export reached SQL");
        },
      },
      ingestionWriter: {},
      syncRunService: { getSyncRun: async () => run },
      shopifyClient: { request: async () => ({ data: { bulkOperation: op } }) },
    });
    await assert.rejects(() =>
      runner.completeEmptyStoreIngestion({
        shopId: "unit.myshopify.com",
        ...run,
      }),
    );
  }
});

test("retained-generation routing rejects expired, cross-shop and forged cursors", () => {
  let now = 1000;
  const cursors = createCursorService({
    secret: randomBytes(32),
    clock: () => now,
    maxAgeMs: 100,
  });
  const binding = {
    shopId: "unit.myshopify.com",
    generationId: "g",
    fingerprint: "a".repeat(64),
    schemaFingerprint: "b".repeat(64),
    idType: "bigint",
    ordering: "bigint:native",
  };
  const cursor = cursors.issue(binding, "1");
  assert.equal(cursors.readContext(cursor, binding.shopId).generationId, "g");
  assert.throws(() => cursors.readContext(cursor, "other.myshopify.com"));
  assert.throws(() => cursors.readContext(cursor + "a", binding.shopId));
  now = 1100;
  assert.throws(() => cursors.readContext(cursor, binding.shopId));
});
