import { prisma } from "../db/client.js";

export async function runRetention({
  db = prisma,
  now = new Date(),
  receiptDays = 30,
  snapshotDays = 7,
  lifecycleDays = 90,
} = {}) {
  const receiptsBefore = new Date(now.getTime() - receiptDays * 86400000);
  const snapshotsBefore = new Date(now.getTime() - snapshotDays * 86400000);
  const lifecycleBefore = new Date(now.getTime() - lifecycleDays * 86400000);
  return db.$transaction(
    async (tx) => {
      // Snapshot publication must acquire FOR UPDATE on Shop. Hold its matching
      // SHARE barrier before choosing obsolete snapshots, so publication cannot
      // make a selected snapshot active between our check and deletion.
      const locked = await tx.$queryRaw`
    SELECT "domain" FROM "Shop" WHERE "domain" IN (
      SELECT s."shop" FROM "SnapshotRun" s WHERE s."completedAt" < ${snapshotsBefore}
      AND s."status" IN ('COMPLETED','FAILED','CANCELLED')
      AND NOT EXISTS (SELECT 1 FROM "Shop" t WHERE (t."activeRunId"=s."id" OR t."activeSnapshotId"=s."id"))
      AND NOT EXISTS (SELECT 1 FROM "SnapshotChange" c WHERE c."runId"=s."id" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "CatalogChange" c WHERE c."shop"=s."shop" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "InventoryChange" c WHERE c."shop"=s."shop" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "SnapshotInventoryChange" c WHERE c."runId"=s."id" AND c."dirty")
    ) ORDER BY "domain" LIMIT 100 FOR SHARE SKIP LOCKED
  `;
      const lockedDomains = locked.map((row) => row.domain);
      // Each operation is bounded to keep cleanup from monopolizing the database.
      // Concurrent cleanup processes safely skip each other's locked rows.
      const receipts = await tx.$executeRaw`
    WITH expired AS (
      SELECT w."id" FROM "WebhookEvent" w
      WHERE w."createdAt" < ${receiptsBefore} AND w."revision" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "CatalogChange" c WHERE c."shop"=w."shop" AND c."productId"=w."resourceId"
        AND NOT c."dirty" AND c."appliedRevision">=w."revision")
      AND NOT EXISTS (SELECT 1 FROM "SnapshotRun" s JOIN "SnapshotChange" sc ON sc."runId"=s."id"
        WHERE s."shop"=w."shop" AND sc."productId"=w."resourceId" AND sc."dirty")
      ORDER BY w."createdAt",w."id" LIMIT 500 FOR UPDATE OF w SKIP LOCKED
    ) DELETE FROM "WebhookEvent" WHERE "id" IN (SELECT "id" FROM expired)
  `;
      const inventoryReceipts = await tx.$executeRaw`
    WITH expired AS (
      SELECT w."id" FROM "WebhookEvent" w WHERE w."createdAt" < ${receiptsBefore} AND w."revision" IS NOT NULL
      AND w."topic" LIKE 'inventory_%'
      AND EXISTS (SELECT 1 FROM "InventoryChange" c WHERE c."shop"=w."shop" AND c."inventoryItemId"=w."resourceId" AND NOT c."dirty" AND c."appliedRevision">=w."revision")
      AND NOT EXISTS (SELECT 1 FROM "SnapshotRun" s JOIN "SnapshotInventoryChange" sc ON sc."runId"=s."id" WHERE s."shop"=w."shop" AND sc."inventoryItemId"=w."resourceId" AND sc."dirty")
      ORDER BY w."createdAt",w."id" LIMIT 500 FOR UPDATE OF w SKIP LOCKED
    ) DELETE FROM "WebhookEvent" WHERE "id" IN (SELECT "id" FROM expired)`;
      const snapshots = await tx.$executeRaw`
    WITH expired AS (
      SELECT s."id" FROM "SnapshotRun" s
      WHERE s."completedAt" < ${snapshotsBefore} AND s."status" IN ('COMPLETED','FAILED','CANCELLED')
      AND s."shop" = ANY(${lockedDomains}::text[])
      AND NOT EXISTS (SELECT 1 FROM "Shop" t WHERE (t."activeRunId"=s."id" OR t."activeSnapshotId"=s."id"))
      AND NOT EXISTS (SELECT 1 FROM "SnapshotChange" c WHERE c."runId"=s."id" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "CatalogChange" c WHERE c."shop"=s."shop" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "InventoryChange" c WHERE c."shop"=s."shop" AND c."dirty")
      AND NOT EXISTS (SELECT 1 FROM "SnapshotInventoryChange" c WHERE c."runId"=s."id" AND c."dirty")
      ORDER BY s."completedAt",s."id" LIMIT 100 FOR UPDATE OF s SKIP LOCKED
    ) DELETE FROM "SnapshotRun" WHERE "id" IN (SELECT "id" FROM expired)
  `;
      const lifecycle = await tx.$executeRaw`
    WITH expired AS (SELECT "id" FROM "LifecycleReceipt" WHERE "createdAt" < ${lifecycleBefore}
      ORDER BY "createdAt","id" LIMIT 500 FOR UPDATE SKIP LOCKED)
    DELETE FROM "LifecycleReceipt" WHERE "id" IN (SELECT "id" FROM expired)
  `;
      const installations = await tx.$executeRaw`
        WITH expired AS (
          SELECT i."shopHash" FROM "InstallationState" i
          WHERE i."status" IN ('UNINSTALLED','REDACTED') AND i."updatedAt" < ${lifecycleBefore}
          AND NOT EXISTS (SELECT 1 FROM "Shop" s WHERE encode(sha256(convert_to(s."domain",'UTF8')),'hex')=i."shopHash")
          ORDER BY i."updatedAt",i."shopHash" LIMIT 500 FOR UPDATE OF i SKIP LOCKED
        ) DELETE FROM "InstallationState" WHERE "shopHash" IN (SELECT "shopHash" FROM expired)
      `;
      return {
        receipts: receipts + inventoryReceipts,
        snapshots,
        lifecycle,
        installations,
      };
    },
    { timeout: 10000, maxWait: 1000 }
  );
}

export function startRetention({
  intervalMs = 3600000,
  run = runRetention,
} = {}) {
  let stopped = false,
    timer,
    pending;
  const tick = () => {
    pending = Promise.resolve()
      .then(run)
      .catch((error) =>
        console.error("[retention] Pass failed:", error.message)
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
