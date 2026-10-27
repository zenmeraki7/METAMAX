import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client.js";
import {
  registerShop,
  shopHash,
  processLifecycle,
} from "../domains/lifecycle/lifecycle.repository.js";
import {
  consumeInitialSyncRequest,
  scanInitialSyncRequests,
} from "../domains/sync/initial-sync.consumer.js";
import { reserveCatalogSync } from "../domains/sync/sync.request.js";
import { processInventoryRepairStep } from "../domains/repair/inventory-repair.service.js";
import { processRepairStep } from "../domains/repair/repair.service.js";
import { reconcileInventoryItem } from "../domains/inventory/inventory.reconcile.js";
import { observation } from "./fixtures/inventory.js";

if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const shops = [];
const itemId = (n = 1) => `gid://shopify/InventoryItem/${n}`;
async function fixture({ registered = false, published = false } = {}) {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  if (registered || published) await registerShop(shop);
  else {
    const merchant = await prisma.shop.create({
      data: { domain: shop, installationVerified: true },
    });
    await prisma.installationState.create({
      data: {
        shopHash: shopHash(shop),
        status: "ACTIVE",
        generation: merchant.generation,
      },
    });
    await prisma.catalogSyncState.create({
      data: { shop, generation: merchant.generation },
    });
    await prisma.initialSyncRequest.create({
      data: { shop, generation: merchant.generation },
    });
  }
  let merchant = await prisma.shop.findUnique({ where: { domain: shop } });
  if (published) {
    await prisma.snapshotRun.update({
      where: { id: merchant.activeRunId },
      data: {
        status: "COMPLETED",
        createdAt: new Date(Date.now() - 7200000),
        completedAt: new Date(Date.now() - 3600000),
      },
    });
    merchant = await prisma.shop.update({
      where: { domain: shop },
      data: { activeSnapshotId: merchant.activeRunId, activeRunId: null },
    });
    await prisma.catalogSyncState.update({
      where: { shop },
      data: { status: "READY" },
    });
  }
  return {
    shop,
    generation: merchant.generation,
    snapshotId: merchant.activeSnapshotId,
    runId: merchant.activeRunId,
  };
}
const requestKey = (f) => ({
  shop_generation: { shop: f.shop, generation: f.generation },
});
const request = (f) =>
  prisma.initialSyncRequest.findUnique({ where: requestKey(f) });
const consume = (f, options) =>
  consumeInitialSyncRequest(f.shop, f.generation, options);
const dueRequest = (f) =>
  prisma.initialSyncRequest.update({
    where: requestKey(f),
    data: { nextCheckAt: new Date(0) },
  });
const scheduleKey = (f, kind) => ({ shop_kind: { shop: f.shop, kind } });
const dueRepair = (f, kind = "INVENTORY_ITEM") =>
  prisma.catalogRepair.update({
    where: scheduleKey(f, kind),
    data: { nextCheckAt: new Date(0) },
  });
const repairState = (f, kind = "INVENTORY_ITEM") =>
  prisma.catalogRepair.findUnique({ where: scheduleKey(f, kind) });
const remotePage = (ids, { more = false, after = null } = {}) => ({
  data: {
    resources: {
      edges: ids.map((id) => ({
        node: { id, updatedAt: "2026-10-25T00:00:00Z" },
      })),
      pageInfo: { hasNextPage: more, endCursor: after },
    },
  },
});
const repair = (f, graphql, kind = "INVENTORY_ITEM", extra = {}) =>
  processInventoryRepairStep(f.shop, kind, { graphql, ...extra });
async function localItems(f, count = 1) {
  await prisma.inventoryItem.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      shop: f.shop,
      snapshotId: f.snapshotId,
      id: itemId(i + 1),
      tracked: true,
      requiresShipping: true,
      sourceUpdatedAt: new Date("2026-10-25T00:00:00Z"),
    })),
  });
}
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.installationState.deleteMany({
    where: { shopHash: { in: shops.map(shopHash) } },
  });
  await prisma.lifecycleReceipt.deleteMany({
    where: { shopHash: { in: shops.map(shopHash) } },
  });
  await prisma.$disconnect();
});

test("concurrent initial consumers reserve exactly one durable import without Redis", async () => {
  const f = await fixture();
  const outcomes = await Promise.all([consume(f), consume(f)]);
  assert.ok(outcomes.some((row) => row.status === "RUNNING"));
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 1);
  const row = await request(f);
  assert.equal(row.status, "RUNNING");
  assert.equal(row.leaseToken, null);
  assert.equal(
    row.snapshotId,
    (await prisma.shop.findUnique({ where: { domain: f.shop } })).activeRunId
  );
  assert.equal((await consume(f)).status, "not_due_or_leased");
});

test("initial requests attach to registration's run and complete only after publication", async () => {
  const f = await fixture({ registered: true });
  assert.equal((await consume(f)).snapshotId, f.runId);
  await dueRequest(f);
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { status: "RECONCILING" },
  });
  assert.equal((await consume(f)).status, "RUNNING");
  await prisma.$transaction(async (tx) => {
    await tx.snapshotRun.update({
      where: { id: f.runId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await tx.shop.update({
      where: { domain: f.shop },
      data: { activeSnapshotId: f.runId, activeRunId: null },
    });
  });
  await dueRequest(f);
  assert.equal((await consume(f)).status, "COMPLETED");
  assert.ok((await request(f)).completedAt);
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 1);
  assert.equal((await consume(f)).status, "not_due_or_leased");
});

test("published catalogs and terminal import failures do not start replacement imports", async () => {
  const published = await fixture({ published: true });
  assert.equal((await consume(published)).status, "COMPLETED");
  const failed = await fixture({ registered: true });
  await prisma.snapshotRun.update({
    where: { id: failed.runId },
    data: { status: "FAILED", lastError: "BULK_EXPORT_FAILED" },
  });
  assert.equal((await consume(failed)).status, "FAILED");
  assert.equal((await request(failed)).lastError, "BULK_EXPORT_FAILED");
  assert.equal(
    await prisma.snapshotRun.count({ where: { shop: failed.shop } }),
    1
  );
});

test("initial consumer failures roll back reservations, back off, and stop after eight attempts", async () => {
  const f = await fixture();
  const reserve = async (tx, merchant) => {
    await reserveCatalogSync(tx, merchant);
    throw Error("reservation interrupted");
  };
  for (let i = 1; i <= 8; i++) {
    await dueRequest(f);
    await assert.rejects(consume(f, { reserve }), /reservation interrupted/);
    const row = await request(f);
    assert.equal(row.attempts, i);
    assert.ok(row.nextCheckAt > new Date());
    assert.equal(row.leaseToken, null);
    assert.equal(
      await prisma.snapshotRun.count({ where: { shop: f.shop } }),
      0
    );
  }
  assert.equal((await request(f)).status, "FAILED");
  await dueRequest(f);
  assert.equal((await consume(f)).status, "not_due_or_leased");
});

test("initial consumer generation and lease fences prevent stale reservation", async () => {
  const f = await fixture();
  let transactions = 0;
  const replacement = randomUUID();
  const db = {
    $transaction: async (fn, options) => {
      const result = await prisma.$transaction(fn, options);
      if (++transactions === 1)
        await prisma.initialSyncRequest.update({
          where: requestKey(f),
          data: { leaseToken: replacement },
        });
      return result;
    },
  };
  assert.equal((await consume(f, { db })).status, "superseded");
  assert.equal((await request(f)).leaseToken, replacement);
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 0);
  await prisma.initialSyncRequest.update({
    where: requestKey(f),
    data: { leaseToken: null, leasedUntil: null },
  });
  await prisma.shop.update({
    where: { domain: f.shop },
    data: { generation: randomUUID() },
  });
  assert.equal((await consume(f)).status, "CANCELLED");
});

test("initial scanner selects only due unfinished requests and isolates per-request errors", async () => {
  const f = await fixture(),
    future = await fixture(),
    terminal = await fixture();
  await prisma.initialSyncRequest.update({
    where: requestKey(future),
    data: { nextCheckAt: new Date(Date.now() + 60000) },
  });
  await prisma.initialSyncRequest.update({
    where: requestKey(terminal),
    data: { status: "FAILED", attempts: 8 },
  });
  const seen = [];
  const db = {
    initialSyncRequest: {
      findMany: (args) =>
        prisma.initialSyncRequest.findMany({
          ...args,
          where: {
            ...args.where,
            shop: { in: [f.shop, future.shop, terminal.shop] },
          },
        }),
    },
  };
  await scanInitialSyncRequests({
    db,
    consume: async (shop) => {
      seen.push(shop);
      throw Error("isolated failure");
    },
    logger: { error() {} },
  });
  assert.deepEqual(seen, [f.shop]);
});

test("inventory metadata repair commits page cursors and staging invalidations together", async () => {
  const f = await fixture({ published: true });
  const staging = await prisma.$transaction(async (tx) => {
    const store = await tx.shop.findUnique({ where: { domain: f.shop } });
    return reserveCatalogSync(tx, store);
  });
  let calls = 0;
  const graphql = async (_shop, query, variables, context) => {
    calls++;
    assert.match(query, /inventoryItems/);
    assert.equal(context.generation, f.generation);
    assert.ok(context.signal);
    assert.match(variables.filter, /updated_at/);
    return variables.after === "next-page"
      ? remotePage([itemId(2)])
      : remotePage([itemId()], { more: true, after: "next-page" });
  };
  assert.equal((await repair(f, graphql)).status, "more_pages");
  const state = await repairState(f);
  assert.equal(JSON.parse(state.afterCursor).after, "next-page");
  assert.equal(state.coveredThrough, null);
  assert.equal((await repair(f, graphql)).status, "not_due_or_leased");
  await dueRepair(f);
  assert.equal((await repair(f, graphql)).status, "complete");
  assert.equal(calls, 2);
  assert.ok((await repairState(f)).coveredThrough);
  assert.equal(
    await prisma.inventoryChange.count({
      where: { shop: f.shop, dirty: true },
    }),
    2
  );
  assert.equal(
    await prisma.snapshotInventoryChange.count({
      where: { runId: staging.id, dirty: true },
    }),
    2
  );
});

test("inventory level sweeps discover unchanged timestamps and deletions through the existing worker", async () => {
  const f = await fixture({ published: true });
  const current = observation();
  current.item.id = itemId();
  current.levels[0].isActive = true;
  current.levels[0].quantities[0].quantity = 42;
  await localItems(f);
  const noGraphql = () =>
    assert.fail("Level discovery must not depend on item updated_at");
  assert.equal(
    (await processRepairStep(f.shop, "INVENTORY_LEVEL", { graphql: noGraphql }))
      .discovered,
    1
  );
  assert.equal(
    (
      await reconcileInventoryItem(f.shop, itemId(), {
        fetchInventory: async () => current,
      })
    ).status,
    "reconciled"
  );
  assert.equal(
    (
      await prisma.inventoryQuantity.findFirst({
        where: { shop: f.shop, name: "available" },
      })
    ).quantity,
    42
  );
  await dueRepair(f, "INVENTORY_LEVEL");
  await repair(f, noGraphql, "INVENTORY_LEVEL");
  await reconcileInventoryItem(f.shop, itemId(), {
    fetchInventory: async () => null,
  });
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
});

test("inventory level discovery paginates its baseline without skipping a tail page", async () => {
  const f = await fixture({ published: true });
  await localItems(f, 101);
  assert.equal((await repair(f, null, "INVENTORY_LEVEL")).discovered, 100);
  await dueRepair(f, "INVENTORY_LEVEL");
  assert.equal((await repair(f, null, "INVENTORY_LEVEL")).discovered, 1);
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    101
  );
});

test("inventory discovery preserves worker leases while advancing revisions and resetting failures", async () => {
  const f = await fixture({ published: true });
  await prisma.inventoryChange.create({
    data: {
      shop: f.shop,
      inventoryItemId: itemId(),
      revision: 5n,
      appliedRevision: 4n,
      attempts: 8,
      deadLetterAt: new Date(),
      leaseToken: "owned-worker",
      leasedUntil: new Date(Date.now() + 60000),
    },
  });
  await repair(f, async () => remotePage([itemId()]));
  const row = await prisma.inventoryChange.findUnique({
    where: {
      shop_inventoryItemId: { shop: f.shop, inventoryItemId: itemId() },
    },
  });
  assert.equal(row.revision, 6n);
  assert.equal(row.appliedRevision, 4n);
  assert.equal(row.dirty, true);
  assert.equal(row.attempts, 0);
  assert.equal(row.deadLetterAt, null);
  assert.equal(row.leaseToken, "owned-worker");
});

test("inventory repair rejects malformed pages, persists bounded retries, and never advances the cursor", async () => {
  const f = await fixture({ published: true });
  for (let attempt = 1; attempt <= 8; attempt++) {
    await dueRepair(f);
    await assert.rejects(
      repair(f, async () => remotePage([itemId(), itemId()])),
      /Duplicate/
    );
    const row = await repairState(f);
    assert.equal(row.attempts, attempt);
    assert.equal(row.afterCursor, null);
    assert.ok(row.nextCheckAt > new Date());
    assert.equal(row.leaseToken, null);
  }
  await dueRepair(f);
  assert.equal(
    (
      await repair(f, () =>
        assert.fail("Exhausted repair must not call Shopify")
      )
    ).status,
    "not_due_or_leased"
  );
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
});

test("inventory repair rolls back invalidations if cursor persistence fails", async () => {
  const f = await fixture({ published: true });
  const db = {
    snapshotRun: prisma.snapshotRun,
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, property) {
                if (property === "catalogRepair")
                  return {
                    update: async () => {
                      throw Error("cursor write failed");
                    },
                  };
                return Reflect.get(target, property);
              },
            })
          ),
        options
      ),
  };
  await assert.rejects(
    repair(f, async () => remotePage([itemId()]), "INVENTORY_ITEM", { db }),
    /cursor write failed/
  );
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await repairState(f)).afterCursor, null);
  assert.equal((await repairState(f)).attempts, 1);
});

test("snapshot publication during inventory discovery discards results and resets its cursor", async () => {
  const f = await fixture({ published: true });
  const result = await repair(f, async () => {
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
    return remotePage([itemId()]);
  });
  assert.equal(result.status, "snapshot_changed");
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await repairState(f)).afterCursor, null);
});

test("replacement leases and uninstall fence inventory discovery and initial requests", async () => {
  const f = await fixture({ published: true });
  const result = await repair(f, async () => {
    await prisma.catalogRepair.update({
      where: scheduleKey(f, "INVENTORY_ITEM"),
      data: {
        leaseToken: "replacement",
        leasedUntil: new Date(Date.now() + 60000),
      },
    });
    return remotePage([itemId()]);
  });
  assert.equal(result.status, "superseded");
  assert.equal((await repairState(f)).leaseToken, "replacement");
  await prisma.catalogRepair.update({
    where: scheduleKey(f, "INVENTORY_ITEM"),
    data: { leaseToken: null, leasedUntil: null },
  });
  const uninstalled = await repair(f, async () => {
    await processLifecycle({
      id: randomUUID(),
      shop: f.shop,
      topic: "app/uninstalled",
      payloadHash: "a".repeat(64),
      triggeredAt: new Date(Date.now() + 1000),
    });
    return remotePage([itemId()]);
  });
  assert.equal(uninstalled.status, "superseded");
  assert.equal((await request(f)).status, "CANCELLED");
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await consume(f)).status, "not_due_or_leased");
});

test("initial reservation and inventory invalidations roll back if their lease expires before acknowledgment", async () => {
  const initial = await fixture();
  await assert.rejects(
    consume(initial, {
      reserve: async (tx, merchant) => {
        const run = await reserveCatalogSync(tx, merchant);
        await tx.initialSyncRequest.update({
          where: requestKey(initial),
          data: { leasedUntil: new Date(0) },
        });
        return run;
      },
    }),
    /lease lost before completion/
  );
  assert.equal(
    await prisma.snapshotRun.count({ where: { shop: initial.shop } }),
    0
  );
  assert.equal((await request(initial)).status, "PENDING");

  const inventory = await fixture({ published: true });
  const db = {
    snapshotRun: prisma.snapshotRun,
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, property) {
                if (property === "catalogRepair")
                  return {
                    update: async (args) => {
                      const row = await target.catalogRepair.update(args);
                      await target.catalogRepair.update({
                        where: args.where,
                        data: { leasedUntil: new Date(0) },
                      });
                      return row;
                    },
                  };
                return Reflect.get(target, property);
              },
            })
          ),
        options
      ),
  };
  await assert.rejects(
    repair(inventory, async () => remotePage([itemId()]), "INVENTORY_ITEM", {
      db,
    }),
    /lease lost before cursor commit/
  );
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: inventory.shop } }),
    0
  );
  assert.equal((await repairState(inventory)).afterCursor, null);
});

test("initial request transactions retry Prisma unique and serialization conflicts", async () => {
  for (const code of ["P2002", "P2034"]) {
    const f = await fixture();
    let attempts = 0;
    const db = {
      $transaction: (fn, options) => {
        if (++attempts === 1)
          return Promise.reject(
            Object.assign(Error("retryable conflict"), { code })
          );
        return prisma.$transaction(fn, options);
      },
    };
    assert.equal((await consume(f, { db })).status, "RUNNING");
    assert.equal(
      await prisma.snapshotRun.count({ where: { shop: f.shop } }),
      1
    );
  }
});

test("a stale initial request follows the shop's current run without duplicating it", async () => {
  const f = await fixture({ registered: true });
  await consume(f);
  const replacement = await prisma.snapshotRun.create({
    data: { shop: f.shop, generation: f.generation, status: "PENDING" },
  });
  await prisma.shop.update({
    where: { domain: f.shop },
    data: { activeRunId: replacement.id },
  });
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { status: "CANCELLED" },
  });
  await dueRequest(f);
  const result = await consume(f);
  assert.equal(result.status, "RUNNING");
  assert.equal(result.snapshotId, replacement.id);
  assert.equal(await prisma.snapshotRun.count({ where: { shop: f.shop } }), 2);
});

test("malformed stored inventory identities cannot create poison reconciliation jobs", async () => {
  const f = await fixture({ published: true });
  await prisma.inventoryItem.create({
    data: {
      shop: f.shop,
      snapshotId: f.snapshotId,
      id: "malformed",
      tracked: true,
      requiresShipping: true,
      sourceUpdatedAt: new Date(),
    },
  });
  await assert.rejects(
    repair(f, null, "INVENTORY_LEVEL"),
    /Malformed local inventory repair item/
  );
  assert.equal(
    await prisma.inventoryChange.count({ where: { shop: f.shop } }),
    0
  );
  assert.equal((await repairState(f, "INVENTORY_LEVEL")).attempts, 1);
});
