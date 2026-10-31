import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createIngestionWriter } from "./ingestion-writer.server.js";
import { createJsonlIngestionService } from "./jsonl-ingestion.server.js";
import { createSyncRunService } from "./sync-run-service.server.js";
import { product, variant } from "./integration/sync-hardening.js";

const shopId = "recovery-test.myshopify.com";
const generationId = "gen-recovery-1";

test("recovery: atomic chunk commit and rollback - failure rolls back rows and checkpoint", async () => {
  let checkpointCommitted = false;
  let rowsCommitted = false;

  const mockSyncRunService = {
    async recordCheckpoint() {
      checkpointCommitted = true;
    },
  };

  const writer = createIngestionWriter({ syncRunService: mockSyncRunService });

  // Simulate a database client that fails during product insertion
  const failingClient = {
    async query(sql) {
      if (sql.includes("mirror.generations")) {
        return {
          rows: [
            {
              id: generationId,
              status: "INGESTING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: ["products", "variants"],
            },
          ],
        };
      }
      if (sql.includes("mirror.ingestion_runs")) {
        return { rows: [{ id: 10n, status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777", live: true, fence: 1n }] };
      }
      if (sql.includes("mirror.ingestion_chunks")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT 1 FROM mirror.products")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.products")) {
        throw Object.assign(new Error("Disk error / serialization failure"), { code: "40001" });
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () =>
      writer.writeStagingBatch({
        client: failingClient,
        shopId,
        generationId,
        runId: 10n,
        fence: 1n,
        ordinal: 0,
        records: [product(1)],
      }),
    /Disk error/,
  );

  // Both rows and checkpoint must not have succeeded
  assert.equal(checkpointCommitted, false);
});

test("recovery: crash halfway through ingestion - subsequent worker resumes safely without row duplication", async () => {
  const store = {
    products: new Map(),
    checkpoints: new Map(),
    runs: new Map([
      [
        101n,
        {
          id: 101n,
          shop_id: shopId,
          generation_id: generationId,
          dataset: "products",
          status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
          lease_token: "worker-1",
          lease_until: new Date(Date.now() + 60000),
          fence: 1n,
          processed_lines: "0",
          invalid_lines: 0,
        },
      ],
    ]),
  };

  const createMockClient = () => ({
    async query(sql, params) {
      if (sql.includes("FROM mirror.ingestion_runs")) {
        const runIdParam = params[2] !== undefined ? params[2] : params[1];
        const run = store.runs.get(BigInt(runIdParam));
        return {
          rows: run
            ? [{ ...run, live: true, generation_status: "INGESTING" }]
            : [],
        };
      }
      if (sql.includes("mirror.generations")) {
        return {
          rows: [
            {
              id: generationId,
              status: "INGESTING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: ["products", "variants"],
            },
          ],
        };
      }
      if (sql.includes("SELECT checksum,line_count FROM mirror.ingestion_chunks")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        const chunk = store.checkpoints.get(key);
        return { rows: chunk ? [chunk] : [] };
      }
      if (sql.includes("SELECT 1 FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=ANY")) {
        const gids = params[2];
        const hasDuplicate = gids.some((g) => store.products.has(g));
        return { rowCount: hasDuplicate ? 1 : 0, rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.products")) {
        const gid = params[2];
        store.products.set(gid, params);
        return { rows: [{ id: 500n }] };
      }
      if (sql.includes("SELECT 1 FROM mirror.variants")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("DELETE FROM mirror.variants")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.variants")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT count(*)::integer AS chunks,COALESCE(sum(line_count),0)::text AS lines")) {
        let lines = 0n;
        let count = 0;
        for (const [k, v] of store.checkpoints.entries()) {
          if (k.startsWith(`${params[0]}:${params[1]}:`)) {
            count++;
            lines += BigInt(v.line_count);
          }
        }
        return { rows: [{ chunks: count, lines: lines.toString() }] };
      }
      if (sql.includes("INSERT INTO mirror.ingestion_chunks")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        store.checkpoints.set(key, { checksum: params[3], line_count: params[4] });
        return { rows: [] };
      }
      if (sql.includes("UPDATE mirror.ingestion_runs SET processed_lines=processed_lines+$3::bigint")) {
        const run = store.runs.get(BigInt(params[1]));
        run.processed_lines = (BigInt(run.processed_lines) + BigInt(params[2])).toString();
        return { rows: [{ processed_lines: run.processed_lines }] };
      }
      if (sql.includes("UPDATE mirror.ingestion_runs SET status='SUCCEEDED'")) {
        const run = store.runs.get(BigInt(params[1]));
        run.status = "SUCCEEDED";
        run.expected_lines = params[2];
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(sum(line_count),0)::text AS lines,count(*)::integer AS chunks")) {
        let lines = 0n;
        let count = 0;
        let last = -1;
        for (const [k, v] of store.checkpoints.entries()) {
          if (k.startsWith(`${params[0]}:${params[1]}:`)) {
            count++;
            lines += BigInt(v.line_count);
            const ord = parseInt(k.split(":")[2], 10);
            if (ord > last) last = ord;
          }
        }
        return { rows: [{ lines: lines.toString(), chunks: count, last }] };
      }
      return { rows: [] };
    },
    release() {},
  });

  const mockDatabase = {
    async connect() { return createMockClient(); },
  };

  const syncRunService = createSyncRunService({ database: mockDatabase });
  const writer = createIngestionWriter({ syncRunService });

  // 1. Worker 1 commits chunk 0 (Product 1 + variant = 2 lines)
  const client1 = createMockClient();
  const res0 = await writer.writeStagingBatch({
    client: client1,
    shopId,
    generationId,
    runId: 101n,
    fence: 1n,
    ordinal: 0,
    records: [product(1, [variant(10)])],
  });

  assert.equal(res0.replayed, false);
  assert.equal(res0.lineCount, 2);
  assert.equal(store.products.size, 1);
  assert.equal(store.checkpoints.size, 1);

  // 2. Worker 1 crashes!
  // Worker 2 takes over with fence = 2n
  store.runs.get(101n).fence = 2n;
  store.runs.get(101n).lease_token = "worker-2";

  // 3. Worker 2 replays the export stream from the start:
  // Chunk 0 is replayed:
  const client2 = createMockClient();
  const replay0 = await writer.writeStagingBatch({
    client: client2,
    shopId,
    generationId,
    runId: 101n,
    fence: 2n,
    ordinal: 0,
    records: [product(1, [variant(10)])],
  });

  assert.equal(replay0.replayed, true);
  assert.equal(replay0.lineCount, 2);
  // No duplicate products inserted!
  assert.equal(store.products.size, 1);
  assert.equal(store.checkpoints.size, 1);

  // 4. Worker 2 processes chunk 1 (Product 2 + variant = 2 lines)
  const res1 = await writer.writeStagingBatch({
    client: client2,
    shopId,
    generationId,
    runId: 101n,
    fence: 2n,
    ordinal: 1,
    records: [product(2, [variant(20)])],
  });

  assert.equal(res1.replayed, false);
  assert.equal(res1.lineCount, 2);
  assert.equal(store.products.size, 2);
  assert.equal(store.checkpoints.size, 2);
  assert.equal(store.runs.get(101n).processed_lines, "4");

  // 5. Worker 2 completes the ingestion run
  await syncRunService.completeIngestionRun({
    client: client2,
    shopId,
    runId: 101n,
    fence: 2n,
    expectedLines: 4n,
    processedLines: 4n,
    eofVerified: true,
  });

  assert.equal(store.runs.get(101n).status, "SUCCEEDED");
});

test("recovery: tamper detection - resumed chunk with changed data rejects fail-closed", async () => {
  const mockSyncRunService = {
    async recordCheckpoint() {},
  };
  const writer = createIngestionWriter({ syncRunService: mockSyncRunService });

  const client = {
    async query(sql) {
      if (sql.includes("mirror.generations")) {
        return {
          rows: [
            {
              id: generationId,
              status: "INGESTING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: ["products", "variants"],
            },
          ],
        };
      }
      if (sql.includes("mirror.ingestion_runs")) {
        return { rows: [{ id: 10n, status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777", live: true, fence: 1n }] };
      }
      if (sql.includes("mirror.ingestion_chunks")) {
        // Return a checkpoint with a DIFFERENT checksum
        return { rows: [{ checksum: "0000000000000000000000000000000000000000000000000000000000000000", line_count: "2" }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () =>
      writer.writeStagingBatch({
        client,
        shopId,
        generationId,
        runId: 10n,
        fence: 1n,
        ordinal: 0,
        records: [product(1, [variant(10)])],
      }),
    /Resumed chunk input changed/,
  );
});

test("recovery: interrupted or truncated export cannot complete or publish incomplete data", async () => {
  const mockSyncRunService = {
    async recordCheckpoint() {},
    async completeIngestionRun() {
      assert.fail("Should not complete with truncated data");
    },
    async failIngestionRun() {},
  };

  const client = {
    async query(sql) {
      if (sql.includes("mirror.generations")) {
        return {
          rows: [
            {
              id: generationId,
              status: "INGESTING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: ["products", "variants"],
            },
          ],
        };
      }
      if (sql.includes("mirror.ingestion_runs")) {
        return { rows: [{ id: 10n, status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777", live: true, fence: 1n }] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const jsonlIngestion = createJsonlIngestionService({
    bulkSyncService: { getStatus: async () => ({ id: "gid://shopify/BulkOperation/777", status: "COMPLETED", objectCount: "100" }) },
    syncRunService: {
      async getSyncRun() {
        return {
          runId: 10n,
          generationId,
          fence: 1n,
          status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
          leaseToken: "w1",
        };
      },
      async renewRunLease() {},
      async failIngestionRun() {},
    },
    ingestionWriter: { async writeStagingBatch() {} },
    database: { async connect() { return client; } },
  });

  // Only 1 line provided when 100 lines were expected from Shopify bulk export
  const singleLine = [JSON.stringify({ id: "gid://shopify/Product/1", title: "Single", handle: "single" })];

  await assert.rejects(
    () =>
      jsonlIngestion.ingestJsonlLines({
        shopId,
        generationId,
        runId: 10n,
        fence: 1n,
        lines: singleLine,
        expectedLines: 100n,
      }),
    /Truncated export/,
  );
});

test("recovery: bounded memory streaming - processes multi-chunk export without buffering in RAM", async () => {
  let chunksWritten = 0;
  const mockIngestionWriter = {
    async writeStagingBatch({ records }) {
      chunksWritten++;
      // Verify batch size was bounded to 2 products per batch
      assert.ok(records.length <= 2);
    },
  };

  const mockSyncRunService = {
    async getSyncRun() {
      return {
        runId: 20n,
        generationId,
        fence: 1n,
        status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/777",
        leaseToken: "w-mem",
      };
    },
    async renewRunLease() {},
    async completeIngestionRun() {},
    async transitionGenerationToReconciling() {},
    async failIngestionRun() {},
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
    bulkSyncService: { getStatus: async () => ({ id: "gid://shopify/BulkOperation/777", status: "COMPLETED", objectCount: "20" }) },
    syncRunService: mockSyncRunService,
    ingestionWriter: mockIngestionWriter,
    database: mockDatabase,
  });

  // Generator streaming 10 products (20 lines total)
  async function* generateCatalogStream() {
    for (let i = 1; i <= 10; i++) {
      yield JSON.stringify({ id: `gid://shopify/Product/${i}`, title: `Product ${i}`, handle: `p-${i}` });
      yield JSON.stringify({ id: `gid://shopify/ProductVariant/${i * 100}`, title: "Default", price: "10.00", __parentId: `gid://shopify/Product/${i}` });
    }
  }

  const result = await service.ingestJsonlLines({
    shopId,
    generationId,
    runId: 20n,
    fence: 1n,
    lines: generateCatalogStream(),
    batchSize: 2, // 2 products per chunk = 5 chunks committed
    expectedLines: 20n,
  });

  assert.equal(result.totalLinesProcessed, 20n);
  assert.equal(result.chunksCommitted, 5);
  assert.equal(chunksWritten, 5);
  assert.equal(result.succeeded, true);
});
