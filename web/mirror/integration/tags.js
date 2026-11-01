import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSyncRunService } from "../sync-run-service.server.js";
import { createIngestionWriter } from "../ingestion-writer.server.js";
import { createBulkOperationRunner } from "../bulk-operation-runner.server.js";
import { createReconciliationService } from "../reconciliation-service.server.js";
import { createInstalledFilterHttpRuntime } from "../../services/filter-engine.server.js";
import { transaction } from "../transactions.server.js";
import { product } from "./sync-hardening.js";

export async function testTags(t, pool) {
  const shops = [
    "tags-a.myshopify.com",
    "tags-b.myshopify.com",
    "tags-invalid.myshopify.com",
  ];
  const sync = createSyncRunService({ database: pool });
  const reconciliation = createReconciliationService({ database: pool });
  const runs = new Map();
  let operation = 2000,
    expected = 0;
  const runner = createBulkOperationRunner({
    database: pool,
    syncRunService: sync,
    ingestionWriter: createIngestionWriter({ syncRunService: sync }),
    shopifyClient: {
      async request(query, { variables }) {
        return query.includes("StartBulkOperation")
          ? {
              data: {
                bulkOperationRunQuery: {
                  bulkOperation: {
                    id: `gid://shopify/BulkOperation/${++operation}`,
                    status: "CREATED",
                  },
                  userErrors: [],
                },
              },
            }
          : {
              data: {
                bulkOperation: {
                  id: variables.id,
                  status: "COMPLETED",
                  objectCount: String(expected),
                },
              },
            };
      },
    },
  });
  async function ingest(shopId, products) {
    const run = await sync.startIngestionRun({
      shopId,
      workerId: "tags-worker",
    });
    runs.set(shopId, run);
    await runner.initiateBulkCatalogExport({ shopId, syncRun: run });
    const lines = products.flatMap(({ variants, ...p }) => [
      JSON.stringify(p),
      ...variants.map((v) => JSON.stringify({ ...v, __parentId: p.id })),
    ]);
    expected = lines.length;
    await runner.ingestJsonlLines({ shopId, ...run, lines, batchSize: 1 });
    return run;
  }
  async function replaceTags(id, tags) {
    const shopId = shops[0];
    await reconciliation.recordMutationEvent({
      shopId,
      productId: product(id).id,
      sourceKey: `replace-tags-${id}`,
    });
    const claim = await reconciliation.claimDirtyProduct({
      shopId,
      productId: product(id).id,
      workerId: "tags-worker",
    });
    const result = await reconciliation.reconcileProduct({
      shopId,
      generationId: runs.get(shopId).generationId,
      productId: product(id).id,
      workerId: "tags-worker",
      observedRevision: claim.revision,
      fence: claim.fence,
      deleted: false,
      productPayload: { ...product(id), tags },
    });
    assert.equal(result.applied, true);
  }

  await t.test(
    "complete JSONL tag ingestion preserves every tag and reconciliation replaces or clears the whole list",
    async () => {
      for (const shopId of shops)
        await pool.query(
          "INSERT INTO mirror.shops(id,installation_version) VALUES($1,'tags-test')",
          [shopId],
        );
      const lists = [
        [],
        ["Summer", "Sale"],
        ["summer"],
        ["Summerish", "100%_literal", "a,b", "quote'", " leading "],
        ["To clear"],
      ];
      await ingest(
        shops[0],
        lists.map((tags, index) => ({ ...product(index + 1), tags })),
      );
      await ingest(shops[1], [
        { ...product(1), tags: ["Summer"] },
        { ...product(2), tags: ["Foreign"] },
      ]);
      const stored = (
        await pool.query(
          "SELECT tags FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 ORDER BY shopify_id",
          [shops[0], runs.get(shops[0]).generationId],
        )
      ).rows;
      assert.deepEqual(
        stored.map((row) => row.tags),
        lists,
      );
      await replaceTags(2, ["Summer", "New"]);
      await replaceTags(5, []);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT shopify_id,tags FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=ANY($3::text[]) ORDER BY shopify_id",
            [
              shops[0],
              runs.get(shops[0]).generationId,
              [product(2).id, product(5).id],
            ],
          )
        ).rows,
        [
          { shopify_id: product(2).id, tags: ["Summer", "New"] },
          { shopify_id: product(5).id, tags: [] },
        ],
      );
      for (const shopId of shops.slice(0, 2)) {
        const { generationId } = runs.get(shopId);
        await transaction(pool, async (client) => {
          await sync.completeCoverageAndVerify({
            client,
            shopId,
            generationId,
          });
          await sync.publishGeneration({
            client,
            shopId,
            generationId,
            expectedGenerationId: null,
          });
        });
      }
      const { tags, ...missing } = product(1);
      await assert.rejects(() => ingest(shops[2], [missing]), /tags/);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::text AS n FROM mirror.products WHERE shop_id=$1",
            [shops[2]],
          )
        ).rows[0].n,
        "0",
      );
      assert.equal(
        (
          await sync.getSyncRun({
            shopId: shops[2],
            runId: runs.get(shops[2]).runId,
          })
        ).processedLines,
        "0",
      );
      await sync.cancelGeneration({
        shopId: shops[2],
        generationId: runs.get(shops[2]).generationId,
      });
    },
  );

  await t.test(
    "tag contains and does-not-contain match empty/multiple lists exactly and remain isolated by authenticated tenant",
    async () => {
      const sessions = new Map(
        shops
          .slice(0, 2)
          .map((shop, index) => [
            `tags-session-${index}`,
            {
              id: `tags-session-${index}`,
              shop,
              isOnline:false,
              scope: "read_products",
              accessToken: "test-token",
            },
          ]),
      );
      const runtime = await createInstalledFilterHttpRuntime({
        database: pool,
        sessionStorage: { loadSession: async (id) => sessions.get(id) },
        cursorSecret: randomBytes(32),
        logger: { error() {} },
      });
      async function search(tenant, operator, value, extra = []) {
        const req = {
          query: {
            filters: JSON.stringify([
              {
                field: "product.tags",
                operator,
                ...(value === undefined ? {} : { value }),
              },
              ...extra,
            ]),
          },
        };
        let status = 200,
          body;
        const res = {
          locals: {
            shopify: { session: sessions.get(`tags-session-${tenant}`) },
          },
          setHeader() {},
          status(value) {
            status = value;
            return this;
          },
          json(value) {
            body = value;
            return this;
          },
        };
        await runtime.capture(req, res, error => {if(error)throw error;});
        await runtime.catalog(req, res, (error) => {
          throw error;
        });
        assert.equal(status, 200, JSON.stringify(body));
        assert.equal(body.snapshotId, runs.get(shops[tenant]).generationId);
        assert.equal(body.filteredCount, body.products.length);
        return body.products
          .map((p) => Number(p.id.split("/").at(-1)))
          .sort((a, b) => a - b);
      }
      for (const [operator, value, expectedA, expectedB] of [
        ["list_contains", "Summer", [2], [1]],
        ["list_not_contains", "Summer", [1, 3, 4, 5], [2]],
        ["list_contains", "summer", [3], []],
        ["list_not_contains", "summer", [1, 2, 4, 5], [1, 2]],
        ["list_contains", "Sale", [], []],
        ["list_contains", "New", [2], []],
        ["list_contains", "Foreign", [], [2]],
        ["list_not_contains", "Foreign", [1, 2, 3, 4, 5], [1]],
        ["list_contains", "100%_literal", [4], []],
        ["list_contains", "100", [], []],
        ["list_contains", "a,b", [4], []],
        ["list_contains", "quote'", [4], []],
        ["list_contains", " leading ", [4], []],
        ["is_empty", undefined, [1, 5], []],
        ["is_not_empty", undefined, [2, 3, 4], [1, 2]],
      ]) {
        assert.deepEqual(
          await search(0, operator, value),
          expectedA,
          `${operator}: ${value}, tenant A`,
        );
        assert.deepEqual(
          await search(1, operator, value),
          expectedB,
          `${operator}: ${value}, tenant B`,
        );
      }
      assert.deepEqual(
        await search(0, "list_contains", "Summer", [
          { field: "product.tags", operator: "list_contains", value: "New" },
        ]),
        [2],
      );
    },
  );
}
