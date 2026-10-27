import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client.js";
import {
  registerShop,
  shopHash,
} from "../domains/lifecycle/lifecycle.repository.js";
import { stageSnapshotProducts } from "../domains/snapshots/snapshots.service.js";
import { stageSnapshotInventoryItems } from "../domains/inventory/inventory.contract.js";
import { writeInventorySnapshotBatch } from "../domains/inventory/inventory.batch.js";
import { claimSnapshotLease } from "../domains/sync/sync.lease.js";
import { importTransaction } from "../domains/sync/sync.import.js";
import { observation } from "./fixtures/inventory.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const shops = [];
async function fixture() {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const merchant = await registerShop(shop);
  const run = await prisma.snapshotRun.update({
    where: { id: merchant.activeRunId },
    data: { status: "INGESTING", expectedProducts: 100 },
  });
  const { token } = await claimSnapshotLease(run, { includeIngestion: true });
  return {
    shop,
    generation: merchant.generation,
    runId: run.id,
    leaseToken: token,
    run,
  };
}
const product = (i, variantId = i) => ({
  product: {
    id: `gid://shopify/Product/${i}`,
    title: `Product ${i}`,
    variantsCount: { count: 1, precision: "EXACT" },
  },
  variants: [
    {
      id: `gid://shopify/ProductVariant/${variantId}`,
      __parentId: `gid://shopify/Product/${i}`,
      position: 1,
      price: "1.0000000001",
      compareAtPrice: null,
      inventoryItem: { id: `gid://shopify/InventoryItem/${i}` },
    },
  ],
});
const inventory = (i) => {
  const current = observation(1);
  current.item.id = `gid://shopify/InventoryItem/${i}`;
  current.levels[0].id = `gid://shopify/InventoryLevel/${i}?inventory_item_id=${i}`;
  return current;
};
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.installationState.deleteMany({
    where: { shopHash: { in: shops.map(shopHash) } },
  });
  await prisma.$disconnect();
});

test("100-product batches keep canonical JSON, variants and durable progress atomic and idempotent", async () => {
  const f = await fixture();
  const products = Array.from({ length: 100 }, (_, i) => product(i + 1));
  await stageSnapshotProducts({ ...f, products });
  await stageSnapshotProducts({ ...f, products });
  assert.equal(
    await prisma.snapshotProduct.count({ where: { runId: f.runId } }),
    100,
  );
  assert.equal(
    await prisma.variant.count({
      where: { shop: f.shop, snapshotId: f.runId },
    }),
    100,
  );
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .importedProducts,
    100,
  );
  await assert.rejects(
    stageSnapshotProducts({
      ...f,
      products: [product(101, 1001), product(102, 1001)],
    }),
  );
  assert.equal(
    await prisma.snapshotProduct.count({ where: { runId: f.runId } }),
    100,
  );
  assert.equal(
    await prisma.variant.count({
      where: { shop: f.shop, snapshotId: f.runId },
    }),
    100,
  );
  assert.equal(
    (await prisma.snapshotRun.findUnique({ where: { id: f.runId } }))
      .importedProducts,
    100,
  );
});

test("inventory batches replay exactly, preserve newer shared locations and replace complete level sets", async () => {
  const f = await fixture();
  const observations = Array.from({ length: 100 }, (_, i) => inventory(i + 1));
  const where = { shop: f.shop, snapshotId: f.runId };
  await stageSnapshotInventoryItems({ ...f, observations });
  await prisma.inventoryLocation.updateMany({
    where,
    data: {
      name: "Newer location",
      sourceUpdatedAt: new Date("2026-10-26T00:00:00Z"),
    },
  });
  await stageSnapshotInventoryItems({ ...f, observations });
  assert.equal(await prisma.inventoryItem.count({ where }), 100);
  assert.equal(await prisma.inventoryLevel.count({ where }), 100);
  assert.equal(
    await prisma.inventoryQuantity.count({ where }),
    100 * observations[0].levels[0].quantities.length,
  );
  assert.equal(
    (await prisma.inventoryLocation.findFirst({ where })).name,
    "Newer location",
  );
  await stageSnapshotInventoryItems({
    ...f,
    observations: [{ ...inventory(1), levels: [] }],
  });
  assert.equal(await prisma.inventoryLevel.count({ where }), 99);
  assert.equal(await prisma.inventoryItem.count({ where }), 100);
  const invalid = inventory(101);
  invalid.levels[0].quantities[0].quantity = 1.5;
  await assert.rejects(
    stageSnapshotInventoryItems({
      ...f,
      observations: [inventory(102), invalid],
    }),
  );
  assert.equal(await prisma.inventoryItem.count({ where }), 100);
  await assert.rejects(
    importTransaction(f.run, f.leaseToken, async (tx) => {
      await writeInventorySnapshotBatch(tx, f.shop, f.runId, [inventory(103)]);
      throw Error("after batch write");
    }),
    /after batch write/,
  );
  assert.equal(await prisma.inventoryItem.count({ where }), 100);
  assert.equal(await prisma.inventoryLevel.count({ where }), 99);
});

test("inventory batch writes reject expired leases and sealed or superseded ingestion", async () => {
  const f = await fixture();
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { leasedUntil: new Date(0) },
  });
  await assert.rejects(
    stageSnapshotInventoryItems({ ...f, observations: [inventory(1)] }),
    { code: "SYNC_LEASE_LOST" },
  );
  await prisma.snapshotRun.update({
    where: { id: f.runId },
    data: { leasedUntil: new Date(Date.now() + 120000), status: "RECONCILING" },
  });
  await assert.rejects(
    stageSnapshotInventoryItems({ ...f, observations: [inventory(1)] }),
    { code: "SYNC_RUN_NOT_ACTIVE" },
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0,
  );
});

test("inventory batch writer refuses a root database client before any mutation", async () => {
  const f = await fixture();
  await assert.rejects(
    writeInventorySnapshotBatch(prisma, f.shop, f.runId, [inventory(1)]),
    /existing Prisma transaction/,
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0,
  );
});
