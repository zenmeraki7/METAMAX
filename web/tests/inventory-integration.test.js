import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeInventoryItemSnapshot } from "../domains/inventory/inventory.service.js";
import { itemId, observation } from "./fixtures/inventory.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const { startCatalogSnapshot, stageSnapshotProducts } = await import(
  "../domains/snapshots/snapshots.service.js"
);
const { writeProductSnapshot } = await import(
  "../domains/products/products.service.js"
);
const shops = [];
async function fixture() {
  const shop = `test-${randomUUID()}.myshopify.com`;
  const merchant = await prisma.shop.create({ data: { domain: shop } });
  shops.push(shop);
  const run = await prisma.snapshotRun.create({
    data: { shop, generation: merchant.generation },
  });
  return { shop, snapshotId: run.id };
}
async function write(f, current, id = itemId) {
  return prisma.$transaction(
    async (tx) => {
      // Simulate the caller's publication boundary. The inventory worker must also
      // fence its own observed inventory revision and lease in this transaction.
      await tx.$queryRaw`SELECT "domain" FROM "Shop" WHERE "domain"=${f.shop} FOR SHARE`;
      await writeInventoryItemSnapshot(tx, f.shop, f.snapshotId, id, current);
    },
    { timeout: 30000 }
  );
}
after(async () => {
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.$disconnect();
});

test("inventory replacement preserves opaque GIDs, named quantities, inactive levels, and independent snapshots", async () => {
  const f = await fixture();
  const current = observation(2);
  await write(f, current);
  const key = {
    shop: f.shop,
    snapshotId: f.snapshotId,
    inventoryItemId: itemId,
  };
  const rows = await prisma.inventoryLevel.findMany({
    where: key,
    orderBy: { locationId: "asc" },
  });
  assert.equal(rows[0].shopifyLevelId, current.levels[0].id);
  assert.equal(rows[0].isActive, false);
  assert.equal(await prisma.inventoryQuantity.count({ where: key }), 16);
  const available = await prisma.inventoryQuantity.findFirst({
    where: { ...key, name: "available" },
  });
  assert.equal(available.quantity, -3);
  assert.equal(available.sourceUpdatedAt, null);
  const other = await prisma.snapshotRun.create({ data: { shop: f.shop } });
  await write({ ...f, snapshotId: other.id }, current);
  await write(f, observation(0));
  assert.equal(await prisma.inventoryLevel.count({ where: key }), 0);
  assert.equal(await prisma.inventoryQuantity.count({ where: key }), 0);
  assert.equal(
    await prisma.inventoryLevel.count({
      where: { ...key, snapshotId: other.id },
    }),
    2
  );
});

test("shared locations keep fresher metadata and survive item deletion", async () => {
  const f = await fixture();
  const fresh = observation();
  fresh.levels[0].location.name = "Fresh name";
  fresh.levels[0].location.updatedAt = "2026-10-25T02:00:00Z";
  await write(f, fresh);
  const old = observation();
  const secondId = "gid://shopify/InventoryItem/456";
  old.item.id = secondId;
  old.levels[0].id = "gid://shopify/InventoryLevel/1?inventory_item_id=456";
  await write(f, old, secondId);
  assert.equal(
    (await prisma.inventoryLocation.findFirst({ where: { shop: f.shop } }))
      .name,
    "Fresh name"
  );
  await write(f, null);
  assert.equal(
    await prisma.inventoryLevel.count({
      where: { shop: f.shop, inventoryItemId: itemId },
    }),
    0
  );
  assert.equal(
    await prisma.inventoryQuantity.count({
      where: { shop: f.shop, inventoryItemId: itemId },
    }),
    0
  );
  assert.equal(
    await prisma.inventoryLevel.count({
      where: { shop: f.shop, inventoryItemId: secondId },
    }),
    1
  );
  assert.equal(
    await prisma.inventoryLocation.count({ where: { shop: f.shop } }),
    1
  );
});

test("the caller's transaction rolls back an entire inventory replacement on failure", async () => {
  const f = await fixture();
  await write(f, observation(2));
  const changed = observation();
  changed.item.sku = "Changed";
  changed.levels[0].quantities[0].quantity = 999;
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await writeInventoryItemSnapshot(
        tx,
        f.shop,
        f.snapshotId,
        itemId,
        changed
      );
      throw Error("fenced transaction failed");
    }),
    /fenced transaction failed/
  );
  assert.equal(
    (await prisma.inventoryItem.findFirst({ where: { shop: f.shop } })).sku,
    null
  );
  assert.equal(
    await prisma.inventoryLevel.count({ where: { shop: f.shop } }),
    2
  );
  assert.equal(
    await prisma.inventoryQuantity.count({
      where: { shop: f.shop, quantity: 999 },
    }),
    0
  );
});

test("tenant foreign keys reject cross-shop snapshots and snapshot deletion cascades", async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(
    write({ ...f, snapshotId: other.snapshotId }, observation()),
    { code: "P2003" }
  );
  await write(f, observation());
  await prisma.snapshotRun.delete({ where: { id: f.snapshotId } });
  for (const model of [
    "inventoryItem",
    "inventoryLocation",
    "inventoryLevel",
    "inventoryQuantity",
  ])
    assert.equal(await prisma[model].count({ where: { shop: f.shop } }), 0);
});

test("a root Prisma client cannot replace inventory outside the caller transaction", async () => {
  const f = await fixture();
  await assert.rejects(
    writeInventoryItemSnapshot(
      prisma,
      f.shop,
      f.snapshotId,
      itemId,
      observation()
    ),
    /existing Prisma transaction/
  );
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
});

test("inventory writer batches quantities beyond a single insert", async () => {
  const f = await fixture();
  await write(f, observation(27));
  assert.equal(
    await prisma.inventoryQuantity.count({ where: { shop: f.shop } }),
    216
  );
});

test("variant inventory references persist with JSON, permit shared items, and load independently", async () => {
  const f = await fixture();
  const generation = (
    await prisma.shop.findUnique({ where: { domain: f.shop } })
  ).generation;
  const run = await startCatalogSnapshot({
    shop: f.shop,
    generation,
    expectedProducts: 1,
  });
  const productId = "gid://shopify/Product/123";
  const current = {
    product: { id: productId, variantsCount: { count: 2, precision: "EXACT" } },
    variants: [1, 2].map((i) => ({
      id: `gid://shopify/ProductVariant/${i}`,
      __parentId: productId,
      position: i,
      price: "1.99",
      compareAtPrice: null,
      inventoryItem: { id: itemId },
    })),
  };
  await stageSnapshotProducts({
    shop: f.shop,
    generation,
    runId: run.id,
    products: [current],
  });
  const key = { shop: f.shop, snapshotId: run.id, inventoryItemId: itemId };
  assert.equal(await prisma.variant.count({ where: key }), 2);
  assert.equal(
    await prisma.inventoryItem.count({ where: { shop: f.shop } }),
    0
  );
  const stored = await prisma.snapshotProduct.findUnique({
    where: { runId_productId: { runId: run.id, productId } },
  });
  assert.equal(stored.data.variants[0].inventoryItemId, itemId);
  const changed = structuredClone(current);
  changed.product.variantsCount.count = 1;
  changed.variants.pop();
  await prisma.$transaction(async (tx) => {
    await writeProductSnapshot(tx, f.shop, run.id, productId, changed);
  });
  assert.equal(await prisma.variant.count({ where: key }), 1);
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await writeProductSnapshot(tx, f.shop, run.id, productId, current);
      throw Error("rollback projection");
    }),
    /rollback projection/
  );
  assert.equal(await prisma.variant.count({ where: key }), 1);
  await prisma.$transaction((tx) =>
    writeProductSnapshot(tx, f.shop, run.id, productId, null)
  );
  assert.equal(await prisma.variant.count({ where: key }), 0);
});
