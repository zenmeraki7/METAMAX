import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../shared/db.js";
import { recordProductWebhook } from "../domains/webhooks/webhooks.repository.js";
import { reconcileProduct } from "../domains/webhooks/webhooks.service.js";
import { createProductsService, writeCurrentProduct, writeProductSnapshot } from "../domains/products/products.service.js";
import { publishRun } from "../domains/sync/sync.repository.js";
import { GET_PRODUCT_VERSION } from "../domains/products/products.queries.js";
if (process.env.RUN_INTEGRATION_TESTS !== "1") throw Error("Use the isolated mirror runner with --suite reconciliation");
const shops = [], productId = "gid://shopify/Product/123", version = "2026-10-26T00:00:00Z";
const variantId = i => `gid://shopify/ProductVariant/${i}`;
const current = (ids = [1, 2, 3], title = "Original") => ({
  product: { id: productId, title, updatedAt: version, variantsCount: { count: ids.length, precision: "EXACT" } },
  variants: ids.map((id, index) => ({ id: variantId(id), __parentId: productId, position: index + 1,
    price: "19.99000000000001", compareAtPrice: null, inventoryItemId: `gid://shopify/InventoryItem/${id}` })),
});
async function fixture() {
  const shop = `test-reconcile-${randomUUID()}.myshopify.com`; shops.push(shop);
  const merchant = await prisma.shop.create({ data: { domain: shop, installationVerified: true } });
  const run = await prisma.snapshotRun.create({ data: { shop, generation: merchant.generation, status: "COMPLETED", expectedProducts: 1, importedProducts: 1, completedAt: new Date() } });
  await prisma.shop.update({ where: { domain: shop }, data: { activeSnapshotId: run.id } });
  await prisma.$transaction(tx => writeCurrentProduct(tx, shop, productId, 0n, current(), { generation: merchant.generation, snapshotId: run.id }));
  return { shop, generation: merchant.generation, runId: run.id };
}
const ledger = f => prisma.catalogChange.findUnique({ where: { shop_productId: { shop: f.shop, productId } } });
const mirror = f => prisma.snapshotProduct.findUnique({ where: { runId_productId: { runId: f.runId, productId } } });
function delivery(f, topic = "products/update") { const id = randomUUID(); return { id, eventId: id, shop: f.shop, productId, topic, payloadHash: "a".repeat(64), triggeredAt: new Date() }; }
function authoritative(state) {
  let calls = 0;
  const service = createProductsService({ graphql: async (_shop, query) => {
    calls++;
    if (state === null) return { data: { product: null } };
    if (query === GET_PRODUCT_VERSION) return { data: { product: state.product } };
    return { data: { product: { ...state.product, variants: { edges: state.variants.map(node => ({ node })), pageInfo: { hasNextPage: false } } } } };
  } });
  return { fetchProduct: service.fetchCurrentProduct, get calls() { return calls; } };
}
after(async () => {
  await prisma.shop.updateMany({ where: { domain: { in: shops } }, data: { activeSnapshotId: null, activeRunId: null } });
  await prisma.shop.deleteMany({ where: { domain: { in: shops } } }); await prisma.$disconnect();
});
test("concurrent duplicate deliveries commit one receipt/revision and clean or duplicate jobs make no extra Shopify fetch", async () => {
  const f = await fixture(), input = delivery(f);
  const receipts = await Promise.all([recordProductWebhook(input), recordProductWebhook(input), recordProductWebhook(input)]);
  assert.equal(receipts.filter(row => !row.duplicate).length, 1);
  assert.equal(await prisma.webhookEvent.count({ where: { shop: f.shop } }), 1);
  assert.equal((await ledger(f)).revision, 1n);
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const source = authoritative(current([1, 3], "Authoritative"));
  let fetches = 0;
  const options = { fetchProduct: async (...args) => { fetches++; entered(); await gate; return source.fetchProduct(...args); } };
  const first = reconcileProduct(f.shop, productId, options); await started;
  assert.equal((await reconcileProduct(f.shop, productId, options)).status, "skipped");
  unblock(); assert.equal((await first).status, "reconciled");
  assert.equal((await reconcileProduct(f.shop, productId, options)).status, "skipped");
  assert.equal(fetches, 1); assert.equal(source.calls, 2);
  assert.equal((await mirror(f)).data.title, "Authoritative");
  assert.deepEqual((await mirror(f)).data.variants.map(row => row.id), [variantId(1), variantId(3)]);
  assert.deepEqual((await prisma.variant.findMany({ where: { shop: f.shop, snapshotId: f.runId }, orderBy: { id: "asc" } })).map(row => row.id), [variantId(1), variantId(3)]);
});
test("receipt/invalidation rollback together if staging cannot commit", async () => {
  const f = await fixture(), input = delivery(f);
  await prisma.shop.update({ where: { domain: f.shop }, data: { activeRunId: randomUUID() } });
  await assert.rejects(() => recordProductWebhook(input));
  assert.equal(await prisma.webhookEvent.count({ where: { shop: f.shop } }), 0);
  assert.equal(await ledger(f), null);
});
test("a delete notification refetches authoritative absence twice before atomically removing product and variants", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f, "products/delete"));
  const source = authoritative(null);
  assert.equal((await reconcileProduct(f.shop, productId, source)).status, "reconciled");
  assert.equal(source.calls, 2); assert.equal(await mirror(f), null);
  assert.equal(await prisma.productMirror.count({ where: { shop: f.shop, productId } }), 0);
  assert.equal(await prisma.variant.count({ where: { shop: f.shop, snapshotId: f.runId } }), 0);
  assert.equal((await ledger(f)).dirty, false); assert.equal((await ledger(f)).appliedRevision, 1n);
});
test("access errors cannot turn a delete notification into a mirror deletion", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f, "products/delete"));
  const source = createProductsService({ graphql: async () => ({ data: { product: null }, errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }) });
  await assert.rejects(() => reconcileProduct(f.shop, productId, { fetchProduct: source.fetchCurrentProduct }), { code: "SHOPIFY_GRAPHQL_ERRORS" });
  assert.ok(await mirror(f)); assert.equal((await ledger(f)).dirty, true); assert.equal((await ledger(f)).appliedRevision, 0n);
  assert.equal((await ledger(f)).attempts, 1);
});
test("an expired unreclaimed lease cannot acknowledge or write its fetched revision", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f));
  const result = await reconcileProduct(f.shop, productId, { fetchProduct: async () => {
    await prisma.catalogChange.update({ where: { shop_productId: { shop: f.shop, productId } }, data: { leasedUntil: new Date(0) } });
    return current([1], "Expired worker");
  } });
  assert.equal(result.status, "superseded"); assert.equal((await mirror(f)).data.title, "Original");
  assert.equal((await ledger(f)).dirty, true); assert.equal((await ledger(f)).appliedRevision, 0n);
});
test("a newer webhook revision supersedes an older fetched state", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f));
  const result = await reconcileProduct(f.shop, productId, { fetchProduct: async () => {
    await recordProductWebhook(delivery(f)); return current([1], "Old fetch");
  } });
  assert.equal(result.status, "superseded"); assert.equal((await ledger(f)).revision, 2n);
  assert.equal((await ledger(f)).appliedRevision, 0n); assert.equal((await mirror(f)).data.title, "Original");
  assert.equal((await reconcileProduct(f.shop, productId, authoritative(current([3], "Latest")))).status, "reconciled");
  assert.equal((await ledger(f)).appliedRevision, 2n);
});
test("snapshot publication fences an incremental worker that fetched against the previous pointer", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f));
  await prisma.catalogSyncState.create({ data: { shop: f.shop, generation: f.generation, requiredDatasets: ["products", "variants"] } });
  let replacement;
  const result = await reconcileProduct(f.shop, productId, { fetchProduct: async () => {
    const leaseToken = randomUUID();
    replacement = await prisma.snapshotRun.create({ data: { shop: f.shop, generation: f.generation, status: "RECONCILING", expectedProducts: 1, importedProducts: 1, leaseToken, leasedUntil: new Date(Date.now() + 60000) } });
    await prisma.shop.update({ where: { domain: f.shop }, data: { activeRunId: replacement.id } });
    await prisma.$transaction(async tx => {
      await writeProductSnapshot(tx, f.shop, replacement.id, productId, current([3], "Replacement"));
      await tx.snapshotChange.create({ data: { runId: replacement.id, productId, revision: 1n, appliedRevision: 1n, dirty: false } });
    });
    await publishRun(replacement, leaseToken, 1); return current([1], "Stale result");
  } });
  assert.equal(result.status, "superseded");
  assert.equal((await prisma.shop.findUnique({ where: { domain: f.shop } })).activeSnapshotId, replacement.id);
  const published = await prisma.snapshotProduct.findUnique({ where: { runId_productId: { runId: replacement.id, productId } } });
  assert.equal(published.data.title, "Replacement"); assert.equal((await ledger(f)).dirty, false);
});
test("a mirror-write failure rolls back deletion and revision acknowledgment together", async () => {
  const f = await fixture(); await recordProductWebhook(delivery(f));
  await assert.rejects(() => reconcileProduct(f.shop, productId, {
    fetchProduct: async () => null,
    writeReconciledProduct: async tx => { await tx.snapshotProduct.deleteMany({ where: { runId: f.runId, productId } }); throw Error("write failed after deletion"); },
  }), /write failed after deletion/);
  assert.ok(await mirror(f)); assert.equal(await prisma.variant.count({ where: { shop: f.shop, snapshotId: f.runId } }), 3);
  assert.equal((await ledger(f)).appliedRevision, 0n); assert.equal((await ledger(f)).dirty, true);
});
