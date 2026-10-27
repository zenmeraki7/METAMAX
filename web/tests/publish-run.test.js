import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const { startCatalogSnapshot, stageSnapshotProducts, sealCatalogSnapshot } =
  await import("../domains/snapshots/snapshots.service.js");
const { claimSnapshotLease } = await import("../domains/sync/sync.lease.js");
const { publishRun } = await import("../domains/sync/sync.repository.js");
const { applySnapshotChanges } = await import(
  "../domains/sync/sync.changes.js"
);
const { recordProductWebhook } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { reconcileProduct } = await import(
  "../domains/webhooks/webhooks.service.js"
);
const { readPublishedProduct } = await import(
  "../domains/products/products.service.js"
);
const { readActiveCatalogCounts, createSyncRouter } = await import(
  "../domains/sync/sync.routes.js"
);
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
async function webhook(shop) {
  const id = randomUUID();
  await recordProductWebhook({
    id,
    eventId: id,
    shop,
    productId,
    topic: "products/update",
    payloadHash: "d".repeat(64),
    triggeredAt: new Date(),
  });
}
async function fixture() {
  const shop = `test-${randomUUID()}.myshopify.com`;
  const merchant = await prisma.shop.create({ data: { domain: shop } });
  shops.push(shop);
  const run = await startCatalogSnapshot({
    shop,
    generation: merchant.generation,
    expectedProducts: 1,
  });
  const args = { shop, generation: merchant.generation, runId: run.id };
  await stageSnapshotProducts({ ...args, products: [envelope()] });
  await sealCatalogSnapshot(args);
  const { token } = await claimSnapshotLease(run);
  return { run, token };
}
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.$disconnect();
});

test("publication switches the pointer without copying catalog rows; subsequent reconciliation follows it", async () => {
  const { run, token } = await fixture();
  await prisma.productMirror.create({
    data: {
      shop: run.shop,
      productId,
      revision: 0n,
      data: { id: productId, title: "Legacy cache" },
    },
  });
  assert.deepEqual(await publishRun(run, token, 1n), {
    published: true,
    snapshotId: run.id,
  });
  assert.equal(
    (await readPublishedProduct(run.shop, productId)).data.title,
    "Baseline"
  );
  assert.equal(
    (
      await prisma.productMirror.findUnique({
        where: { shop_productId: { shop: run.shop, productId } },
      })
    ).data.title,
    "Legacy cache"
  );
  const counts = await readActiveCatalogCounts(run.shop);
  assert.equal(counts.snapshotId, run.id);
  assert.equal(counts.productCount, 1);
  assert.equal(counts.variantCount, 0);
  assert.equal(counts.syncStatus, "READY");
  assert.ok(counts.lastSyncedAt instanceof Date);
  await webhook(run.shop);
  assert.equal(
    (
      await reconcileProduct(run.shop, productId, {
        fetchProduct: async () => envelope("Live update"),
      })
    ).status,
    "reconciled"
  );
  assert.equal(
    (await readPublishedProduct(run.shop, productId)).data.title,
    "Live update"
  );
  assert.equal((await readPublishedProduct(run.shop, productId)).revision, 1n);
});

test("publication preserves bigint count precision and leaves a mismatched run owned and incomplete", async () => {
  const { run, token } = await fixture();
  await assert.rejects(
    publishRun(run, token, 9007199254740993n),
    (error) => error.code === "SYNC_PUBLICATION_FENCE_FAILED"
  );
  const stored = await prisma.snapshotRun.findUnique({ where: { id: run.id } });
  assert.equal(stored.status, "RECONCILING");
  assert.equal(stored.leaseToken, token);
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: run.shop } }))
      .activeSnapshotId,
    null
  );
});

test("publication rejects expired or replaced run ownership", async () => {
  const { run, token } = await fixture();
  await assert.rejects(
    publishRun(run, "wrong-token", 1),
    (error) => error.code === "SYNC_PUBLICATION_FENCE_FAILED"
  );
  await prisma.snapshotRun.update({
    where: { id: run.id },
    data: { leasedUntil: new Date(0) },
  });
  await assert.rejects(
    publishRun(run, token, 1),
    (error) => error.code === "SYNC_PUBLICATION_FENCE_FAILED"
  );
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: run.shop } }))
      .activeSnapshotId,
    null
  );
});

test("failed pointer activation rolls back run completion and global revision acknowledgment", async () => {
  const { run, token } = await fixture();
  await webhook(run.shop);
  await applySnapshotChanges(run, token, 25, {
    fetchProduct: async () => envelope(),
  });
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
                  updateMany: async () => ({ count: 0 }),
                };
              return target[key];
            },
          })
        ),
      options
    );
  try {
    await assert.rejects(
      publishRun(run, token, 1),
      (error) => error.code === "SYNC_PUBLICATION_CONFLICT"
    );
  } finally {
    prisma.$transaction = original;
  }
  const stored = await prisma.snapshotRun.findUnique({ where: { id: run.id } });
  assert.equal(stored.status, "RECONCILING");
  assert.equal(stored.leaseToken, token);
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop: run.shop, productId } },
  });
  assert.equal(change.dirty, true);
  assert.equal(change.appliedRevision, 0n);
});

test("publication validates identifiers, ownership, and nonnegative ingestion counters", async () => {
  const run = { id: "run", shop: "valid.myshopify.com" };
  for (const expected of [-1, -1n, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    await assert.rejects(publishRun(run, "token", expected), /expectedLines/);
  await assert.rejects(publishRun(run, "", 0), /token/);
  await assert.rejects(
    publishRun({ id: "run", shop: "Bad.myshopify.com" }, "token", 0),
    /canonical/
  );
});

test("status counts published JSON and derives the shop only from the authenticated session", async () => {
  const { run, token } = await fixture();
  await publishRun(run, token, 1);
  const app = express();
  app.use((req, res, next) => {
    if (req.headers["test-auth"])
      res.locals.shopify = { session: { shop: run.shop } };
    next();
  });
  app.use(createSyncRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${
      server.address().port
    }/status?shop=another.myshopify.com`;
    assert.equal(
      (await fetch(url, { headers: { "x-shopify-shop-domain": run.shop } }))
        .status,
      401
    );
    const result = await (
      await fetch(url, {
        headers: {
          "test-auth": "yes",
          "x-shopify-shop-domain": "another.myshopify.com",
        },
      })
    ).json();
    assert.equal(result.shop, run.shop);
    assert.equal(result.snapshotId, run.id);
    assert.equal(result.productCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
