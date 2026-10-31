import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createJsonlIngestionService,
  streamLinesFromReadable,
  normalizeLineStream,
} from "./jsonl-ingestion.server.js";

const shopId = "jsonl-test.myshopify.com";
const generationId = "gen-jsonl-1";

test("jsonl-ingestion: streamLinesFromReadable yields lines iteratively from a Readable stream", async () => {
  const content = [
    JSON.stringify({ id: "gid://shopify/Product/1", title: "P1", handle: "p1" }),
    JSON.stringify({ id: "gid://shopify/ProductVariant/11", title: "V11", __parentId: "gid://shopify/Product/1" }),
    JSON.stringify({ id: "gid://shopify/Product/2", title: "P2", handle: "p2" }),
  ].join("\n");

  const readable = Readable.from(Buffer.from(content));
  const lines = [];
  for await (const line of streamLinesFromReadable(readable)) {
    lines.push(line);
  }

  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("gid://shopify/Product/1"));
  assert.ok(lines[1].includes("gid://shopify/ProductVariant/11"));
});

test("jsonl-ingestion: normalizeLineStream rejects lines exceeding byte limits", async () => {
  const hugeLine = "a".repeat(2 * 1024 * 1024);
  const generator = normalizeLineStream([hugeLine]);

  await assert.rejects(
    async () => {
      for await (const _ of generator) {}
    },
    /Bounded JSONL text line required/,
  );
});

test("jsonl-ingestion: streams and ingests JSONL stream without loading entire file into memory", async () => {
  const products = [
    JSON.stringify({ id: "gid://shopify/Product/10", title: "Shirt", handle: "shirt" }),
    JSON.stringify({ id: "gid://shopify/ProductVariant/101", title: "Blue", price: "20.00", __parentId: "gid://shopify/Product/10" }),
    JSON.stringify({ id: "gid://shopify/Product/20", title: "Pants", handle: "pants" }),
    JSON.stringify({ id: "gid://shopify/ProductVariant/201", title: "32", price: "40.00", __parentId: "gid://shopify/Product/20" }),
  ];

  const stream = Readable.from(products.join("\n"));
  const stagingBatches = [];

  const mockIngestionWriter = {
    async writeStagingBatch({ records, ordinal }) {
      stagingBatches.push({ records, ordinal });
    },
  };

  let leaseRenewals = 0;
  let completed = false;
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 55n,
        generationId,
        fence: 2n,
        status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
        leaseToken: "worker-jsonl",
      };
    },
    async renewRunLease({ shopId: s, runId: r, fence, workerId }) {
      leaseRenewals++;
      assert.equal(s, shopId);
      assert.equal(r, 55n);
      assert.equal(fence, 2n);
      assert.equal(workerId, "worker-jsonl");
    },
    async completeIngestionRun({ expectedLines, processedLines, eofVerified }) {
      completed = true;
      assert.equal(expectedLines, 4n);
      assert.equal(processedLines, 4n);
      assert.equal(eofVerified, true);
    },
    async transitionGenerationToReconciling() {},
    async failIngestionRun() {},
  };

  const mockClient = {
    async query() { return { rowCount: 1, rows: [] }; },
    release() {},
  };
  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const service = createJsonlIngestionService({
    bulkSyncService: { getStatus: async () => ({ id: "gid://shopify/BulkOperation/777", status: "COMPLETED", objectCount: "4" }) },
    syncRunService: mockSyncRunService,
    ingestionWriter: mockIngestionWriter,
    database: mockDatabase,
  });

  const res = await service.ingestJsonlStream({
    shopId,
    generationId,
    runId: 55n,
    fence: 2n,
    stream,
    batchSize: 1, // Flush each product immediately to test batch streaming
    expectedLines: 4n,
  });

  assert.equal(res.totalLinesProcessed, 4n);
  assert.equal(res.succeeded, true);
  assert.equal(stagingBatches.length, 2);
  assert.equal(leaseRenewals, 2);
  assert.equal(completed, true);

  assert.equal(stagingBatches[0].records[0].id, "gid://shopify/Product/10");
  assert.equal(stagingBatches[0].records[0].variants[0].id, "gid://shopify/ProductVariant/101");
  assert.equal(stagingBatches[1].records[0].id, "gid://shopify/Product/20");
});

test("jsonl-ingestion: detects truncated export and fails run", async () => {
  const products = [
    JSON.stringify({ id: "gid://shopify/Product/1", title: "One", handle: "one" }),
  ];

  const mockIngestionWriter = {
    async writeStagingBatch() {},
  };

  let runFailed = false;
  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 1n,
        generationId,
        fence: 1n,
        status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
        leaseToken: "w1",
      };
    },
    async renewRunLease() {},
    async failIngestionRun({ error }) {
      runFailed = true;
      assert.ok(error.message.includes("Truncated export"));
    },
  };

  const mockDatabase = {
    async connect() {
      return {
        async query() { return { rowCount: 1, rows: [] }; },
        release() {},
      };
    },
  };

  const service = createJsonlIngestionService({
    bulkSyncService: { getStatus: async () => ({ id: "gid://shopify/BulkOperation/777", status: "COMPLETED", objectCount: "5" }) },
    syncRunService: mockSyncRunService,
    ingestionWriter: mockIngestionWriter,
    database: mockDatabase,
  });

  await assert.rejects(
    () =>
      service.ingestJsonlLines({
        shopId,
        generationId,
        runId: 1n,
        fence: 1n,
        lines: products,
        expectedLines: 5n, // Expected 5 lines, but received only 1
      }),
    /Truncated export/,
  );

  assert.equal(runFailed, true);
});

test("jsonl-ingestion: aborting signal durably cancels generation", async () => {
  const controller = new AbortController();
  let cancelled = false;

  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 1n,
        generationId,
        fence: 1n,
        status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
        leaseToken: "w1",
      };
    },
    async cancelGeneration({ shopId: s, generationId: g }) {
      cancelled = true;
      assert.equal(s, shopId);
      assert.equal(g, generationId);
    },
    async failIngestionRun() {},
  };

  const service = createJsonlIngestionService({
    bulkSyncService: { getStatus: async () => ({ id: "gid://shopify/BulkOperation/777", status: "COMPLETED", objectCount: "2" }) },
    syncRunService: mockSyncRunService,
    ingestionWriter: { async writeStagingBatch() {} },
    database: {
      async connect() {
        return {
          async query() { return { rowCount: 1, rows: [] }; },
          release() {},
        };
      },
    },
  });

  async function* abortedLines() {
    yield JSON.stringify({ id: "gid://shopify/Product/1", title: "One", handle: "one" });
    controller.abort();
    yield JSON.stringify({ id: "gid://shopify/Product/2", title: "Two", handle: "two" });
  }

  await assert.rejects(
    () =>
      service.ingestJsonlLines({
        shopId,
        generationId,
        runId: 1n,
        fence: 1n,
        lines: abortedLines(),
        expectedLines: 2n,
        signal: controller.signal,
      }),
    { name: "AbortError" },
  );

  assert.equal(cancelled, true);
});
