import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prisma } from "../../db/client.js";
import { publishRun } from "../sync/sync.repository.js";
import { mapCurrentProduct } from "../products/products.mapper.js";
import { replaceVariantProjections } from "../products/products.projection.js";
import { assertSnapshotDatasets } from "../inventory/inventory.contract.js";
import { syncTransaction, syncError } from "../sync/sync.lease.js";

function identity(shop, generation) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shop || "") ||
    typeof generation !== "string" ||
    !generation
  )
    throw TypeError("Canonical shop and installation generation required");
}
async function lockedShop(tx, shop, generation, exclusive = false) {
  const rows = exclusive
    ? await tx.$queryRaw`SELECT "status", "generation", "activeRunId", "activeSnapshotId" FROM "Shop" WHERE "domain"=${shop} FOR UPDATE`
    : await tx.$queryRaw`SELECT "status", "generation", "activeRunId", "activeSnapshotId" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
  if (rows[0]?.status !== "ACTIVE" || rows[0].generation !== generation)
    throw Error("Installation changed or is inactive");
  return rows[0];
}
async function lockedRun(tx, shop, generation, runId) {
  const rows =
    await tx.$queryRaw`SELECT * FROM "SnapshotRun" WHERE "id"=${runId} AND "shop"=${shop} FOR UPDATE`;
  if (!rows[0] || rows[0].generation !== generation)
    throw Error("Snapshot does not belong to this installation");
  return rows[0];
}
const transaction = syncTransaction;

// Trusted importer contract: start before collecting the authoritative catalog.
// expectedProducts comes from its complete export manifest, not lines merely read.
export async function startCatalogSnapshot({
  shop,
  generation,
  expectedProducts,
  runId = randomUUID(),
}) {
  identity(shop, generation);
  if (
    !Number.isSafeInteger(expectedProducts) ||
    expectedProducts < 0 ||
    expectedProducts > 2147483647
  )
    throw TypeError("An exact nonnegative expectedProducts count is required");
  return transaction(async (tx) => {
    const merchant = await lockedShop(tx, shop, generation, true);
    const existing = await tx.snapshotRun.findUnique({ where: { id: runId } });
    if (existing) {
      if (
        existing.shop !== shop ||
        existing.generation !== generation ||
        existing.expectedProducts !== expectedProducts
      )
        throw Error("Snapshot identifier was reused with different input");
      return existing;
    }
    if (merchant.activeRunId)
      throw Error("Another catalog import is in progress");
    const run = await tx.snapshotRun.create({
      data: { id: runId, shop, generation, expectedProducts },
    });
    await tx.shop.update({
      where: { domain: shop },
      data: { activeRunId: runId },
    });
    await tx.catalogSyncState.upsert({
      where: { shop },
      create: { shop, generation, status: "INGESTING" },
      update: { generation, status: "INGESTING" },
    });
    // Previously pending work must be revisited even if it completed while this
    // export was running. Later webhooks are captured by the existing receiver.
    await tx.$executeRaw`INSERT INTO "SnapshotChange" ("runId","productId","revision","dirty")
      SELECT ${runId},"productId","revision",true FROM "CatalogChange" WHERE "shop"=${shop} AND "dirty"
      ON CONFLICT ("runId","productId") DO NOTHING`;
    await tx.$executeRaw`INSERT INTO "SnapshotInventoryChange" ("runId","inventoryItemId","revision","dirty")
      SELECT ${runId},"inventoryItemId","revision",true FROM "InventoryChange" WHERE "shop"=${shop} AND "dirty"
      ON CONFLICT ("runId","inventoryItemId") DO NOTHING`;
    return run;
  });
}

export async function stageSnapshotProducts({
  shop,
  generation,
  runId,
  products,
  leaseToken,
}) {
  identity(shop, generation);
  if (!Array.isArray(products) || !products.length || products.length > 100)
    throw TypeError("Provide between 1 and 100 complete product envelopes");
  const ids = new Set();
  const data = products.map((current) => {
    const productId = current?.product?.id;
    if (ids.has(productId)) throw Error("Repeated product in snapshot batch");
    ids.add(productId);
    return { runId, productId, data: mapCurrentProduct(productId, current) };
  });
  return transaction(async (tx) => {
    const merchant = await lockedShop(tx, shop, generation);
    const run = await lockedRun(tx, shop, generation, runId);
    if (leaseToken !== undefined) {
      const [{ owned }] =
        await tx.$queryRaw`SELECT EXISTS (SELECT 1 FROM "SnapshotRun"
        WHERE "id"=${runId} AND "leaseToken"=${leaseToken} AND "leasedUntil">clock_timestamp()) AS owned`;
      if (!owned) throw syncError("SYNC_LEASE_LOST", "Import lease expired");
    }
    if (merchant.activeRunId !== runId || run.status !== "INGESTING")
      throw Error("Snapshot ingestion is closed");
    const existing = await tx.snapshotProduct.findMany({
      where: { runId, productId: { in: [...ids] } },
    });
    for (const row of existing) {
      if (
        !isDeepStrictEqual(
          row.data,
          data.find((item) => item.productId === row.productId).data,
        )
      )
        throw Error("A staged product was retried with different data");
    }
    const inserted = await tx.snapshotProduct.createMany({
      data,
      skipDuplicates: true,
    });
    await replaceVariantProjections(tx, shop, runId, data);
    if (run.importedProducts + inserted.count > run.expectedProducts)
      throw Error("Snapshot exceeds manifest count");
    return tx.snapshotRun.update({
      where: { id: runId },
      data: { importedProducts: { increment: inserted.count } },
    });
  });
}

export async function sealCatalogSnapshot({
  shop,
  generation,
  runId,
  leaseToken,
  committedProducts,
}) {
  identity(shop, generation);
  return transaction(async (tx) => {
    const merchant = await lockedShop(tx, shop, generation);
    const run = await lockedRun(tx, shop, generation, runId);
    if (
      merchant.activeRunId !== runId ||
      !["INGESTING", "RECONCILING"].includes(run.status)
    )
      throw Error("Snapshot cannot be sealed");
    if (
      committedProducts !== undefined &&
      BigInt(run.importedProducts) !== BigInt(committedProducts)
    )
      throw syncError(
        "INGESTION_FINALIZATION_FAILED",
        "Committed ingestion progress does not match",
      );
    if (leaseToken !== undefined) {
      const [{ owned }] =
        await tx.$queryRaw`SELECT EXISTS (SELECT 1 FROM "SnapshotRun"
        WHERE "id"=${runId} AND "shop"=${shop} AND "leaseToken"=${leaseToken}
          AND "leasedUntil">clock_timestamp() AND "generation"=${generation}) AS owned`;
      if (!owned)
        throw syncError(
          "INGESTION_FINALIZATION_FAILED",
          "Import ownership changed or expired",
        );
    }
    if (run.status === "RECONCILING") return run;
    const count = await tx.snapshotProduct.count({ where: { runId } });
    await assertSnapshotDatasets(tx, shop, runId);
    if (
      run.expectedProducts === null ||
      count !== run.expectedProducts ||
      count !== run.importedProducts
    )
      throw Error("Snapshot ingestion is incomplete");
    return tx.snapshotRun.update({
      where: { id: runId },
      data: { status: "RECONCILING" },
    });
  });
}

export async function publishCatalogSnapshot(
  { shop, generation, runId, leaseToken },
  { wake } = {},
) {
  identity(shop, generation);
  const run = await prisma.snapshotRun.findUnique({ where: { id: runId } });
  if (!run || run.shop !== shop || run.generation !== generation)
    throw syncError(
      "SYNC_RUN_NOT_ACTIVE",
      "Installation changed or snapshot belongs to another shop",
    );
  if (run.status === "COMPLETED") {
    // Replay may observe a later published snapshot but must never reactivate this one.
    const merchant = await prisma.shop.findUnique({ where: { domain: shop } });
    if (merchant?.status !== "ACTIVE" || merchant.generation !== generation)
      throw syncError("SYNC_RUN_NOT_ACTIVE", "Installation changed");
    return { status: "already_published", snapshotId: runId };
  }
  if (run.status !== "RECONCILING")
    throw Error("Snapshot is not ready for publication");
  const published = await publishRun(
    { id: runId, shop, generation },
    leaseToken,
    run.expectedProducts,
  );
  const result = { status: "published", snapshotId: published.snapshotId };
  // Committed nextAttemptAt is sufficient if Redis is unavailable or we crash.
  try {
    await (
      wake ||
      (async () =>
        Promise.all([
          (
            await import("../../workers/reconcile.scanner.js")
          ).scanDirtyChanges(),
          (
            await import("../../workers/reconcile.scanner.js")
          ).scanDirtyInventoryChanges(),
        ]))
    )();
  } catch (error) {
    console.error(
      "[snapshot] Queue wake failed; scanner will recover:",
      error.message,
    );
  }
  return result;
}

export async function cancelCatalogSnapshot({ shop, generation, runId }) {
  identity(shop, generation);
  return transaction(async (tx) => {
    const merchant = await lockedShop(tx, shop, generation, true);
    const run = await lockedRun(tx, shop, generation, runId);
    if (merchant.activeRunId !== runId || run.status === "COMPLETED")
      throw Error("Snapshot is not an active import");
    await tx.shop.update({
      where: { domain: shop },
      data: { activeRunId: null },
    });
    await tx.snapshotChange.updateMany({
      where: { runId },
      data: { dirty: false },
    });
    await tx.snapshotInventoryChange.updateMany({
      where: { runId },
      data: { dirty: false },
    });
    await tx.catalogSyncState.update({
      where: { shop },
      data: { status: merchant.activeSnapshotId ? "READY" : "NOT_STARTED" },
    });
    return tx.snapshotRun.update({
      where: { id: runId },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        leaseToken: null,
        leasedUntil: null,
      },
    });
  });
}
