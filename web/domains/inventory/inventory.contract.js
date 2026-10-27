import { prisma } from "../../db/client.js";
import { syncTransaction, syncError } from "../sync/sync.lease.js";
import { writeInventoryItemSnapshot } from "./inventory.service.js";
import { writeInventorySnapshotBatch } from "./inventory.batch.js";

export const INVENTORY_DATASETS = Object.freeze({
  inventory_items: "inventoryItem",
  inventory_locations: "inventoryLocation",
  inventory_levels: "inventoryLevel",
  inventory_quantities: "inventoryQuantity",
});
export async function enableInventoryContract(tx, shop) {
  const merchant = await tx.shop.findUnique({
    where: { domain: shop },
    select: { generation: true },
  });
  const state = await tx.catalogSyncState.findUnique({ where: { shop } });
  const requiredDatasets = [
    ...new Set([
      ...(state?.requiredDatasets ?? ["products", "variants"]),
      ...Object.keys(INVENTORY_DATASETS),
    ]),
  ];
  await tx.catalogSyncState.upsert({
    where: { shop },
    create: { shop, generation: merchant.generation, requiredDatasets },
    update: { requiredDatasets },
  });
}
export async function assertSnapshotDatasets(tx, shop, runId) {
  const state = await tx.catalogSyncState.findUnique({ where: { shop } });
  const names = (state?.requiredDatasets ?? []).filter(
    (name) => !["products", "variants"].includes(name),
  );
  if (!names.length) return;
  const records = await tx.snapshotDataset.findMany({
    where: { runId, name: { in: names } },
  });
  for (const name of names) {
    const record = records.find((row) => row.name === name);
    if (
      !Object.hasOwn(INVENTORY_DATASETS, name) ||
      !record ||
      record.expectedRecords !== record.importedRecords
    )
      throw syncError(
        "SNAPSHOT_DATASET_INCOMPLETE",
        `A verified ${name} baseline is required before publication`,
      );
  }
}
async function lockIngestion(tx, { shop, generation, runId, leaseToken }) {
  const [merchant] =
    await tx.$queryRaw`SELECT "status","generation","activeRunId" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
  const [run] =
    await tx.$queryRaw`SELECT "status","generation","shop" FROM "SnapshotRun" WHERE "id"=${runId} FOR UPDATE`;
  if (
    merchant?.status !== "ACTIVE" ||
    merchant.generation !== generation ||
    merchant.activeRunId !== runId ||
    run?.shop !== shop ||
    run.generation !== generation ||
    run.status !== "INGESTING"
  )
    throw syncError(
      "SYNC_RUN_NOT_ACTIVE",
      "Inventory ingestion is closed or installation changed",
    );
  if (leaseToken !== undefined) {
    const [{ owned }] =
      await tx.$queryRaw`SELECT EXISTS (SELECT 1 FROM "SnapshotRun"
      WHERE "id"=${runId} AND "leaseToken"=${leaseToken} AND "leasedUntil">clock_timestamp()) AS owned`;
    if (!owned)
      throw syncError("SYNC_LEASE_LOST", "Inventory import lease expired");
  }
}
// Trusted full-catalog importer only. An event stream is not a complete baseline.
export async function stageSnapshotInventoryItem(args) {
  return syncTransaction(async (tx) => {
    await lockIngestion(tx, args);
    if (
      await tx.snapshotDataset.count({
        where: {
          runId: args.runId,
          name: { in: Object.keys(INVENTORY_DATASETS) },
        },
      })
    )
      throw syncError(
        "INVENTORY_INGESTION_SEALED",
        "Inventory baseline is already sealed",
      );
    await writeInventoryItemSnapshot(
      tx,
      args.shop,
      args.runId,
      args.inventoryItemId,
      args.current,
    );
    await enableInventoryContract(tx, args.shop);
  });
}

export async function stageSnapshotInventoryItems({ observations, ...args }) {
  if (
    !Array.isArray(observations) ||
    !observations.length ||
    observations.length > 100
  )
    throw new TypeError("Provide between 1 and 100 inventory observations");
  return syncTransaction(async (tx) => {
    await lockIngestion(tx, args);
    if (
      await tx.snapshotDataset.count({
        where: {
          runId: args.runId,
          name: { in: Object.keys(INVENTORY_DATASETS) },
        },
      })
    )
      throw syncError(
        "INVENTORY_INGESTION_SEALED",
        "Inventory baseline is already sealed",
      );
    await writeInventorySnapshotBatch(tx, args.shop, args.runId, observations);
    await enableInventoryContract(tx, args.shop);
  });
}
export async function sealSnapshotInventory({ expectedRecords, ...args }) {
  if (
    !expectedRecords ||
    Object.keys(expectedRecords).length !== 4 ||
    Object.keys(INVENTORY_DATASETS).some(
      (name) =>
        !(
          (typeof expectedRecords[name] === "bigint" &&
            expectedRecords[name] >= 0n &&
            expectedRecords[name] <= 9223372036854775807n) ||
          (Number.isSafeInteger(expectedRecords[name]) &&
            expectedRecords[name] >= 0)
        ),
    )
  )
    throw TypeError(
      "Provide exact counts for all four inventory datasets from the complete export manifest",
    );
  return syncTransaction(async (tx) => {
    await lockIngestion(tx, args);
    for (const [name, model] of Object.entries(INVENTORY_DATASETS)) {
      const count = BigInt(
        await tx[model].count({
          where: { shop: args.shop, snapshotId: args.runId },
        }),
      );
      if (count !== BigInt(expectedRecords[name]))
        throw syncError(
          "INCOMPLETE_INVENTORY_INGESTION",
          `Durable ${name} count does not match export manifest`,
        );
      await tx.snapshotDataset.upsert({
        where: { runId_name: { runId: args.runId, name } },
        create: {
          runId: args.runId,
          name,
          expectedRecords: count,
          importedRecords: count,
        },
        update: { expectedRecords: count, importedRecords: count },
      });
    }
    await enableInventoryContract(tx, args.shop);
  });
}
