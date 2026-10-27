import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client.js";
import {
  registerShop,
  shopHash,
  processLifecycle,
} from "../domains/lifecycle/lifecycle.repository.js";
import { processSyncJob, createSyncWorker } from "../workers/sync.worker.js";
import { persistOfflineInstallation } from "../domains/lifecycle/offline-session.js";
import { consumeInitialSyncRequest } from "../domains/sync/initial-sync.consumer.js";
import { Session } from "@shopify/shopify-api";
import { setTimeout as sleep } from "node:timers/promises";
import { claimSnapshotLease } from "../domains/sync/sync.lease.js";
import { stageSnapshotProducts } from "../domains/snapshots/snapshots.service.js";
import {
  recordProductWebhook,
  recordInventoryWebhook,
} from "../domains/webhooks/webhooks.repository.js";
import { readPublishedProduct } from "../domains/products/products.service.js";
import { readProductCatalog } from "../domains/products/products.catalog.js";
import { processReconciliationJob } from "../workers/reconcile.worker.js";
import { readActiveCatalogCounts } from "../domains/sync/sync.routes.js";
import {
  findDueSyncRuns,
  createSyncScanner,
} from "../domains/sync/sync.scanner.js";
import { observation } from "./fixtures/inventory.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const shops = [];
const productId = "gid://shopify/Product/123";
const product = (title = "Exported") => ({
  id: productId,
  title,
  updatedAt: "2026-10-25T00:00:00Z",
  variantsCount: { count: 1, precision: "EXACT" },
});
const variant = {
  id: "gid://shopify/ProductVariant/123",
  __parentId: productId,
  position: 1,
  price: "19.99999999999999",
  compareAtPrice: null,
  inventoryItem: { id: "gid://shopify/InventoryItem/123" },
};
async function fixture() {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  await registerShop(shop);
  const merchant = await prisma.shop.update({ where: { domain: shop }, data: { installationVerified: true } });
  return { shop, runId: merchant.activeRunId, generation: merchant.generation };
}
async function due(f) {
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { nextCheckAt: new Date(0) },
  });
}
async function step(f, options) {
  await due(f);
  return processSyncJob(f, options);
}
function fakeShopify({ empty = false } = {}) {
  const inventory = observation(1);
  const rows = {
    products: empty ? [] : [product(), variant],
    inventory_items: empty
      ? []
      : [
          inventory.item,
          ...inventory.levels.map((row) => ({
            ...row,
            __parentId: inventory.item.id,
          })),
        ],
    inventory_locations: empty ? [] : [inventory.levels[0].location],
  };
  const operations = new Map();
  let created = 0,
    loseResponse = false;
  const options = {
    bulkAppId: "integration-app",
    async graphql(shop, query, variables, context) {
      assert.ok(context.generation);
      assert.ok(context.signal);
      if (query.includes("FindCatalogExport"))
        return {
          bulkOperations: {
            nodes: [...operations.values()].map(({ id, query }) => ({
              id,
              query,
            })),
            pageInfo: { hasNextPage: false },
          },
        };
      if (query.includes("StartCatalogExport")) {
        const name = Object.keys(rows).find((name) =>
          variables.query.includes(`_${name} {`),
        );
        assert.ok(name, variables.query);
        const id = `gid://shopify/BulkOperation/${++created}`;
        operations.set(id, {
          id,
          query: variables.query,
          name,
          status: "COMPLETED",
          rootObjectCount: String(
            rows[name].filter((row) => !row.__parentId).length,
          ),
          objectCount: String(rows[name].length),
          url: rows[name].length
            ? `https://storage.googleapis.com/${id.split("/").at(-1)}`
            : null,
        });
        if (loseResponse) {
          loseResponse = false;
          throw Error("response lost after Shopify accepted mutation");
        }
        return {
          bulkOperationRunQuery: { bulkOperation: { id }, userErrors: [] },
        };
      }
      const op = operations.get(variables.id);
      return { bulkOperation: op };
    },
    async *download(url) {
      const op = operations.get(
        `gid://shopify/BulkOperation/${url.split("/").at(-1)}`,
      );
      for (const row of rows[op.name]) yield JSON.stringify(row);
    },
    fetchProduct: async () => ({
      product: product("Latest webhook state"),
      variants: [variant],
    }),
    fetchInventory: async () => inventory,
  };
  return {
    options,
    rows,
    operations,
    get created() {
      return created;
    },
    loseResponse() {
      loseResponse = true;
    },
  };
}
async function webhook(f, topic = "products/update") {
  const id = randomUUID();
  return recordProductWebhook({
    id,
    eventId: id,
    shop: f.shop,
    productId,
    topic,
    payloadHash: "a".repeat(64),
    triggeredAt: new Date(),
  });
}
async function finishImports(f, options) {
  for (let i = 0; i < 10; i++) {
    const run = await prisma.snapshotRun.findUnique({ where: { id: f.runId } });
    if (run.status === "RECONCILING") return;
    await step(f, options);
  }
  assert.fail("Import did not reach reconciliation");
}
after(async () => {
  await prisma.bulkQueryClaim.deleteMany({ where: { shop: { in: shops } } });
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.installationState.deleteMany({
    where: { shopHash: { in: shops.map(shopHash) } },
  });
  await prisma.lifecycleReceipt.deleteMany({
    where: { shopHash: { in: shops.map(shopHash) } },
  });
  await prisma.$disconnect();
});

test("registration durably schedules once and the scanner recovers without Redis delivery", async () => {
  const f = await fixture();
  await registerShop(f.shop);
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 1);
  assert.ok((await findDueSyncRuns()).some((row) => row.id === f.runId));
  const queued = [];
  await createSyncScanner({
    queue: null,
    enqueue: async (_shop, id) => queued.push(id),
  })();
  assert.ok(queued.includes(f.runId));
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { nextCheckAt: new Date(Date.now() + 60000) },
  });
  assert.ok(!(await findDueSyncRuns()).some((row) => row.id === f.runId));
  const result = await processSyncJob(f, {
    graphql: async () => assert.fail("A future retry must not call Shopify"),
  });
  assert.equal(result.status, "lease_unavailable");
});

test(
  "installation dispatch crosses real Redis and worker boundaries and publishes the mirror",
  { timeout: 120000 },
  async () => {
    const shop = `test-${randomUUID()}.myshopify.com`;
    shops.push(shop);
    const remote = fakeShopify();
    const worker = createSyncWorker({ ...remote.options, concurrency: 1 });
    const completed = [],
      failures = [];
    worker.on("completed", (job) => {
      if (job.data.shop === shop) completed.push(job.id);
    });
    worker.on("failed", (job, error) => {
      if (job?.data.shop === shop) failures.push(error);
    });
    // The production scanner, scoped to this fixture so this worker cannot
    // consume any other installation's test runs.
    const scan = createSyncScanner({
      db: {
        snapshotRun: {
          findMany: (args) =>
            prisma.snapshotRun.findMany({
              ...args,
              where: { ...args.where, shop },
            }),
        },
      },
    });
    try {
      await worker.waitUntilReady();
      await persistOfflineInstallation(
        new Session({
          id: `offline_${shop}`,
          shop,
          isOnline: false,
          state: "test",
          scope: "read_products,read_inventory,read_locations",
          accessToken: "test-only-token",
        }),
      ); // Use the default queue dispatch, not an injected enqueue stub.
      const merchant = await prisma.shop.findUniqueOrThrow({
        where: { domain: shop },
      });
      const runId = merchant.activeRunId;
      assert.ok(runId);
      let processedCompletions = 0;
      const deadline = Date.now() + 110000;
      let run;
      while (Date.now() < deadline) {
        if (failures.length) throw failures[0];
        run = await prisma.snapshotRun.findUniqueOrThrow({
          where: { id: runId },
        });
        if (run.status === "COMPLETED") break;
        if (run.status === "FAILED") assert.fail(run.lastError);
        if (completed.length > processedCompletions) {
          processedCompletions = completed.length;
          // Advance only the fixture's polling delay; keep all normal lease,
          // ingestion, reconciliation, and publication checks in the worker.
          await prisma.snapshotRun.updateMany({
            where: { id: runId, leaseToken: null },
            data: { nextCheckAt: new Date(0) },
          });
          await scan();
        }
        await sleep(250);
      }
      assert.equal(
        run.status,
        "COMPLETED",
        "installation must reach publication through the queue",
      );
      assert.ok(
        completed.length > 0,
        "the installation job must be consumed without a scanner kick",
      );
      assert.equal(run.importedProducts, 1);
      assert.equal(run.expectedProducts, 1);
      assert.equal(remote.created, 3, "one export per dataset");
      assert.equal(await prisma.snapshotDataset.count({ where: { runId } }), 4);
      assert.equal(
        await prisma.variant.count({ where: { shop, snapshotId: runId } }),
        1,
      );
      assert.equal(
        (await readPublishedProduct(shop, productId)).data.title,
        "Exported",
      );
      const catalog = await readProductCatalog(shop);
      assert.equal(catalog.syncStatus, "READY");
      assert.equal(catalog.snapshotId, runId);
      assert.equal(catalog.products.length, 1);
      assert.equal(catalog.products[0].id, productId);
      const receipt = await consumeInitialSyncRequest(
        shop,
        merchant.generation,
      );
      assert.equal(receipt.status, "COMPLETED");
      assert.equal(await prisma.snapshotRun.count({ where: { shop } }), 1);
    } finally {
      await worker.close();
      await prisma.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop"=${shop}`;
    }
  },
);
test("automatic import commits every baseline, reconciles concurrent changes, and publishes READY", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  await step(f, remote.options); // Export launched; webhook arrives during export.
  await webhook(f);
  const inventoryEvent = randomUUID();
  await recordInventoryWebhook({
    id: inventoryEvent,
    eventId: inventoryEvent,
    shop: f.shop,
    inventoryItemId: "gid://shopify/InventoryItem/123",
    topic: "inventory_levels/update",
    payloadHash: "c".repeat(64),
    triggeredAt: new Date(),
  });
  const latestInventory = observation(1);
  latestInventory.levels[0].isActive = true;
  latestInventory.levels[0].quantities[0].quantity = 42;
  remote.options.fetchInventory = async () => latestInventory;
  await finishImports(f, remote.options);
  assert.equal(await readPublishedProduct(f.shop, productId), null);
  const importingCatalog = await readProductCatalog(f.shop);
  assert.equal(importingCatalog.syncStatus, "RECONCILING");
  assert.equal(importingCatalog.snapshotId, null);
  assert.deepEqual(importingCatalog.products, []);
  const staged = await prisma.snapshotRun.findUnique({
    where: { id: f.runId },
  });
  assert.equal(staged.importedProducts, 1);
  assert.equal(
    await prisma.snapshotDataset.count({ where: { runId: f.runId } }),
    4,
  );
  assert.equal((await step(f, remote.options)).published, true);
  assert.equal(
    (await readPublishedProduct(f.shop, productId)).data.title,
    "Latest webhook state",
  );
  assert.equal((await readActiveCatalogCounts(f.shop)).syncStatus, "READY");
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop: f.shop, productId } },
  });
  assert.equal(change.dirty, false);
  assert.equal(change.appliedRevision, change.revision);
  assert.equal(
    (
      await prisma.inventoryQuantity.findFirst({
        where: { shop: f.shop, snapshotId: f.runId, name: "available" },
      })
    ).quantity,
    42,
  );
  assert.equal((await processSyncJob(f, remote.options)).status, "not_active");
  const readyCatalog = await readProductCatalog(f.shop);
  assert.equal(readyCatalog.syncStatus, "READY");
  assert.equal(readyCatalog.products[0].title, "Latest webhook state");
  assert.equal(readyCatalog.products[0].totalInventory, 42);

  await webhook(f);
  await processReconciliationJob(
    { shop: f.shop, productId, revision: 0 },
    {
      fetchProduct: async () => ({
        product: product("Updated after publication"),
        variants: [variant],
      }),
    },
  );
  assert.equal(
    (await readProductCatalog(f.shop)).products[0].title,
    "Updated after publication",
  );
  await webhook(f, "products/delete");
  await processReconciliationJob(
    { shop: f.shop, productId },
    { fetchProduct: async () => null },
  );
  const deletedCatalog = await readProductCatalog(f.shop);
  assert.deepEqual(deletedCatalog.products, []);
  assert.equal(deletedCatalog.summary.productCount, 0);
});

test("restart replays committed products idempotently and drains a deletion received during import", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  const second = { ...product(), id: "gid://shopify/Product/124" };
  remote.rows.products.push(second, {
    ...variant,
    id: "gid://shopify/ProductVariant/124",
    __parentId: second.id,
  });
  await step(f, remote.options);
  const partial = {
    ...remote.options,
    download: async function* () {
      for (const row of remote.rows.products.slice(0, 3))
        yield JSON.stringify(row);
      throw Error("download disconnected");
    },
  };
  await assert.rejects(step(f, partial), /download disconnected/);
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .importedProducts,
    1,
  );
  await webhook(f, "products/delete");
  await finishImports(f, remote.options);
  remote.options.fetchProduct = async () => null;
  await step(f, remote.options);
  assert.equal(await readPublishedProduct(f.shop, productId), null);
  assert.ok(await readPublishedProduct(f.shop, second.id));
  assert.equal((await readActiveCatalogCounts(f.shop)).productCount, 1);
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .importedProducts,
    2,
  );
});
test("a verified empty store imports and publishes without a download URL", async () => {
  const f = await fixture(),
    remote = fakeShopify({ empty: true });
  await finishImports(f, remote.options);
  await step(f, remote.options);
  const counts = await readActiveCatalogCounts(f.shop);
  assert.equal(counts.productCount, 0);
  assert.equal(counts.variantCount, 0);
  assert.equal(counts.syncStatus, "READY");
});
test("lost mutation response recovers the same run-specific operation on restart", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  remote.loseResponse();
  await assert.rejects(step(f, remote.options), /response lost/);
  const failed = await prisma.snapshotRun.findUnique({
    where: { id: f.runId },
  });
  assert.equal(failed.status, "STARTING");
  assert.equal(failed.attempts, 1);
  assert.ok(failed.nextCheckAt > new Date());
  await step(f, remote.options);
  assert.equal(remote.created, 1);
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .bulkOperationId,
    "gid://shopify/BulkOperation/1",
  );
});

test("dispatch rereads the owned run after claiming instead of using a stale phase", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  await step(f, remote.options);
  const original = prisma.snapshotRun.findUnique;
  let reads = 0;
  prisma.snapshotRun.findUnique = async function (args) {
    const current = await original.call(this, args);
    return args.where.id === f.runId && ++reads === 1
      ? { ...current, status: "RECONCILING" }
      : current;
  };
  try {
    const result = await step(f, remote.options);
    assert.equal(result.status, "PENDING");
    assert.ok(reads >= 2);
  } finally {
    prisma.snapshotRun.findUnique = original;
  }
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .exportName,
    "inventory_items",
  );
});
test("a truncated download persists retry eligibility and never enters reconciliation", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  await step(f, remote.options);
  const partial = {
    ...remote.options,
    download: async function* () {
      yield JSON.stringify(product());
    },
  };
  await assert.rejects(step(f, partial));
  const run = await prisma.snapshotRun.findUnique({ where: { id: f.runId } });
  assert.equal(run.status, "INGESTING");
  assert.equal(run.attempts, 1);
  assert.equal(run.leaseToken, null);
  assert.equal((await readActiveCatalogCounts(f.shop)).snapshotId, null);
  await step(f, remote.options);
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .exportName,
    "inventory_items",
  );
});
test("expired import workers cannot stage data after a replacement claim", async () => {
  const f = await fixture();
  const run = await prisma.snapshotRun.findUnique({ where: { id: f.runId } });
  const old = await claimSnapshotLease(run, { includeIngestion: true });
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: {
      status: "INGESTING",
      expectedProducts: 1,
      leasedUntil: new Date(0),
    },
  });
  await claimSnapshotLease(run, { includeIngestion: true });
  await assert.rejects(
    stageSnapshotProducts({
      ...f,
      products: [{ product: product(), variants: [variant] }],
      leaseToken: old.token,
    }),
    { code: "SYNC_LEASE_LOST" },
  );
  assert.equal(
    await prisma.snapshotProduct.count({ where: { runId: f.runId } }),
    0,
  );
});
test("terminal export failures stop after bounded retries and remain unpublished", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  await step(f, remote.options);
  for (const op of remote.operations.values()) op.status = "FAILED";
  for (let i = 0; i < 8; i++)
    await assert.rejects(step(f, remote.options), {
      code: "BULK_EXPORT_FAILED",
    });
  const run = await prisma.snapshotRun.findUnique({ where: { id: f.runId } });
  assert.equal(run.status, "FAILED");
  assert.equal(run.attempts, 8);
  assert.equal((await readActiveCatalogCounts(f.shop)).syncStatus, "FAILED");
  assert.ok(!(await findDueSyncRuns()).some((row) => row.id === f.runId));
});
test("uninstall fences an in-flight export before it can stage or publish", async () => {
  const f = await fixture(),
    remote = fakeShopify();
  await step(f, remote.options);
  const options = {
    ...remote.options,
    download: async function* (url) {
      await processLifecycle({
        id: randomUUID(),
        shop: f.shop,
        topic: "app/uninstalled",
        payloadHash: "b".repeat(64),
        triggeredAt: new Date(),
      });
      yield* remote.options.download(url);
    },
  };
  await assert.rejects(step(f, options));
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: f.shop } }))
      .activeSnapshotId,
    null,
  );
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 0);
});
