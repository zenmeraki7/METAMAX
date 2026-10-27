import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import express from "express";
import { itemId, observation } from "./fixtures/inventory.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const { recordInventoryWebhook } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { reconcileInventoryItem } = await import(
  "../domains/inventory/inventory.reconcile.js"
);
const { createInventoryWebhookRouter } = await import(
  "../domains/inventory/inventory.routes.js"
);
const { scanDirtyInventoryChanges, createDirtyScanner } = await import(
  "../workers/reconcile.scanner.js"
);
const { inventoryQueue, enqueueInventoryChange } = await import(
  "../queues/inventory.queue.js"
);
const { reconcileQueue } = await import("../queues/reconcile.queue.js");
const { createInventoryWorker } = await import(
  "../workers/inventory.worker.js"
);
const { startCatalogSnapshot, sealCatalogSnapshot, cancelCatalogSnapshot } =
  await import("../domains/snapshots/snapshots.service.js");
const { stageSnapshotInventoryItem, sealSnapshotInventory } = await import(
  "../domains/inventory/inventory.contract.js"
);
const { applySnapshotInventoryChanges } = await import(
  "../domains/sync/sync.changes.js"
);
const { claimSnapshotLease } = await import("../domains/sync/sync.lease.js");
const { publishRun } = await import("../domains/sync/sync.repository.js");
const { processLifecycle, registerShop, shopHash } = await import(
  "../domains/lifecycle/lifecycle.repository.js"
);
const { runRetention } = await import("../workers/retention.js");
const { createRecoveryRouter } = await import(
  "../domains/recovery/recovery.routes.js"
);
const shops = [];
const markers = [];
const key = (shop) => ({
  shop_inventoryItemId: { shop, inventoryItemId: itemId },
});
const change = (shop) =>
  prisma.inventoryChange.findUnique({ where: key(shop) });
function event(shop, id = randomUUID()) {
  return {
    shop,
    id,
    inventoryItemId: itemId,
    topic: "inventory_levels/update",
    eventId: id,
    payloadHash: "e".repeat(64),
    triggeredAt: new Date("2026-10-25T00:00:00Z"),
  };
}
async function fixture(active = true) {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const merchant = await prisma.shop.create({ data: { domain: shop } });
  let snapshot;
  if (active) {
    snapshot = await prisma.snapshotRun.create({
      data: {
        shop,
        generation: merchant.generation,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await prisma.shop.update({
      where: { domain: shop },
      data: { activeSnapshotId: snapshot.id },
    });
  }
  return { shop, generation: merchant.generation, snapshotId: snapshot?.id };
}
async function baseline(f) {
  const run = await startCatalogSnapshot({ ...f, expectedProducts: 0 });
  const args = { shop: f.shop, generation: f.generation, runId: run.id };
  await stageSnapshotInventoryItem({
    ...args,
    inventoryItemId: itemId,
    current: observation(),
  });
  await sealSnapshotInventory({
    ...args,
    expectedRecords: {
      inventory_items: 1,
      inventory_locations: 1,
      inventory_levels: 1,
      inventory_quantities: 8,
    },
  });
  await sealCatalogSnapshot(args);
  return { run, args, ...(await claimSnapshotLease(run)) };
}
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.installationState.deleteMany({
    where: { shopHash: { in: markers } },
  });
  await prisma.lifecycleReceipt.deleteMany({
    where: { shopHash: { in: markers } },
  });
  await reconcileQueue.close();
  await inventoryQueue.close();
  await prisma.$disconnect();
});

test("inventory receipts work before product ingestion, deduplicate concurrently, and capture staged revisions", async () => {
  const f = await fixture(false);
  const run = await startCatalogSnapshot({ ...f, expectedProducts: 0 });
  const input = event(f.shop);
  const results = await Promise.all([
    recordInventoryWebhook(input),
    recordInventoryWebhook(input),
    recordInventoryWebhook(input),
  ]);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal((await change(f.shop)).revision, 1n);
  assert.equal(
    await prisma.catalogChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal(await prisma.variant.count({ where: { shop: f.shop } }), 0);
  assert.equal(
    (
      await prisma.snapshotInventoryChange.findUnique({
        where: {
          runId_inventoryItemId: { runId: run.id, inventoryItemId: itemId },
        },
      })
    ).revision,
    1n
  );
  await assert.rejects(
    recordInventoryWebhook({ ...input, payloadHash: "f".repeat(64) }),
    { statusCode: 409 }
  );
  assert.equal((await change(f.shop)).revision, 1n);
  assert.equal(
    (
      await reconcileInventoryItem(f.shop, itemId, {
        fetchInventory() {
          throw Error("No snapshot, no read");
        },
      })
    ).status,
    "waiting_for_snapshot"
  );
  assert.equal((await change(f.shop)).attempts, 0);
});

test("inventory raw webhook intake validates HMAC and identities, then acknowledges a Redis outage after commit", async () => {
  const f = await fixture();
  const secret = "inventory-test-secret";
  process.env.SHOPIFY_API_SECRET = secret;
  const app = express();
  app.use(
    "/inventory",
    createInventoryWebhookRouter({
      enqueue: async () => {
        throw Error("Redis offline");
      },
    })
  );
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const send = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/inventory`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": createHmac("sha256", secret)
          .update(body)
          .digest("base64"),
        "x-shopify-shop-domain": f.shop,
        "x-shopify-topic": "inventory_levels/update",
        "x-shopify-webhook-id": randomUUID(),
        "x-shopify-event-id": randomUUID(),
        "x-shopify-triggered-at": new Date().toISOString(),
        ...headers,
      },
    });
  try {
    const raw =
      '{"inventory_item_id":900719925474099312345,"location_id":456,"available":2}';
    assert.equal(
      (await send(raw, { "x-shopify-hmac-sha256": "bad" })).status,
      401
    );
    assert.equal((await send('{"inventory_item_id":123}')).status, 400);
    assert.equal((await send(raw, { "x-shopify-event-id": "" })).status, 400);
    assert.equal(
      await prisma.webhookEvent.count({ where: { shop: f.shop } }),
      0
    );
    assert.equal((await send(raw)).status, 200);
    const row = await prisma.inventoryChange.findFirst({
      where: { shop: f.shop },
    });
    assert.equal(
      row.inventoryItemId,
      "gid://shopify/InventoryItem/900719925474099312345"
    );
    assert.equal(row.dirty, true);
    assert.equal(
      await prisma.catalogChange.count({ where: { shop: f.shop } }),
      0
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("inventory worker claims once, writes atomically, and skips clean duplicate jobs", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const ready = new Promise((r) => {
    started = r;
  });
  const first = reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async (_s, _id, context) => {
      assert.equal(context.generation, f.generation);
      started();
      await gate;
      return observation();
    },
  });
  try {
    await ready;
    assert.equal(
      (
        await reconcileInventoryItem(f.shop, itemId, {
          fetchInventory() {
            throw Error("duplicate read");
          },
        })
      ).status,
      "skipped"
    );
  } finally {
    release();
  }
  assert.equal((await first).status, "reconciled");
  assert.equal((await change(f.shop)).appliedRevision, 1n);
  assert.equal(
    await prisma.inventoryQuantity.count({ where: { shop: f.shop } }),
    8
  );
  assert.equal((await reconcileInventoryItem(f.shop, itemId)).reason, "clean");
  await recordInventoryWebhook(event(f.shop));
  assert.equal(
    (
      await reconcileInventoryItem(f.shop, itemId, {
        fetchInventory: async () => null,
      })
    ).status,
    "reconciled"
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
});

test("new inventory revisions fence stale success and reset the retry budget without clearing an owned lease", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const result = await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => {
      const before = await change(f.shop);
      await recordInventoryWebhook(event(f.shop));
      const after = await change(f.shop);
      assert.equal(after.leaseToken, before.leaseToken);
      assert.equal(after.attempts, 0);
      return observation();
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal((await change(f.shop)).revision, 2n);
  assert.equal((await change(f.shop)).dirty, true);
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
});

test("a reclaimed inventory lease fences the earlier worker", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const result = await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => {
      await prisma.inventoryChange.update({
        where: key(f.shop),
        data: { leasedUntil: new Date(0) },
      });
      const fresh = observation();
      fresh.item.sku = "New owner";
      assert.equal(
        (
          await reconcileInventoryItem(f.shop, itemId, {
            fetchInventory: async () => fresh,
          })
        ).status,
        "reconciled"
      );
      return observation();
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal(
    (await prisma.inventoryItem.findFirst({ where: { shop: f.shop } })).sku,
    "New owner"
  );
});

test("snapshot publication during an inventory fetch rejects the old read and leaves a fresh read due", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const result = await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => {
      const replacement = await prisma.snapshotRun.create({
        data: {
          shop: f.shop,
          generation: f.generation,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      await prisma.shop.update({
        where: { domain: f.shop },
        data: { activeSnapshotId: replacement.id },
      });
      return observation();
    },
  });
  assert.equal(result.status, "snapshot_changed");
  const row = await change(f.shop);
  assert.equal(row.dirty, true);
  assert.equal(row.attempts, 0);
  assert.equal(row.leaseToken, null);
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
});

test("inventory rollback retains dirty work; bounded failures enter dead letter; new revision resets it", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  await assert.rejects(
    reconcileInventoryItem(f.shop, itemId, {
      fetchInventory: async () => observation(),
      writeInventory: async (tx) => {
        await tx.inventoryItem.create({
          data: {
            shop: f.shop,
            snapshotId: f.snapshotId,
            id: itemId,
            sku: "rollback",
            tracked: true,
            requiresShipping: true,
            sourceUpdatedAt: new Date(),
          },
        });
        throw Error("inventory write failed");
      },
    }),
    /inventory write failed/
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await change(f.shop)).appliedRevision, 0n);
  assert.equal((await change(f.shop)).attempts, 1);
  await prisma.inventoryChange.update({
    where: key(f.shop),
    data: { attempts: 7, nextAttemptAt: new Date(0) },
  });
  await assert.rejects(
    reconcileInventoryItem(f.shop, itemId, {
      fetchInventory: async () => {
        throw Error("upstream unavailable");
      },
    }),
    /upstream unavailable/
  );
  assert.ok((await change(f.shop)).deadLetterAt);
  const signals = [];
  await scanDirtyInventoryChanges({
    enqueue: async (shop) => signals.push(shop),
  });
  assert.ok(!signals.includes(f.shop));
  await recordInventoryWebhook(event(f.shop));
  assert.equal((await change(f.shop)).attempts, 0);
  assert.equal((await change(f.shop)).deadLetterAt, null);
});

test("an older inventory failure cannot consume the newer revision's retry budget", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const result = await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => {
      await recordInventoryWebhook(event(f.shop));
      throw Error("old revision failure");
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal((await change(f.shop)).attempts, 0);
  assert.equal((await change(f.shop)).lastError, null);
});

test("inventory publication requires a complete baseline and drains its dedicated staging ledger", async () => {
  const f = await fixture(false);
  await recordInventoryWebhook(event(f.shop));
  const run = await startCatalogSnapshot({ ...f, expectedProducts: 0 });
  const args = { shop: f.shop, generation: f.generation, runId: run.id };
  await assert.rejects(sealCatalogSnapshot(args), {
    code: "SNAPSHOT_DATASET_INCOMPLETE",
  });
  await stageSnapshotInventoryItem({
    ...args,
    inventoryItemId: itemId,
    current: observation(),
  });
  await assert.rejects(
    sealSnapshotInventory({
      ...args,
      expectedRecords: {
        inventory_items: 2,
        inventory_locations: 1,
        inventory_levels: 1,
        inventory_quantities: 8,
      },
    }),
    { code: "INCOMPLETE_INVENTORY_INGESTION" }
  );
  await sealSnapshotInventory({
    ...args,
    expectedRecords: {
      inventory_items: 1,
      inventory_locations: 1,
      inventory_levels: 1,
      inventory_quantities: 8,
    },
  });
  await sealCatalogSnapshot(args);
  const { token } = await claimSnapshotLease(run);
  await assert.rejects(publishRun(run, token, 0), {
    code: "SNAPSHOT_CHANGES_PENDING",
  });
  const fresh = observation();
  fresh.levels[0].quantities[0].quantity = 42;
  assert.equal(
    (
      await applySnapshotInventoryChanges(run, token, 25, {
        fetchInventory: async () => fresh,
      })
    ).applied,
    1
  );
  assert.equal((await publishRun(run, token, 0)).published, true);
  assert.equal((await change(f.shop)).dirty, false);
  assert.equal(
    (
      await prisma.inventoryQuantity.findFirst({
        where: { shop: f.shop, snapshotId: run.id, name: "available" },
      })
    ).quantity,
    42
  );
});

test("a webhook during staged inventory fetch supersedes the old staged revision", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const { run, token } = await baseline(f);
  const result = await applySnapshotInventoryChanges(run, token, 25, {
    fetchInventory: async () => {
      await recordInventoryWebhook(event(f.shop));
      return observation(0);
    },
  });
  assert.equal(result.superseded, 1);
  assert.equal(
    await prisma.inventoryLevel.count({
      where: { shop: f.shop, snapshotId: run.id },
    }),
    1
  );
  await assert.rejects(publishRun(run, token, 0), {
    code: "SNAPSHOT_CHANGES_PENDING",
  });
});

test("scanner and dedicated BullMQ worker recover an inventory commit that never enqueued", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const first = await enqueueInventoryChange(f.shop, itemId, 1n);
  const duplicate = await enqueueInventoryChange(f.shop, itemId, "1");
  assert.equal(first.id, duplicate.id);
  await first.remove();
  const worker = createInventoryWorker({
    fetchInventory: async () => observation(),
  });
  try {
    await worker.waitUntilReady();
    const scan = createDirtyScanner({
      resource: "inventory",
      db: {
        inventoryChange: {
          groupBy: (args) =>
            prisma.inventoryChange.groupBy({
              ...args,
              where: {
                ...args.where,
                AND: [...args.where.AND, { shop: f.shop }],
              },
            }),
          findMany: (args) => prisma.inventoryChange.findMany(args),
        },
      },
    });
    await scan();
    const deadline = Date.now() + 15000;
    while ((await change(f.shop)).dirty && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal((await change(f.shop)).dirty, false);
    assert.equal(
      await prisma.inventoryItem.count({ where: { shop: f.shop } }),
      1
    );
  } finally {
    await worker.close();
  }
});

test("inventory retention preserves pending recovery and uninstall removes ledgers and fences in-flight reads", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  const old = new Date(Date.now() - 60 * 86400000);
  await prisma.webhookEvent.updateMany({
    where: { shop: f.shop },
    data: { createdAt: old },
  });
  const obsolete = await prisma.snapshotRun.create({
    data: {
      shop: f.shop,
      generation: f.generation,
      status: "COMPLETED",
      completedAt: old,
    },
  });
  await runRetention();
  assert.equal(await prisma.webhookEvent.count({ where: { shop: f.shop } }), 1);
  assert.ok(
    await prisma.snapshotRun.findUnique({ where: { id: obsolete.id } })
  );
  await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => observation(),
  });
  await runRetention();
  assert.equal(await prisma.webhookEvent.count({ where: { shop: f.shop } }), 0);
  assert.equal(
    await prisma.snapshotRun.findUnique({ where: { id: obsolete.id } }),
    null
  );
  await recordInventoryWebhook(event(f.shop));
  const result = await reconcileInventoryItem(f.shop, itemId, {
    fetchInventory: async () => {
      markers.push(shopHash(f.shop));
      await processLifecycle({
        id: randomUUID(),
        shop: f.shop,
        topic: "app/uninstalled",
        payloadHash: "f".repeat(64),
        triggeredAt: new Date(Date.now() + 10),
      });
      return observation();
    },
  });
  assert.equal(result.status, "superseded");
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await recordInventoryWebhook(event(f.shop))).ignored, true);
});

test("inventory manual retry is tenant-scoped, revision-checked, and durable before queueing", async () => {
  const f = await fixture();
  await recordInventoryWebhook(event(f.shop));
  await prisma.inventoryChange.update({
    where: key(f.shop),
    data: { deadLetterAt: new Date(), attempts: 8 },
  });
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.shopify = { session: { shop: f.shop } };
    next();
  });
  app.use(
    createRecoveryRouter({
      resource: "inventory",
      enqueue: async () => {
        throw Error("Redis down");
      },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(
      (
        await (
          await fetch(`${url}/dead-letters?shop=other.myshopify.com`)
        ).json()
      ).changes[0].inventoryItemId,
      itemId
    );
    const retry = (revision) =>
      fetch(`${url}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inventoryItemId: itemId, revision }),
      });
    assert.equal((await retry("2")).status, 409);
    assert.equal((await retry("1")).status, 202);
    assert.equal((await retry("1")).status, 409);
    assert.equal((await change(f.shop)).attempts, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
