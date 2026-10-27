import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { prisma } from "../db/client.js";
import {
  readProductCatalog,
  parseCatalogQuery,
} from "../domains/products/products.catalog.js";
import { createSyncRouter } from "../domains/sync/sync.routes.js";
import { writeInventoryItemSnapshot } from "../domains/inventory/inventory.service.js";
import { observation, itemId } from "./fixtures/inventory.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Run with npm test");
const shops = [];
let primary, other, server, base;
const id = (number) => `gid://shopify/Product/${number}`;
const rows = [
  {
    id: id(1),
    title: "Blue shirt",
    status: "ACTIVE",
    vendor: "North",
    productType: "Shirts",
    totalInventory: 0,
    tracksInventory: true,
    featuredImage: { url: "https://cdn.shopify.com/blue.jpg" },
    variants: [{ id: "v1" }, { id: "v2" }],
  },
  {
    id: id(2),
    title: "Red shirt",
    status: "DRAFT",
    vendor: "South",
    tracksInventory: false,
    variants: [{ id: "v3" }],
  },
  {
    id: id(3),
    title: "100%_Cotton",
    status: "ARCHIVED",
    vendor: "North",
    totalInventory: -2,
    tracksInventory: true,
    variants: [],
  },
  {
    id: id(4),
    title: "Hidden shirt",
    status: "UNLISTED",
    vendor: "East",
    variants: [{ id: "v4" }],
  },
];
async function fixture(products, status = "READY") {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const store = await prisma.shop.create({ data: { domain: shop } });
  await prisma.catalogSyncState.create({
    data: { shop, generation: store.generation, status },
  });
  const run = await prisma.snapshotRun.create({
    data: {
      shop,
      generation: store.generation,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  if (products.length)
    await prisma.snapshotProduct.createMany({
      data: products.map((data) => ({
        runId: run.id,
        productId: data.id,
        data,
      })),
    });
  await prisma.shop.update({
    where: { domain: shop },
    data: { activeSnapshotId: run.id },
  });
  return { shop, run, generation: store.generation };
}
before(async () => {
  primary = await fixture(rows);
  other = await fixture([{ ...rows[0], title: "Private other tenant" }]);
  const staging = await prisma.snapshotRun.create({
    data: { shop: primary.shop, generation: primary.generation },
  });
  await prisma.snapshotProduct.create({
    data: {
      runId: staging.id,
      productId: id(99),
      data: { title: "Unpublished secret", variants: [] },
    },
  });
  const app = express();
  app.use((req, res, next) => {
    if (req.headers["test-auth"])
      res.locals.shopify = { session: { shop: primary.shop } };
    next();
  });
  app.use("/api/mirror", createSyncRouter());
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/mirror/products`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } });
  await prisma.$disconnect();
});

test("catalog pages expose only published rows and real counts with bounded projection", async () => {
  const result = await readProductCatalog(primary.shop, { limit: "2" });
  assert.deepEqual(result.summary, {
    productCount: 4,
    variantCount: 4,
    activeCount: 1,
  });
  assert.deepEqual(
    result.products.map((row) => row.id),
    [id(1), id(2)]
  );
  assert.equal(result.products[0].totalInventory, 0);
  assert.equal(result.products[0].tracksInventory, true);
  assert.equal(result.products[1].tracksInventory, false);
  assert.equal(result.products[1].totalInventory, null);
  assert.ok(!Object.hasOwn(result.products[0], "variants"));
  assert.equal(result.pageInfo.hasNextPage, true);
  const next = await readProductCatalog(primary.shop, {
    limit: "2",
    cursor: result.pageInfo.endCursor,
  });
  assert.deepEqual(
    next.products.map((row) => row.id),
    [id(3), id(4)]
  );
  assert.equal(next.pageInfo.hasNextPage, false);
  assert.equal(next.products[0].totalInventory, -2);
});
test("search and status operate over the entire catalog and escape SQL wildcard input", async () => {
  const north = await readProductCatalog(primary.shop, {
    search: "north",
    limit: "1",
  });
  assert.equal(north.filteredCount, 2);
  const draft = await readProductCatalog(primary.shop, {
    search: "shirt",
    status: "draft",
  });
  assert.equal(draft.filteredCount, 1);
  assert.equal(draft.products[0].id, id(2));
  assert.equal(draft.summary.productCount, 4);
  assert.equal(
    (await readProductCatalog(primary.shop, { search: "%_" })).products[0].id,
    id(3)
  );
  assert.equal(
    (await readProductCatalog(primary.shop, { search: "%' OR 1=1 --" }))
      .filteredCount,
    0
  );
  await assert.rejects(
    readProductCatalog(primary.shop, {
      search: "other",
      cursor: north.pageInfo.endCursor,
    }),
    { status: 400 }
  );
});
test("HTTP reads require an authenticated session and ignore spoofed tenant identifiers", async () => {
  assert.equal(
    (await fetch(base, { headers: { "x-shopify-shop-domain": primary.shop } }))
      .status,
    401
  );
  const response = await fetch(`${base}?shop=${other.shop}`, {
    headers: { "test-auth": "yes", "x-shopify-shop-domain": other.shop },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.summary.productCount, 4);
  assert.ok(
    result.products.every(
      (product) =>
        product.title !== "Private other tenant" &&
        product.title !== "Unpublished secret"
    )
  );
});
test("a new publication rejects an old page cursor and cannot mix snapshots", async () => {
  const first = await readProductCatalog(primary.shop, { limit: "1" });
  const replacement = await prisma.snapshotRun.create({
    data: {
      shop: primary.shop,
      generation: primary.generation,
      status: "COMPLETED",
    },
  });
  await prisma.shop.update({
    where: { domain: primary.shop },
    data: { activeSnapshotId: replacement.id },
  });
  try {
    await assert.rejects(
      readProductCatalog(primary.shop, { cursor: first.pageInfo.endCursor }),
      { code: "CATALOG_SNAPSHOT_CHANGED", status: 409 }
    );
    assert.equal((await readProductCatalog(primary.shop)).products.length, 0);
  } finally {
    await prisma.shop.update({
      where: { domain: primary.shop },
      data: { activeSnapshotId: primary.run.id },
    });
  }
});
test("initial import, failed resync, and empty stores have truthful states", async () => {
  const pending = await fixture([], "PENDING");
  await prisma.shop.update({
    where: { domain: pending.shop },
    data: { activeSnapshotId: null },
  });
  const waiting = await readProductCatalog(pending.shop);
  assert.equal(waiting.snapshotId, null);
  assert.equal(waiting.syncStatus, "PENDING");
  assert.deepEqual(waiting.products, []);
  const empty = await fixture([]);
  assert.ok((await readProductCatalog(empty.shop)).snapshotId);
  await prisma.catalogSyncState.update({
    where: { shop: primary.shop },
    data: { status: "FAILED" },
  });
  try {
    const failed = await readProductCatalog(primary.shop);
    assert.equal(failed.syncStatus, "FAILED");
    assert.equal(failed.products.length, 4);
  } finally {
    await prisma.catalogSyncState.update({
      where: { shop: primary.shop },
      data: { status: "READY" },
    });
  }
});
test("foreign snapshots and snapshots from an older installation cannot be read", async () => {
  await prisma.shop.update({
    where: { domain: primary.shop },
    data: { activeSnapshotId: other.run.id },
  });
  try {
    await assert.rejects(readProductCatalog(primary.shop), {
      code: "CATALOG_UNAVAILABLE",
    });
  } finally {
    await prisma.shop.update({
      where: { domain: primary.shop },
      data: { activeSnapshotId: primary.run.id },
    });
  }
  await prisma.snapshotRun.update({
    where: { id: primary.run.id },
    data: { generation: randomUUID() },
  });
  try {
    await assert.rejects(readProductCatalog(primary.shop), {
      code: "CATALOG_UNAVAILABLE",
    });
  } finally {
    await prisma.snapshotRun.update({
      where: { id: primary.run.id },
      data: { generation: primary.generation },
    });
  }
});
test("invalid queries fail before opening a database transaction", () => {
  for (const query of [
    { limit: "0" },
    { limit: "101" },
    { search: ["a", "b"] },
    { cursor: "bad!" },
    { status: "INVALID" },
    { search: "a".repeat(201) },
  ])
    assert.throws(() => parseCatalogQuery(query), {
      code: "INVALID_CATALOG_QUERY",
    });
});

test("inventory-only webhook writes are visible without waiting for product JSON to change", async () => {
  const store = await fixture([rows[0]]);
  await prisma.variant.create({
    data: {
      shop: store.shop,
      snapshotId: store.run.id,
      id: "gid://shopify/ProductVariant/123",
      productId: rows[0].id,
      inventoryItemId: itemId,
    },
  });
  const current = observation();
  current.levels[0].isActive = true;
  current.levels[0].quantities[0].quantity = 7;
  await prisma.$transaction(async (tx) =>
    writeInventoryItemSnapshot(tx, store.shop, store.run.id, itemId, current)
  );
  assert.equal(
    (await readProductCatalog(store.shop)).products[0].totalInventory,
    7
  );
  current.levels[0].quantities[0].quantity = -3;
  await prisma.$transaction(async (tx) =>
    writeInventoryItemSnapshot(tx, store.shop, store.run.id, itemId, current)
  );
  assert.equal(
    (await readProductCatalog(store.shop)).products[0].totalInventory,
    -3
  );
  assert.equal(
    (
      await prisma.snapshotProduct.findUnique({
        where: {
          runId_productId: { runId: store.run.id, productId: rows[0].id },
        },
      })
    ).data.totalInventory,
    0
  );
});
