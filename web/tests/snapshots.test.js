import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const {
  startCatalogSnapshot,
  stageSnapshotProducts,
  sealCatalogSnapshot,
  publishCatalogSnapshot: publishRaw,
  cancelCatalogSnapshot,
} = await import("../domains/snapshots/snapshots.service.js");
const { reconcileAndPublishSnapshot } = await import(
  "../domains/sync/sync.coordinator.js"
);
const publishCatalogSnapshot = (args, options = {}) =>
  reconcileAndPublishSnapshot(args, {
    fetchProduct: async () => envelope(),
    ...options,
  });
const { recordProductWebhook } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { reconcileProduct } = await import(
  "../domains/webhooks/webhooks.service.js"
);
const { scanDirtyChanges } = await import("../workers/reconcile.scanner.js");
const { runRetention } = await import("../workers/retention.js");
const { reconcileQueue } = await import("../queues/reconcile.queue.js");
const shops = [];
const productId = "gid://shopify/Product/123";
const envelope = (title = "Baseline") => ({
  product: {
    id: productId,
    title,
    updatedAt: "2026-10-25T00:00:00Z",
    variantsCount: { count: 0, precision: "EXACT" },
  },
  variants: [],
});
async function fixture() {
  const shop = `test-${randomUUID()}.myshopify.com`;
  const merchant = await prisma.shop.create({ data: { domain: shop } });
  shops.push(shop);
  return { shop, generation: merchant.generation };
}
const change = (shop) =>
  prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
const { readPublishedProduct } = await import(
  "../domains/products/products.service.js"
);
const mirror = (shop) => readPublishedProduct(shop, productId);
async function webhook(shop) {
  const id = randomUUID();
  return recordProductWebhook({
    id,
    eventId: id,
    shop,
    productId,
    topic: "products/update",
    payloadHash: "e".repeat(64),
    triggeredAt: new Date(),
  });
}
async function prepared(input, title = "Baseline", expectedProducts = 1) {
  const run = await startCatalogSnapshot({ ...input, expectedProducts });
  const args = { ...input, runId: run.id };
  if (expectedProducts)
    await stageSnapshotProducts({ ...args, products: [envelope(title)] });
  await sealCatalogSnapshot(args);
  return args;
}
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await reconcileQueue.close();
  await prisma.$disconnect();
});

test("missing initial snapshot defers without a Shopify read, lease, or failed attempt", async () => {
  const input = await fixture();
  await webhook(input.shop);
  const result = await reconcileProduct(input.shop, productId, {
    fetchProduct: async () => {
      throw Error("Must not fetch before publication");
    },
  });
  assert.equal(result.status, "waiting_for_snapshot");
  const row = await change(input.shop);
  assert.equal(row.dirty, true);
  assert.equal(row.appliedRevision, 0n);
  assert.equal(row.attempts, 0);
  assert.equal(row.leaseToken, null);
  assert.equal(row.waitingForSnapshot, true);
  assert.ok(row.nextAttemptAt > new Date(Date.now() + 45000));
  const queued = [];
  await scanDirtyChanges({ enqueue: async (shop) => queued.push(shop) });
  assert.ok(!queued.includes(input.shop));
});

test("staging counts only durable unique products and rejects partial or conflicting imports", async () => {
  const input = await fixture();
  const run = await startCatalogSnapshot({ ...input, expectedProducts: 1 });
  const args = { ...input, runId: run.id };
  await assert.rejects(sealCatalogSnapshot(args), /incomplete/);
  await assert.rejects(publishRaw(args), /not ready/);
  await stageSnapshotProducts({ ...args, products: [envelope()] });
  const retry = await stageSnapshotProducts({
    ...args,
    products: [envelope()],
  });
  assert.equal(retry.importedProducts, 1);
  await assert.rejects(
    stageSnapshotProducts({
      ...args,
      products: [envelope("Conflicting retry")],
    }),
    /different data/
  );
  await sealCatalogSnapshot(args);
  await assert.rejects(
    stageSnapshotProducts({ ...args, products: [envelope()] }),
    /closed/
  );
  assert.equal(await mirror(input.shop), null);
});

test("publication atomically activates reconciled staging and acknowledges waiting work despite Redis outage", async () => {
  const input = await fixture();
  await webhook(input.shop);
  await reconcileProduct(input.shop, productId);
  const args = await prepared(input);
  assert.equal(
    (
      await publishCatalogSnapshot(args, {
        wake: async () => {
          throw Error("Redis offline");
        },
      })
    ).status,
    "published"
  );
  assert.equal((await mirror(input.shop)).data.title, "Baseline");
  let row = await change(input.shop);
  assert.equal(row.revision, 1n);
  assert.equal(row.appliedRevision, 1n);
  assert.equal(row.dirty, false);
  assert.equal(row.waitingForSnapshot, false);
  assert.equal(row.nextAttemptAt, null);
  const jobs = [];
  await scanDirtyChanges({ enqueue: async (shop) => jobs.push(shop) });
  assert.ok(!jobs.includes(input.shop));
  await webhook(input.shop);
  assert.equal(
    (
      await reconcileProduct(input.shop, productId, {
        fetchProduct: async () => envelope("Authoritative"),
      })
    ).status,
    "reconciled"
  );
  assert.equal((await mirror(input.shop)).data.title, "Authoritative");
  row = await change(input.shop);
  assert.equal(row.appliedRevision, 2n);
  assert.equal(
    (await publishCatalogSnapshot(args, { wake: async () => {} })).status,
    "already_published"
  );
  assert.equal((await change(input.shop)).revision, 2n);
});

test("a worker fetching against an old snapshot cannot overwrite a newly published baseline", async () => {
  const input = await fixture();
  await publishCatalogSnapshot(await prepared(input, "Old"), {
    wake: async () => {},
  });
  const replacement = await startCatalogSnapshot({
    ...input,
    expectedProducts: 1,
  });
  const args = { ...input, runId: replacement.id };
  await webhook(input.shop);
  const result = await reconcileProduct(input.shop, productId, {
    fetchProduct: async () => {
      await stageSnapshotProducts({
        ...args,
        products: [envelope("Replacement")],
      });
      await sealCatalogSnapshot(args);
      await publishCatalogSnapshot(args, {
        wake: async () => {},
        fetchProduct: async () => envelope("Replacement"),
      });
      return envelope("Stale fetch");
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal((await mirror(input.shop)).data.title, "Replacement");
  assert.equal((await change(input.shop)).dirty, false);
});

test("changes already reconciled during import are refreshed in staging before publication", async () => {
  const input = await fixture();
  await publishCatalogSnapshot(await prepared(input, "Old"), {
    wake: async () => {},
  });
  const args = await prepared(input, "Earlier export state");
  await webhook(input.shop);
  assert.equal(
    (
      await reconcileProduct(input.shop, productId, {
        fetchProduct: async () => envelope("Newer Shopify"),
      })
    ).status,
    "reconciled"
  );
  assert.equal((await change(input.shop)).dirty, false);
  await publishCatalogSnapshot(args, {
    wake: async () => {},
    fetchProduct: async () => envelope("Newer Shopify"),
  });
  assert.equal((await change(input.shop)).dirty, false);
  assert.equal((await change(input.shop)).revision, 1n);
  assert.equal((await mirror(input.shop)).data.title, "Newer Shopify");
});

test("publication failures roll back mirror replacement, dirty revisions, and activation", async () => {
  const input = await fixture();
  const first = await prepared(input, "Current baseline");
  await publishCatalogSnapshot(first, { wake: async () => {} });
  const args = await prepared(input, "Must roll back");
  await webhook(input.shop);
  const original = prisma.$transaction.bind(prisma);
  prisma.$transaction = (fn, options) =>
    original(
      (tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "shop")
                return {
                  ...target.shop,
                  updateMany: async () => {
                    throw Error("Activation failed");
                  },
                };
              return target[key];
            },
          })
        ),
      options
    );
  try {
    await assert.rejects(publishCatalogSnapshot(args), /Activation failed/);
  } finally {
    prisma.$transaction = original;
  }
  assert.equal((await mirror(input.shop)).data.title, "Current baseline");
  assert.equal((await change(input.shop)).revision, 1n);
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: input.shop } }))
      .activeSnapshotId,
    first.runId
  );
});

test("active published snapshots survive retention; cancellation preserves the current baseline", async () => {
  const input = await fixture();
  const args = await prepared(input);
  await publishCatalogSnapshot(args, { wake: async () => {} });
  await prisma.snapshotRun.update({
    where: { id: args.runId },
    data: { completedAt: new Date(0) },
  });
  await runRetention();
  assert.ok(await prisma.snapshotRun.findUnique({ where: { id: args.runId } }));
  const pending = await startCatalogSnapshot({ ...input, expectedProducts: 1 });
  await cancelCatalogSnapshot({ ...input, runId: pending.id });
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: input.shop } }))
      .activeSnapshotId,
    args.runId
  );
  await assert.rejects(
    publishCatalogSnapshot({ ...input, runId: pending.id }),
    (error) => error.code === "SYNC_RUN_NOT_ACTIVE"
  );
});

test("old installations cannot stage or publish after the generation changes", async () => {
  const input = await fixture();
  const args = await prepared(input);
  await prisma.shop.update({
    where: { domain: input.shop },
    data: { generation: randomUUID() },
  });
  await assert.rejects(publishCatalogSnapshot(args), /Installation changed/);
  assert.equal(await mirror(input.shop), null);
});

test("an explicitly complete empty catalog can publish and remove old products", async () => {
  const input = await fixture();
  await publishCatalogSnapshot(await prepared(input), { wake: async () => {} });
  await publishCatalogSnapshot(await prepared(input, "", 0), {
    wake: async () => {},
  });
  assert.equal(await mirror(input.shop), null);
});
