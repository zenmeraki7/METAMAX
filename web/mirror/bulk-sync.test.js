import test from "node:test";
import assert from "node:assert/strict";
import {
  createBulkSyncService,
  PRODUCTS_BULK_QUERY,
} from "./bulk-sync.server.js";

const shopId = "bulk-test.myshopify.com";

test("bulk-sync: constructor requires shopifyClient and syncRunService", () => {
  assert.throws(
    () => createBulkSyncService({}),
    /Shopify client required/,
  );
  assert.throws(
    () => createBulkSyncService({ shopifyClient: { request: async () => {} } }),
    /Sync run service required/,
  );
});

test("bulk-sync: startBulkQuery validates shop and live run, dispatches mutation, and binds operation ID", async () => {
  const requests = [];
  const mockShopify = {
    async request(query, options) {
      requests.push({ query, options });
      if (query.includes("StartBulkOperation")) {
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: {
                id: "gid://shopify/BulkOperation/1001",
                status: "CREATED",
              },
              userErrors: [],
            },
          },
        };
      }
      return { data: {} };
    },
  };

  let bound = false;
  const mockSyncRunService = {
    async getSyncRun({ shopId: s, runId: r }) {
      assert.equal(s, shopId);
      assert.equal(r, 42n);
      return {
        runId: 42n,
        fence: 5n,
        status: "RUNNING",
        bulkOperationId: null,
      };
    },
    async bindBulkOperationId({ shopId: s, runId: r, fence, bulkOperationId }) {
      bound = true;
      assert.equal(s, shopId);
      assert.equal(r, 42n);
      assert.equal(fence, 5n);
      assert.equal(bulkOperationId, "gid://shopify/BulkOperation/1001");
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
  });

  const op = await service.startBulkQuery({
    shopId,
    syncRun: { runId: 42n, fence: 5n },
  });

  assert.equal(op.id, "gid://shopify/BulkOperation/1001");
  assert.equal(op.status, "CREATED");
  assert.equal(bound, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].options.variables.query.includes("products"));
});

test("bulk-sync: startBulkQuery returns existing status if operation already bound", async () => {
  const mockShopify = {
    async request(query, options) {
      if (query.includes("MirrorBulkStatus")) {
        assert.equal(options.variables.id, "gid://shopify/BulkOperation/existing");
        return {
          data: {
            bulkOperation: {
              id: "gid://shopify/BulkOperation/existing",
              status: "RUNNING",
              objectCount: "10",
            },
          },
        };
      }
      assert.fail("Should not call other queries");
    },
  };

  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 42n,
        fence: 1n,
        status: "RUNNING",
        bulkOperationId: "gid://shopify/BulkOperation/existing",
      };
    },
    async bindBulkOperationId() {
      assert.fail("Should not bind again");
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
  });

  const op = await service.startBulkQuery({
    shopId,
    syncRun: { runId: 42n, fence: 1n },
  });

  assert.equal(op.id, "gid://shopify/BulkOperation/existing");
  assert.equal(op.status, "RUNNING");
});

test("bulk-sync: startBulkQuery rejects on userErrors or GraphQL errors", async () => {
  const mockShopify = {
    async request() {
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: null,
            userErrors: [{ field: ["query"], message: "A bulk query is already in progress" }],
          },
        },
      };
    },
  };

  const mockSyncRunService = {
    async getSyncRun() {
      return { runId: 1n, fence: 1n, status: "RUNNING" };
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
  });

  await assert.rejects(
    () => service.startBulkQuery({ shopId, syncRun: { runId: 1n, fence: 1n } }),
    /Bulk start rejected/,
  );
});

test("bulk-sync: monitorBulkOperation polls until terminal status", async () => {
  let callCount = 0;
  const mockShopify = {
    async request() {
      callCount++;
      return {
        data: {
          bulkOperation: {
            id: "gid://shopify/BulkOperation/poll",
            status: callCount < 2 ? "RUNNING" : "COMPLETED",
            objectCount: "100",
            url: "https://example.com/dump.jsonl",
          },
        },
      };
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: { async getSyncRun() {} },
  });

  const op = await service.monitorBulkOperation({
    shopId,
    bulkOperationId: "gid://shopify/BulkOperation/poll",
    intervalMs: 10,
    timeoutMs: 1000,
  });

  assert.equal(op.status, "COMPLETED");
  assert.equal(op.objectCount, "100");
  assert.equal(callCount, 2);
});

test("bulk-sync: cancelBulkQuery cancels local generation first, then remote bulk operation", async () => {
  const steps = [];
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 99n,
        generationId: "gen-cancel",
        bulkOperationId: "gid://shopify/BulkOperation/cancel-me",
      };
    },
    async cancelGeneration({ shopId: s, generationId: g }) {
      steps.push(`local-cancel:${s}:${g}`);
    },
  };

  const mockShopify = {
    async request(query, options) {
      if (query.includes("CancelMirrorBulk")) {
        steps.push(`remote-cancel:${options.variables.id}`);
        return {
          data: {
            bulkOperationCancel: {
              bulkOperation: {
                id: "gid://shopify/BulkOperation/cancel-me",
                status: "CANCELING",
              },
              userErrors: [],
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
  });

  const res = await service.cancelBulkQuery({ shopId, runId: 99n });
  assert.equal(res.cancelled, true);
  assert.equal(res.remote, true);
  assert.deepEqual(steps, [
    `local-cancel:${shopId}:gen-cancel`,
    "remote-cancel:gid://shopify/BulkOperation/cancel-me",
  ]);
});

test("bulk-sync: recoverBulkQuery checks bound status or inspects orphan state without adopting it", async () => {
  // Case 1: Bound bulk operation
  const mockSyncRunService = {
    async getSyncRun({ runId }) {
      if (runId === 1n) {
        return {
          runId: 1n,
          generationId: "gen-1",
          fence: 1n,
          bulkOperationId: "gid://shopify/BulkOperation/bound",
        };
      }
      return {
        runId: 2n,
        generationId: "gen-2",
        fence: 1n,
        bulkOperationId: null,
      };
    },
  };

  const mockShopify = {
    async request(query, options) {
      if (query.includes("MirrorBulkStatus")) {
        return {
          data: {
            bulkOperation: {
              id: options.variables.id,
              status: "COMPLETED",
              objectCount: "50",
            },
          },
        };
      }
      if (query.includes("CurrentMirrorBulkOperation")) {
        return {
          data: {
            currentBulkOperation: {
              id: "gid://shopify/BulkOperation/orphan",
              status: "RUNNING",
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const service = createBulkSyncService({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
  });

  // Recovery of bound run
  const rec1 = await service.recoverBulkQuery({ shopId, runId: 1n });
  assert.equal(rec1.bound, true);
  assert.equal(rec1.readyToIngest, true);
  assert.equal(rec1.bulkOperationId, "gid://shopify/BulkOperation/bound");
  assert.equal(rec1.bulkOperation.status, "COMPLETED");

  // Recovery of unbound run with unowned orphan operation
  const rec2 = await service.recoverBulkQuery({ shopId, runId: 2n });
  assert.equal(rec2.bound, false);
  assert.equal(rec2.readyToIngest, false);
  assert.equal(rec2.orphanOperation.id, "gid://shopify/BulkOperation/orphan");
});
