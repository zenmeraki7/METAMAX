import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const { reconcileProduct } = await import(
  "../domains/webhooks/webhooks.service.js"
);
const { recordProductWebhook, completeProductReconciliation } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { scanDirtyChanges } = await import("../workers/reconcile.scanner.js");
const { reconcileQueue } = await import("../queues/reconcile.queue.js");

const shop = `test-${randomUUID()}.myshopify.com`;
let generation,
  sequence = 10000;
const where = (productId) => ({ shop_productId: { shop, productId } });
const read = (id) => prisma.catalogChange.findUnique({ where: where(id) });
async function webhook(productId) {
  const id = randomUUID();
  return recordProductWebhook({
    id,
    eventId: id,
    shop,
    productId,
    topic: "products/update",
    payloadHash: "d".repeat(64),
    triggeredAt: new Date(),
  });
}
async function fresh() {
  const id = `gid://shopify/Product/${sequence++}`;
  await webhook(id);
  return id;
}
before(async () => {
  generation = (
    await prisma.shop.create({
      data: { domain: shop },
    })
  ).generation;
  const snapshot = await prisma.snapshotRun.create({
    data: {
      shop,
      generation,
      status: "COMPLETED",
      expectedProducts: 0,
      importedProducts: 0,
      completedAt: new Date(),
    },
  });
  await prisma.shop.update({
    where: { domain: shop },
    data: { activeSnapshotId: snapshot.id },
  });
});
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: shop } });
  await reconcileQueue.close();
  await prisma.$disconnect();
});

test("concurrent signals share one Neon claim and clean jobs avoid Shopify reads", async () => {
  const id = await fresh();
  let unblock,
    announce,
    calls = 0;
  const started = new Promise((resolve) => {
    announce = resolve;
  });
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const first = reconcileProduct(shop, id, {
    fetchProduct: async () => {
      calls++;
      announce();
      await gate;
      return { id, title: "Claim owner", variants: [] };
    },
  });
  try {
    await started;
    const competing = await reconcileProduct(shop, id, {
      fetchProduct: async () => {
        calls++;
      },
    });
    assert.equal(competing.status, "skipped");
    const scheduled = [];
    await scanDirtyChanges({
      enqueue: async (domain, product) => scheduled.push([domain, product]),
    });
    assert.ok(
      !scheduled.some(([domain, product]) => domain === shop && product === id)
    );
    // Unclaimed callers cannot bypass a worker's token.
    assert.equal(
      await completeProductReconciliation({
        shop,
        productId: id,
        observedRevision: 1n,
        generation,
        product: null,
      }),
      false
    );
  } finally {
    unblock();
  }
  assert.equal((await first).status, "reconciled");
  assert.equal((await reconcileProduct(shop, id)).reason, "clean");
  assert.equal(calls, 1);
  assert.equal((await read(id)).leaseToken, null);
});

test("reclaimed expired lease fences an old worker even on the same revision", async () => {
  const id = await fresh();
  const result = await reconcileProduct(shop, id, {
    fetchProduct: async () => {
      await prisma.catalogChange.update({
        where: where(id),
        data: { leasedUntil: new Date(0) },
      });
      const scheduled = [];
      await scanDirtyChanges({
        enqueue: async (_domain, product) => scheduled.push(product),
      });
      assert.ok(scheduled.includes(id));
      assert.equal(
        (
          await reconcileProduct(shop, id, {
            fetchProduct: async () => ({ id, title: "New lease", variants: [] }),
          })
        ).status,
        "reconciled"
      );
      return { id, title: "Expired worker", variants: [] };
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal(
    (await prisma.productMirror.findUnique({ where: where(id) })).data.title,
    "New lease"
  );
});

test("lease expiry alone does not reject the unchanged owner at commit", async () => {
  const id = await fresh();
  assert.equal(
    (
      await reconcileProduct(shop, id, {
        fetchProduct: async () => {
          await prisma.catalogChange.update({
            where: where(id),
            data: { leasedUntil: new Date(0) },
          });
          return { id, variants: [] };
        },
      })
    ).status,
    "reconciled"
  );
});

test("a superseded failure leaves the newer revision due with no attempts", async () => {
  const id = await fresh();
  const result = await reconcileProduct(shop, id, {
    fetchProduct: async () => {
      await webhook(id);
      throw Error("Old revision failure");
    },
  });
  assert.equal(result.status, "superseded");
  const row = await read(id);
  assert.equal(row.revision, 2n);
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, null);
  assert.equal(row.leaseToken, null);
  assert.ok(row.nextAttemptAt <= new Date());
});

test("a reclaimed lease's retry state survives an earlier owner's failure", async () => {
  const id = await fresh();
  const result = await reconcileProduct(shop, id, {
    fetchProduct: async () => {
      await prisma.catalogChange.update({
        where: where(id),
        data: { leasedUntil: new Date(0) },
      });
      await assert.rejects(
        reconcileProduct(shop, id, {
          fetchProduct: async () => {
            throw Error("Current owner failure");
          },
        }),
        /Current owner failure/
      );
      throw Error("Earlier owner failure");
    },
  });
  assert.equal(result.status, "superseded");
  const row = await read(id);
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "Current owner failure");
  assert.equal(row.leaseToken, null);
});

test("mirror rollback retains dirty revision and records a bounded jittered retry", async () => {
  const id = await fresh();
  const before = Date.now();
  await assert.rejects(
    reconcileProduct(shop, id, {
      fetchProduct: async () => ({ id }),
      writeReconciledProduct: async (tx) => {
        await tx.productMirror.create({
          data: { shop, productId: id, revision: 1n, data: { id } },
        });
        throw Error("Mirror transaction failed");
      },
    }),
    /Mirror transaction failed/
  );
  const row = await read(id);
  assert.equal(row.dirty, true);
  assert.equal(row.appliedRevision, 0n);
  assert.equal(row.attempts, 1);
  assert.equal(row.leaseToken, null);
  assert.ok(row.nextAttemptAt.getTime() >= before + 4000);
  assert.ok(row.nextAttemptAt.getTime() <= Date.now() + 6000);
  assert.equal(
    await prisma.productMirror.count({ where: { shop, productId: id } }),
    0
  );
});

test("retry persistence failure reports both errors and leaves an expiring recovery lease", async () => {
  const id = await fresh();
  const original = prisma.catalogChange.updateMany;
  prisma.catalogChange.updateMany = async () => {
    throw Error("Retry database unavailable");
  };
  try {
    await assert.rejects(
      reconcileProduct(shop, id, {
        fetchProduct: async () => {
          throw Error("Shopify unavailable");
        },
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0].message === "Shopify unavailable" &&
        error.errors[1].message === "Retry database unavailable"
    );
  } finally {
    prisma.catalogChange.updateMany = original;
  }
  const row = await read(id);
  assert.ok(row.leaseToken);
  assert.ok(row.leasedUntil > new Date());
  assert.equal(row.attempts, 0);
  await prisma.catalogChange.update({
    where: where(id),
    data: { leasedUntil: new Date(0) },
  });
  assert.equal(
    (await reconcileProduct(shop, id, { fetchProduct: async () => null }))
      .status,
    "reconciled"
  );
});

test("retryable commit conflicts roll back and retry under the same claim", async () => {
  const id = await fresh();
  let writes = 0;
  const result = await reconcileProduct(shop, id, {
    fetchProduct: async () => ({ id }),
    writeReconciledProduct: async () => {
      if (++writes === 1)
        throw Object.assign(Error("Write conflict"), { code: "P2034" });
    },
  });
  assert.equal(result.status, "reconciled");
  assert.equal(writes, 2);
  assert.equal((await read(id)).attempts, 0);
});

test("installation changes fence a claimed worker and preserve replacement data", async () => {
  const id = await fresh();
  const result = await reconcileProduct(shop, id, {
    fetchProduct: async () => {
      await prisma.shop.update({
        where: { domain: shop },
        data: { generation: randomUUID() },
      });
      return { id };
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal((await read(id)).appliedRevision, 0n);
  assert.equal((await read(id)).leaseToken, null);
});

test("noncanonical identifiers fail before any claim or upstream request", async () => {
  await assert.rejects(
    reconcileProduct("Bad.myshopify.com", "gid://shopify/Product/1"),
    /canonical/
  );
  await assert.rejects(
    reconcileProduct(shop, "gid://shopify/Product/01"),
    /product GID/
  );
});
