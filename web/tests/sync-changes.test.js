import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const {
  startCatalogSnapshot,
  stageSnapshotProducts,
  sealCatalogSnapshot,
  publishCatalogSnapshot,
} = await import("../domains/snapshots/snapshots.service.js");
const { applySnapshotChanges } = await import(
  "../domains/sync/sync.changes.js"
);
const { claimSnapshotLease, renewSnapshotLease } = await import(
  "../domains/sync/sync.lease.js"
);
const { reconcileAndPublishSnapshot } = await import(
  "../domains/sync/sync.coordinator.js"
);
const { writeProductSnapshot } = await import(
  "../domains/products/products.service.js"
);
const { recordProductWebhook } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const shops = [];
const productId = "gid://shopify/Product/123";
const envelope = (title = "Authoritative") => ({
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
    payloadHash: "f".repeat(64),
    triggeredAt: new Date(),
  });
}
async function fixture({ dirty = true, sealed = true } = {}) {
  const shop = `test-${randomUUID()}.myshopify.com`;
  const merchant = await prisma.shop.create({ data: { domain: shop } });
  shops.push(shop);
  const args = { shop, generation: merchant.generation };
  const run = await startCatalogSnapshot({ ...args, expectedProducts: 1 });
  args.runId = run.id;
  await stageSnapshotProducts({ ...args, products: [envelope("Initial")] });
  if (dirty) await webhook(shop);
  if (sealed) await sealCatalogSnapshot(args);
  return { args, run: { id: run.id, ...args } };
}
const staged = (run) =>
  prisma.snapshotProduct.findUnique({
    where: { runId_productId: { runId: run.id, productId } },
  });
const change = (run) =>
  prisma.snapshotChange.findUnique({
    where: { runId_productId: { runId: run.id, productId } },
  });
const isLost = (error) =>
  error.code === "SYNC_LEASE_LOST" ||
  error.code === "SYNC_PUBLICATION_FENCE_FAILED";
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.$disconnect();
});

test("ownership is required before any Shopify read, including an empty batch", async () => {
  const { run } = await fixture({ dirty: false });
  const { token } = await claimSnapshotLease(run);
  let fetched = 0;
  const options = {
    fetchProduct: async () => {
      fetched++;
      return envelope();
    },
  };
  await assert.rejects(
    applySnapshotChanges(run, "wrong-token", 25, options),
    isLost
  );
  assert.deepEqual(await applySnapshotChanges(run, token, 25, options), {
    fetched: 0,
    applied: 0,
    superseded: 0,
  });
  assert.equal(fetched, 0);
  await prisma.snapshotRun.update({
    where: { id: run.id },
    data: { leasedUntil: new Date(0) },
  });
  await assert.rejects(applySnapshotChanges(run, token, 25, options), isLost);
});

test("lease claims cannot enter reconciliation before durable ingestion is sealed", async () => {
  const { run } = await fixture({ sealed: false });
  await assert.rejects(
    claimSnapshotLease(run),
    (error) => error.code === "SYNC_LEASE_UNAVAILABLE"
  );
  await sealCatalogSnapshot({
    shop: run.shop,
    generation: run.generation,
    runId: run.id,
  });
  assert.ok((await claimSnapshotLease(run)).token);
});

test("renewal uses a monotonic expiration and does not shorten a longer coordinator lease", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  const [longer] = await prisma.$queryRaw`UPDATE "SnapshotRun"
    SET "leasedUntil"=clock_timestamp()+interval '10 minutes' WHERE "id"=${run.id}
    RETURNING "leasedUntil"`;
  assert.ok(
    (await renewSnapshotLease(run, token)).leasedUntil.getTime() >=
      longer.leasedUntil.getTime()
  );
});

test("heartbeat renews while a paginated fetch is in flight", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  const result = await applySnapshotChanges(run, token, 25, {
    heartbeatMs: 10,
    fetchProduct: async (_shop, _id, context) => {
      assert.equal(context.generation, run.generation);
      assert.equal(context.signal.aborted, false);
      await prisma.snapshotRun.update({
        where: { id: run.id },
        data: { leasedUntil: new Date(Date.now() + 5000) },
      });
      const deadline = Date.now() + 5000;
      let renewed = false;
      while (Date.now() < deadline) {
        const lease = await prisma.snapshotRun.findUnique({
          where: { id: run.id },
        });
        if (lease.leasedUntil.getTime() > Date.now() + 60000) {
          renewed = true;
          break;
        }
        await delay(20);
      }
      assert.equal(renewed, true);
      return envelope();
    },
  });
  assert.deepEqual(result, { fetched: 1, applied: 1, superseded: 0 });
});

test("heartbeat loss aborts a cancellable fetch and leaves its staged revision dirty", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  await assert.rejects(
    applySnapshotChanges(run, token, 25, {
      heartbeatMs: 10,
      fetchProduct: async (_shop, _id, { signal }) => {
        await prisma.snapshotRun.update({
          where: { id: run.id },
          data: { leasedUntil: new Date(0) },
        });
        await delay(5000, undefined, { signal });
        throw Error("Heartbeat did not abort the fetch");
      },
    }),
    isLost
  );
  assert.equal((await change(run)).dirty, true);
  assert.equal((await staged(run)).data.title, "Initial");
});

test("a replaced token prevents staging even when a fetch ignores cancellation", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  let replacement;
  await assert.rejects(
    applySnapshotChanges(run, token, 25, {
      fetchProduct: async () => {
        await prisma.snapshotRun.update({
          where: { id: run.id },
          data: { leasedUntil: new Date(0) },
        });
        replacement = await claimSnapshotLease(run);
        return envelope("Stale owner");
      },
    }),
    isLost
  );
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: run.id } })).leaseToken,
    replacement.token
  );
  assert.equal((await staged(run)).data.title, "Initial");
  assert.equal(
    (
      await applySnapshotChanges(run, replacement.token, 25, {
        fetchProduct: async () => envelope("New owner"),
      })
    ).applied,
    1
  );
});

test("a webhook supersedes the fetched revision without changing staged data", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  const result = await applySnapshotChanges(run, token, 25, {
    fetchProduct: async () => {
      await webhook(run.shop);
      return envelope("Stale version");
    },
  });
  assert.deepEqual(result, { fetched: 1, applied: 0, superseded: 1 });
  assert.equal((await staged(run)).data.title, "Initial");
  assert.equal((await change(run)).revision, 2n);
  assert.equal((await change(run)).appliedRevision, 0n);
  assert.equal(
    (
      await applySnapshotChanges(run, token, 25, {
        fetchProduct: async () => envelope("Revision 2"),
      })
    ).applied,
    1
  );
  assert.equal((await change(run)).appliedRevision, 2n);
});

test("staging failure rolls back product replacement together with acknowledgment", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  let writes = 0;
  await assert.rejects(
    applySnapshotChanges(run, token, 25, {
      fetchProduct: async () => envelope(),
      writeProduct: async (...args) => {
        writes++;
        await writeProductSnapshot(...args);
        throw Error("Staged write failed");
      },
    }),
    /Staged write failed/
  );
  assert.equal(writes, 1);
  assert.equal((await change(run)).appliedRevision, 0n);
  assert.equal((await change(run)).dirty, true);
  assert.equal((await staged(run)).data.title, "Initial");
});

test("selected transaction conflicts retry the commit without repeating Shopify reads", async () => {
  const { run } = await fixture();
  const { token } = await claimSnapshotLease(run);
  let fetched = 0,
    writes = 0;
  const result = await applySnapshotChanges(run, token, 25, {
    fetchProduct: async () => {
      fetched++;
      return envelope();
    },
    writeProduct: async (...args) => {
      await writeProductSnapshot(...args);
      if (++writes === 1)
        throw Object.assign(Error("Conflict"), { code: "P2034" });
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(fetched, 1);
  assert.equal(writes, 2);
});

test("publication requires a current lease and rechecks dirty changes after an empty batch", async () => {
  const { run, args } = await fixture({ dirty: false });
  await assert.rejects(publishCatalogSnapshot(args), /token/);
  const { token } = await claimSnapshotLease(run);
  assert.equal((await applySnapshotChanges(run, token)).fetched, 0);
  await webhook(run.shop);
  await assert.rejects(
    publishCatalogSnapshot({ ...args, leaseToken: token }),
    (error) => error.code === "SNAPSHOT_CHANGES_PENDING"
  );
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: run.shop } }))
      .activeSnapshotId,
    null
  );
  await applySnapshotChanges(run, token, 25, {
    fetchProduct: async () => envelope(),
  });
  assert.equal(
    (
      await publishCatalogSnapshot(
        { ...args, leaseToken: token },
        { wake: async () => {} }
      )
    ).status,
    "published"
  );
});

test("deletions can reduce staged count after sealing without invalidating the ingestion manifest", async () => {
  const { run, args } = await fixture();
  await reconcileAndPublishSnapshot(args, {
    fetchProduct: async () => null,
    wake: async () => {},
  });
  assert.equal(await staged(run), null);
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: run.id } }))
      .importedProducts,
    1
  );
  assert.equal(
    (
      await prisma.catalogChange.findUnique({
        where: { shop_productId: { shop: run.shop, productId } },
      })
    ).dirty,
    false
  );
});

test("bounded coordinator releases its lease and can resume a fully staged batch", async () => {
  const { run, args } = await fixture();
  await assert.rejects(
    reconcileAndPublishSnapshot(args, {
      maxBatches: 1,
      fetchProduct: async () => envelope(),
    }),
    (error) => error.code === "SNAPSHOT_BATCH_LIMIT"
  );
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: run.id } })).leaseToken,
    null
  );
  assert.equal(
    (
      await reconcileAndPublishSnapshot(args, {
        fetchProduct: async () => {
          throw Error("No refetch needed");
        },
        wake: async () => {},
      })
    ).status,
    "published"
  );
});

test("batch validation rejects noncanonical identities, missing ownership, and invalid limits", async () => {
  await assert.rejects(
    applySnapshotChanges({ id: "run", shop: "Bad.myshopify.com" }, "token"),
    /canonical/
  );
  await assert.rejects(
    applySnapshotChanges({ id: "run", shop: "valid.myshopify.com" }, ""),
    /token/
  );
  for (const limit of [0, 101, 1.5])
    await assert.rejects(
      applySnapshotChanges(
        { id: "run", shop: "valid.myshopify.com" },
        "token",
        limit
      ),
      /limit/
    );
});
