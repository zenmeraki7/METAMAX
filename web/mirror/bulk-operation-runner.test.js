import test from "node:test";
import assert from "node:assert/strict";
import { createBulkOperationRunner } from "./bulk-operation-runner.server.js";

const shopId = "test-store.myshopify.com";
const generationId = "gen-123";

test("initiateBulkCatalogExport checks running bulk operations and binds to SyncRun", async () => {
  const requests = [];
  const mockShopify = {
    async request(query, options) {
      requests.push({ query, options });
      if (query.includes("StartBulkOperation")) {
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: { id: "gid://shopify/BulkOperation/888", status: "CREATED" },
              userErrors: [],
            },
          },
        };
      }
      return { data: {} };
    },
  };

  let bound = false;
  let responseId;
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 101n,
        fence: 1n,
        status: "RUNNING",
        bulkOperationId: null,
      };
    },
    async recordBulkStartResponse({ shopId: sid, runId, fence, bulkOperationId }) {
      responseId = bulkOperationId;
      assert.equal(sid, shopId);
      assert.equal(runId, 101n);
      assert.equal(fence, 1n);
      assert.equal(bulkOperationId, "gid://shopify/BulkOperation/888");
    },
    async prepareBulkStart({fence}) { if(responseId){bound=true;return {operationId:responseId};} return {dispatchFence:String(fence)}; },
    async rejectBulkStart() {},
    async failIngestionRun() {},
  };

  const runner = createBulkOperationRunner({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
    ingestionWriter: {},
    database: {},
  });

  const syncRun = { runId: 101n, fence: 1n };
  const op = await runner.initiateBulkCatalogExport({ shopId, syncRun });

  assert.equal(op.id, "gid://shopify/BulkOperation/888");
  assert.equal(bound, true);
  assert.equal(requests.length, 1);
});

test("ingestJsonlLines streams JSONL product and variant lines, commits batches, and completes run", async () => {
  let stagingBatchesWritten = 0;
  const mockIngestionWriter = {
    async writeStagingBatch({ records }) {
      stagingBatchesWritten++;
      assert.equal(records.length, 1);
      assert.equal(records[0].id, "gid://shopify/Product/1");
      assert.equal(records[0].variants.length, 1);
      assert.equal(records[0].variants[0].id, "gid://shopify/ProductVariant/10");
    },
  };

  let completed = false;
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 101n,
        generationId,
        fence: 1n,
        status: "RUNNING",
        bulkOperationId: "gid://shopify/BulkOperation/888",
        leaseToken: "w1",
      };
    },
    async renewRunLease() {},
    async completeIngestionRun({ shopId: sid, runId, fence, expectedLines, processedLines, invalidLines, eofVerified }) {
      completed = true;
      assert.equal(sid, shopId);
      assert.equal(runId, 101n);
      assert.equal(fence, 1n);
      assert.equal(expectedLines, 2n); // 1 product + 1 variant line
      assert.equal(processedLines, 2n);
      assert.equal(invalidLines, 0n);
      assert.equal(eofVerified, true);
    },
    async transitionGenerationToReconciling() {},
    async failIngestionRun() {},
  };

  const mockShopify = {
    async request(query) {
      if (query.includes("MirrorBulkStatus")) {
        return {
          data: {
            bulkOperation: {
              id: "gid://shopify/BulkOperation/888",
              status: "COMPLETED",
              objectCount: "2",
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const mockClient = {
    async query() { return { rowCount: 1, rows: [] }; },
    release() {},
  };
  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const runner = createBulkOperationRunner({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
    ingestionWriter: mockIngestionWriter,
    database: mockDatabase,
  });

  const jsonlLines = [
    JSON.stringify({ id: "gid://shopify/Product/1", title: "Test Product", handle: "test-product" }),
    JSON.stringify({ id: "gid://shopify/ProductVariant/10", title: "Small", price: "10.00", __parentId: "gid://shopify/Product/1" }),
  ];

  const result = await runner.ingestJsonlLines({
    shopId,
    generationId,
    runId: 101n,
    fence: 1n,
    lines: jsonlLines,
    batchSize: 10,
  });

  assert.equal(result.totalLinesProcessed, 2n);
  assert.equal(result.chunksCommitted, 1);
  assert.equal(result.succeeded, true);
  assert.equal(stagingBatchesWritten, 1);
  assert.equal(completed, true);
});

test("completeEmptyStoreIngestion seals an empty catalog with zero expected and processed lines", async () => {
  let completed = false;
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 101n,
        generationId,
        fence: 1n,
        status: "RUNNING",
        bulkOperationId: "gid://shopify/BulkOperation/888",
        leaseToken: "w1",
      };
    },
    async renewRunLease() {},
    async completeIngestionRun({ expectedLines, processedLines, invalidLines, eofVerified }) {
      completed = true;
      assert.equal(expectedLines, 0n);
      assert.equal(processedLines, 0n);
      assert.equal(invalidLines, 0n);
      assert.equal(eofVerified, true);
    },
    async transitionGenerationToReconciling() {},
    async failIngestionRun() {},
  };

  const mockShopify = {
    async request(query) {
      if (query.includes("MirrorBulkStatus")) {
        return {
          data: {
            bulkOperation: {
              id: "gid://shopify/BulkOperation/888",
              status: "COMPLETED",
              objectCount: "0",
            },
          },
        };
      }
      return { data: {} };
    },
  };

  const mockClient = {
    async query() { return { rowCount: 1, rows: [] }; },
    release() {},
  };
  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const runner = createBulkOperationRunner({
    shopifyClient: mockShopify,
    syncRunService: mockSyncRunService,
    ingestionWriter: {},
    database: mockDatabase,
  });

  const res = await runner.completeEmptyStoreIngestion({
    shopId,
    generationId,
    runId: 101n,
    fence: 1n,
  });

  assert.equal(res.succeeded, true);
  assert.equal(completed, true);
});
