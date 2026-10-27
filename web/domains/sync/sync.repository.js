import { syncTransaction, validateRun, validateToken } from "./sync.lease.js";
import { assertSnapshotDatasets } from "../inventory/inventory.contract.js";

/**
 * Active run states.
 */
export const ACTIVE = [
  "PENDING",
  "STARTING",
  "WAITING",
  "INGESTING",
  "RECONCILING",
];

export function publishError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Publish only durable, fully reconciled staging. No catalog rows are copied. */
export async function publishRun(run, token, expectedLines) {
  validateRun(run);
  validateToken(token);
  if (
    !(
      (typeof expectedLines === "number" &&
        Number.isSafeInteger(expectedLines) &&
        expectedLines >= 0) ||
      (typeof expectedLines === "bigint" && expectedLines >= 0n)
    )
  )
    throw TypeError(
      "expectedLines must be a nonnegative safe integer or bigint"
    );
  const expected = BigInt(expectedLines);
  return syncTransaction(
    async (tx) => {
      const shops =
        await tx.$queryRaw`SELECT "activeRunId", "generation", "status" FROM "Shop"
      WHERE "domain"=${run.shop} FOR UPDATE`;
      const merchant = shops[0];
      if (
        merchant?.status !== "ACTIVE" ||
        merchant.activeRunId !== run.id ||
        (run.generation !== undefined && run.generation !== merchant.generation)
      )
        throw publishError(
          "SYNC_RUN_NOT_ACTIVE",
          "Shop staging ownership or installation changed"
        );
      const runs =
        await tx.$queryRaw`SELECT * FROM "SnapshotRun" WHERE "id"=${run.id} AND "shop"=${run.shop} FOR UPDATE`;
      const stored = runs[0];
      const [pending] =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS count FROM "SnapshotChange" sc
      LEFT JOIN "CatalogChange" c ON c."shop"=${run.shop} AND c."productId"=sc."productId"
      WHERE sc."runId"=${run.id} AND (sc."dirty" OR sc."appliedRevision"<>sc."revision"
        OR c."productId" IS NULL OR c."revision"<>sc."revision")`;
      if (pending.count !== 0n)
        throw publishError(
          "SNAPSHOT_CHANGES_PENDING",
          `Cannot publish with ${pending.count} outstanding staged changes`
        );
      const [inventoryPending] =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS count FROM "SnapshotInventoryChange" sc
        LEFT JOIN "InventoryChange" c ON c."shop"=${run.shop} AND c."inventoryItemId"=sc."inventoryItemId"
        WHERE sc."runId"=${run.id} AND (sc."dirty" OR sc."appliedRevision"<>sc."revision"
          OR c."inventoryItemId" IS NULL OR c."revision"<>sc."revision")`;
      if (inventoryPending.count !== 0n)
        throw publishError(
          "SNAPSHOT_CHANGES_PENDING",
          "Inventory changes remain in staging"
        );
      await assertSnapshotDatasets(tx, run.shop, run.id);
      // This schema counts durable complete product envelopes, not raw JSONL
      // variant lines. Keep bigint comparisons exact before sending any SQL.
      if (
        !stored ||
        stored.expectedProducts === null ||
        BigInt(stored.expectedProducts) !== expected ||
        BigInt(stored.importedProducts) !== expected
      )
        throw publishError(
          "SYNC_PUBLICATION_FENCE_FAILED",
          "Cannot publish an incompletely ingested run"
        );
      const completed =
        await tx.$executeRaw`UPDATE "SnapshotRun" SET "status"='COMPLETED',
      "completedAt"=clock_timestamp(), "leaseToken"=NULL, "leasedUntil"=NULL
      WHERE "id"=${run.id} AND "shop"=${run.shop} AND "generation"=${merchant.generation}
        AND "status"='RECONCILING' AND "leaseToken"=${token} AND "leasedUntil">clock_timestamp()
        AND "importedProducts"=${expected} AND "expectedProducts"=${expected}`;
      if (completed !== 1)
        throw publishError(
          "SYNC_PUBLICATION_FENCE_FAILED",
          "Cannot publish an unowned or incompletely ingested run"
        );
      await tx.$executeRaw`UPDATE "CatalogChange" c SET "appliedRevision"=sc."appliedRevision", "dirty"=false,
      "nextAttemptAt"=NULL,"lastError"=NULL,"attempts"=0,"deadLetterAt"=NULL,
      "waitingForSnapshot"=false,"leaseToken"=NULL,"leasedUntil"=NULL,"updatedAt"=clock_timestamp()
      FROM "SnapshotChange" sc WHERE sc."runId"=${run.id} AND c."shop"=${run.shop}
        AND c."productId"=sc."productId" AND c."revision"=sc."revision"
        AND sc."appliedRevision"=sc."revision" AND NOT sc."dirty"`;
      await tx.$executeRaw`UPDATE "InventoryChange" c SET "appliedRevision"=sc."appliedRevision", "dirty"=false,
        "lastError"=NULL,"attempts"=0,"deadLetterAt"=NULL,"waitingForSnapshot"=false,
        "leaseToken"=NULL,"leasedUntil"=NULL,"updatedAt"=clock_timestamp()
        FROM "SnapshotInventoryChange" sc WHERE sc."runId"=${run.id} AND c."shop"=${run.shop}
        AND c."inventoryItemId"=sc."inventoryItemId" AND c."revision"=sc."revision"
        AND sc."appliedRevision"=sc."revision" AND NOT sc."dirty"`;
      const published = await tx.shop.updateMany({
        where: {
          domain: run.shop,
          activeRunId: run.id,
          generation: merchant.generation,
          status: "ACTIVE",
        },
        data: { activeSnapshotId: run.id, activeRunId: null },
      });
      if (published.count !== 1)
        throw publishError(
          "SYNC_PUBLICATION_CONFLICT",
          "Active snapshot update failed"
        );
      // READY and publication time live on CatalogSyncState and SnapshotRun in
      // this schema, rather than nonexistent Shop.syncStatus/lastSyncedAt fields.
      await tx.catalogSyncState.update({
        where: { shop: run.shop },
        data: { status: "READY", generation: merchant.generation },
      });
      return { published: true, snapshotId: run.id };
    },
    { maxWait: 10000, timeout: 30000, isolationLevel: "ReadCommitted" }
  );
}
