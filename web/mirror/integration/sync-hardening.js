import assert from "node:assert/strict";
import { createSyncRunService } from "../sync-run-service.server.js";
import { createIngestionWriter } from "../ingestion-writer.server.js";
import { createBulkOperationRunner } from "../bulk-operation-runner.server.js";
import { createReconciliationService } from "../reconciliation-service.server.js";
import { createPublicationRepository } from "../publication-repository.server.js";
import { transaction } from "../transactions.server.js";
import { createCursorService } from "../../filters/pagination.js";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const time = "2026-10-28T10:00:00.000Z";
export const variant = (id) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title: "Default",
  price: "10.00",
  compareAtPrice: null,
  inventoryPolicy: "DENY",
  inventoryQuantity: 2,
  taxable: true,
  requiresComponents: false,
  position: 1,
  createdAt: time,
  updatedAt: time,
});
export const product = (id = 1, variants = [variant(id * 10)]) => ({
  id: `gid://shopify/Product/${id}`,
  title: "Product",
  handle: `p-${id}`,
  status: "ACTIVE",
  tags: [],
  createdAt: time,
  updatedAt: time,
  variants,
});
function jsonl(products) {
  return products.flatMap(({ variants, ...p }) => [
    JSON.stringify(p),
    ...variants.map((v) => JSON.stringify({ ...v, __parentId: p.id })),
  ]);
}

export async function testSyncHardening(t, pool) {
  const shopId = "sync-hardening.myshopify.com",
    workerId = "worker-1";
  await pool.query(
    `INSERT INTO mirror.shops(id,installation_version) VALUES($1,'sync-install')`,
    [shopId],
  );
  const sync = createSyncRunService({ database: pool }),
    rec = createReconciliationService({ database: pool });
  const writer = createIngestionWriter({ syncRunService: sync });
  let expected = 0,
    operation = 100;
  const remote = {
    async request(query, { variables }) {
      if (query.includes("StartBulkOperation"))
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: {
                id: `gid://shopify/BulkOperation/${++operation}`,
                status: "CREATED",
              },
              userErrors: [],
            },
          },
        };
      return {
        data: {
          bulkOperation: {
            id: variables.id,
            status: "COMPLETED",
            objectCount: String(expected),
            url: "https://example.invalid/export",
          },
        },
      };
    },
  };
  const runner = createBulkOperationRunner({
    shopifyClient: remote,
    syncRunService: sync,
    ingestionWriter: writer,
    database: pool,
  });
  const start = async () => {
    const run = await sync.startIngestionRun({ shopId, workerId });
    await runner.initiateBulkCatalogExport({ shopId, syncRun: run });
    return run;
  };
  const ingest = async (run, products) => {
    const lines = jsonl(products);
    expected = lines.length;
    return runner.ingestJsonlLines({ shopId, ...run, lines, batchSize: 1 });
  };
  const event = (key, id = product().id) =>
    rec.recordMutationEvent({ shopId, productId: id, sourceKey: key });
  const reconcile = async (run, p, deleted = false) => {
    const claim = await rec.claimDirtyProduct({
      shopId,
      productId: p.id,
      workerId,
    });
    assert.ok(claim);
    return rec.reconcileProduct({
      shopId,
      generationId: run.generationId,
      productId: p.id,
      workerId,
      observedRevision: claim.revision,
      fence: claim.fence,
      productPayload: p,
      deleted,
    });
  };
  let run;
  await t.test(
    "interrupted streams retain atomic chunks; forged counts cannot seal and exact replay resumes",
    async () => {
      run = await start();
      const products = [product(1), product(2), product(3)];
      expected = 6;
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            writer.writeStagingBatch({
              client,
              shopId,
              ...run,
              ordinal: 0,
              records: [
                product(90, [
                  {
                    ...variant(900),
                    inventoryQuantity: "99999999999999999999999999999",
                  },
                ]),
              ],
            }),
          ),
        { code: "22003" },
      );
      assert.equal(
        (await sync.getSyncRun({ shopId, runId: run.runId })).processedLines,
        "0",
      );
      async function* interrupted() {
        for (const line of jsonl(products).slice(0, 3)) yield line;
        throw Error("download interrupted");
      }
      await assert.rejects(
        () =>
          runner.ingestJsonlLines({
            shopId,
            ...run,
            lines: interrupted(),
            batchSize: 1,
          }),
        /interrupted/,
      );
      const durable = (
        await pool.query(
          `SELECT processed_lines,status FROM mirror.ingestion_runs WHERE shop_id=$1 AND id=$2`,
          [shopId, run.runId],
        )
      ).rows[0];
      assert.equal(durable.processed_lines, "2");
      assert.equal(durable.status, "FAILED");
      run = await start();
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            writer.writeStagingBatch({
              client,
              shopId,
              ...run,
              ordinal: 0,
              records: [{ ...product(), title: "Changed input" }],
            }),
          ),
        /input changed/,
      );
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            sync.completeIngestionRun({
              client,
              shopId,
              ...run,
              expectedLines: 6n,
              processedLines: 6n,
              eofVerified: true,
            }),
          ),
        /incomplete/,
      );
      const result = await ingest(run, products);
      assert.equal(result.totalLinesProcessed, 6n);
      assert.equal(
        (
          await pool.query(
            `SELECT sum(line_count)::text AS n FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2`,
            [shopId, run.runId],
          )
        ).rows[0].n,
        "6",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT status FROM mirror.generations WHERE shop_id=$1 AND id=$2`,
            [shopId, run.generationId],
          )
        ).rows[0].status,
        "RECONCILING",
      );
      await assert.rejects(
        () =>
          pool.query(
            `UPDATE mirror.ingestion_chunks SET checksum=$3 WHERE shop_id=$1 AND run_id=$2`,
            [shopId, run.runId, "a".repeat(64)],
          ),
        { code: "23514" },
      );
    },
  );
  await t.test(
    "duplicate webhook delivery cannot advance a revision; stale workers cannot acknowledge new intent",
    async () => {
      const first = await event("event-1"),
        duplicate = await event("event-1");
      assert.equal(first.revision, duplicate.revision);
      assert.equal(duplicate.duplicate, true);
      const claim = await rec.claimDirtyProduct({
        shopId,
        productId: product().id,
        workerId,
      });
      await event("event-2");
      assert.equal(
        (
          await rec.reconcileProduct({
            shopId,
            generationId: run.generationId,
            productId: product().id,
            workerId,
            observedRevision: claim.revision,
            fence: claim.fence,
            productPayload: { ...product(), title: "stale" },
          })
        ).applied,
        false,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT title FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3`,
            [shopId, run.generationId, product().id],
          )
        ).rows[0].title,
        "Product",
      );
    },
  );
  await t.test(
    "authoritative replacement removes variants and obsolete product relationships",
    async () => {
      const id = (
        await pool.query(
          `SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3`,
          [shopId, run.generationId, product().id],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO mirror.product_options(shop_id,generation_id,shopify_id,product_id,name,position) VALUES($1,$2,'gid://shopify/ProductOption/1',$3,'Old',1)`,
        [shopId, run.generationId, id],
      );
      await reconcile(run, product(1, [variant(11), variant(12)]));
      const ids = (
        await pool.query(
          `SELECT shopify_id FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND product_id=$3 ORDER BY shopify_id`,
          [shopId, run.generationId, id],
        )
      ).rows.map((r) => r.shopify_id);
      assert.deepEqual(ids, [variant(11).id, variant(12).id]);
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::integer AS n FROM mirror.product_options WHERE shop_id=$1 AND generation_id=$2`,
            [shopId, run.generationId],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    "a webhook racing an in-flight acknowledgement remains dirty after the worker commits",
    async () => {
      await event("race-before");
      const claim = await rec.claimDirtyProduct({
        shopId,
        productId: product().id,
        workerId,
      });
      let unblock, reached;
      const gate = new Promise((resolve) => {
          unblock = resolve;
        }),
        atWrite = new Promise((resolve) => {
          reached = resolve;
        });
      const wrapped = {
        async connect() {
          const client = await pool.connect();
          return {
            async query(sql, values) {
              if (
                typeof sql === "string" &&
                sql.includes("INSERT INTO mirror.products")
              ) {
                reached();
                await gate;
              }
              return client.query(sql, values);
            },
            release(error) {
              client.release(error);
            },
          };
        },
      };
      const worker = createReconciliationService({ database: wrapped });
      const applying = worker.reconcileProduct({
        shopId,
        generationId: run.generationId,
        productId: product().id,
        workerId,
        observedRevision: claim.revision,
        fence: claim.fence,
        productPayload: product(),
      });
      await atWrite;
      let delivered = false;
      const incoming = event("race-during").then((result) => {
        delivered = true;
        return result;
      });
      try {
        await delay(30);
        assert.equal(delivered, false);
      } finally {
        unblock();
      }
      assert.equal((await applying).applied, true);
      const newer = await incoming;
      const row = (
        await pool.query(
          `SELECT dirty,revision,applied_revision FROM mirror.catalog_changes WHERE shop_id=$1 AND product_id=$2`,
          [shopId, product().id],
        )
      ).rows[0];
      assert.equal(row.dirty, true);
      assert.equal(BigInt(row.revision), newer.revision);
      assert.equal(BigInt(row.applied_revision), claim.revision);
      await reconcile(run, product());
    },
  );
  await t.test("concurrent claims issue exactly one owner", async () => {
    await event("parallel-claims");
    const claims = await Promise.all(
      ["worker-a", "worker-b"].map((id) =>
        rec.claimDirtyProduct({
          shopId,
          productId: product().id,
          workerId: id,
        }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1);
    await pool.query(
      `UPDATE mirror.catalog_changes SET lease_until=now()-interval '1 second' WHERE shop_id=$1`,
      [shopId],
    );
    await reconcile(run, product());
  });
  await t.test(
    "database write failure rolls back revision acknowledgement and catalog replacement",
    async () => {
      await event("bad-write");
      const p = product(1, [
        { ...variant(13), inventoryQuantity: "99999999999999999999999999999" },
      ]);
      await assert.rejects(() => reconcile(run, p), { code: "22003" });
      const row = (
        await pool.query(
          `SELECT dirty,revision,applied_revision FROM mirror.catalog_changes WHERE shop_id=$1 AND product_id=$2`,
          [shopId, p.id],
        )
      ).rows[0];
      assert.equal(row.dirty, true);
      assert.notEqual(row.revision, row.applied_revision);
      await pool.query(
        `UPDATE mirror.catalog_changes SET lease_until=now()-interval '1 second' WHERE shop_id=$1`,
        [shopId],
      );
      await reconcile(run, product());
    },
  );
  await t.test(
    "deletion removes searchable rows but preserves durable tombstone intent",
    async () => {
      await event("delete");
      await reconcile(run, product(), true);
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::integer AS n FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3`,
            [shopId, run.generationId, product().id],
          )
        ).rows[0].n,
        0,
      );
      const tombstone = (
        await pool.query(
          `SELECT dirty,deleted FROM mirror.catalog_changes WHERE shop_id=$1 AND product_id=$2`,
          [shopId, product().id],
        )
      ).rows[0];
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.dirty, false);
    },
  );
  await t.test(
    "clean redundant jobs make no remote request; failure/backoff/dead-letter bounds are durable",
    async () => {
      await rec.reconcileLatestProduct({
        shopId,
        generationId: run.generationId,
        productId: product().id,
        workerId,
        fetchProduct: () => assert.fail("Clean row requested remotely"),
      });
      await event("retry");
      let claim = await rec.claimDirtyProduct({
        shopId,
        productId: product().id,
        workerId,
      });
      await rec.recordFailure({
        shopId,
        productId: product().id,
        fence: claim.fence,
        error: Error("network"),
        maxAttempts: 2,
      });
      assert.equal(
        await rec.claimDirtyProduct({
          shopId,
          productId: product().id,
          workerId,
        }),
        null,
      );
      await pool.query(
        `UPDATE mirror.catalog_changes SET next_attempt_at=now()-interval '1 second' WHERE shop_id=$1`,
        [shopId],
      );
      claim = await rec.claimDirtyProduct({
        shopId,
        productId: product().id,
        workerId,
      });
      await rec.recordFailure({
        shopId,
        productId: product().id,
        fence: claim.fence,
        error: Error("network"),
        maxAttempts: 2,
      });
      assert.equal((await rec.scanDueDirtyProducts({ shopId })).length, 0);
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            sync.completeCoverageAndVerify({
              client,
              shopId,
              generationId: run.generationId,
            }),
          ),
        /Unreconciled/,
      );
    },
  );
  await t.test(
    "failed staging recovery requeues clean acknowledgements; cancellation fences old run",
    async () => {
      await sync.cancelGeneration({ shopId, generationId: run.generationId });
      const old = run;
      run = await start();
      assert.notEqual(old.generationId, run.generationId);
      assert.equal(
        (
          await pool.query(
            `SELECT dirty FROM mirror.catalog_changes WHERE shop_id=$1`,
            [shopId],
          )
        ).rows[0].dirty,
        true,
      );
      expected = 0;
      await runner.completeEmptyStoreIngestion({ shopId, ...run });
      const result = await rec.reconcileLatestProduct({
        shopId,
        generationId: run.generationId,
        productId: product().id,
        workerId,
        fetchProduct: async () => ({ complete: true, product: product() }),
      });
      assert.equal(result.applied, true);
      await assert.rejects(
        () =>
          rec.reconcileProduct({
            shopId,
            generationId: old.generationId,
            productId: product().id,
            workerId,
            observedRevision: 1n,
            fence: 1n,
            deleted: true,
          }),
        /staging/,
      );
    },
  );
  await t.test(
    "verification and publication fence concurrent events and stale expected pointer",
    async () => {
      await transaction(pool, (client) =>
        sync.completeCoverageAndVerify({
          client,
          shopId,
          generationId: run.generationId,
        }),
      );
      await event("after-verification");
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            sync.publishGeneration({
              client,
              shopId,
              generationId: run.generationId,
              expectedGenerationId: null,
            }),
          ),
        /mutations/,
      );
      await sync.cancelGeneration({ shopId, generationId: run.generationId });
      run = await start();
      expected = 0;
      await runner.completeEmptyStoreIngestion({ shopId, ...run });
      await reconcile(run, product());
      await transaction(pool, async (client) => {
        await sync.completeCoverageAndVerify({
          client,
          shopId,
          generationId: run.generationId,
        });
        await sync.publishGeneration({
          client,
          shopId,
          generationId: run.generationId,
          expectedGenerationId: null,
        });
      });
    },
  );
  await t.test(
    "old published generations stay readable across promotion and cannot be reclaimed while retained",
    async () => {
      const old = run,
        repository = createPublicationRepository({ database: pool });
      const context = await repository.getPublishedContext({ shopId });
      assert.equal(context.generationId, old.generationId);
      run = await start();
      expected = 0;
      await runner.completeEmptyStoreIngestion({ shopId, ...run });
      await reconcile(run, product());
      await transaction(pool, (client) =>
        sync.completeCoverageAndVerify({
          client,
          shopId,
          generationId: run.generationId,
        }),
      );
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            sync.publishGeneration({
              client,
              shopId,
              generationId: run.generationId,
              expectedGenerationId: null,
            }),
          ),
        /superseded/,
      );
      await transaction(pool, (client) =>
        sync.publishGeneration({
          client,
          shopId,
          generationId: run.generationId,
          expectedGenerationId: old.generationId,
        }),
      );
      assert.equal(
        (
          await repository.getPublishedContext({
            shopId,
            generationId: old.generationId,
          })
        ).generationId,
        old.generationId,
      );
      await assert.rejects(
        () =>
          sync.reclaimGeneration({ shopId, generationId: old.generationId }),
        /retained/,
      );
      await assert.rejects(
        () =>
          pool.query(
            `UPDATE mirror.generations SET retain_until=NULL WHERE shop_id=$1 AND id=$2`,
            [shopId, old.generationId],
          ),
        { code: "23514" },
      );
    },
  );
  await t.test(
    "cursor routing verifies signature/shop before retained context lookup",
    async () => {
      const cursors = createCursorService({ secret: randomBytes(32) });
      const binding = {
        shopId,
        generationId: run.generationId,
        fingerprint: "a".repeat(64),
        schemaFingerprint: "b".repeat(64),
        idType: "bigint",
        ordering: "bigint:native",
      };
      const cursor = cursors.issue(binding, "1");
      assert.equal(
        cursors.readContext(cursor, shopId).generationId,
        run.generationId,
      );
      assert.throws(() => cursors.readContext(cursor, "other.myshopify.com"));
      assert.throws(() => cursors.readContext(cursor + "x", shopId));
    },
  );
  await t.test(
    "aborted ingestion durably cancels the generation and cannot seal or resume its stale fence",
    async () => {
      const cancelled = await start(),
        controller = new AbortController();
      expected = 2;
      async function* lines() {
        yield jsonl([product()])[0];
        controller.abort();
        yield jsonl([product()])[1];
      }
      await assert.rejects(
        () =>
          runner.ingestJsonlLines({
            shopId,
            ...cancelled,
            lines: lines(),
            signal: controller.signal,
          }),
        { name: "AbortError" },
      );
      assert.equal(
        (await sync.getSyncRun({ shopId, runId: cancelled.runId })).status,
        "CANCELLED",
      );
      await assert.rejects(
        () =>
          transaction(pool, (client) =>
            sync.completeIngestionRun({
              client,
              shopId,
              ...cancelled,
              expectedLines: 0n,
              processedLines: 0n,
              eofVerified: true,
            }),
          ),
        /superseded/,
      );
    },
  );
}
