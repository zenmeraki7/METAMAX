BEGIN;
-- Harden existing mirror tables. No parallel mirror_* schema or data copy.
-- Fail on incompatible published data instead of guessing installation ownership.
CREATE UNIQUE INDEX "SnapshotRun_shop_generation_id_key" ON "SnapshotRun"("shop", "generation", "id");
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_published_snapshot_fkey"
  FOREIGN KEY ("domain", "generation", "activeSnapshotId")
  REFERENCES "SnapshotRun"("shop", "generation", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "SnapshotDataset" ADD CONSTRAINT "SnapshotDataset_verified_counts_check"
  CHECK ("expectedRecords" >= 0 AND "importedRecords" = "expectedRecords");
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_counts_check"
  CHECK ("importedProducts" >= 0 AND ("expectedProducts" IS NULL OR "expectedProducts" >= 0));

CREATE TABLE "SnapshotRetentionPin" (
  "shop" TEXT NOT NULL, "snapshotId" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('SELECTION','EXPORT','EXECUTION','READ')),
  "ownerId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("shop", "snapshotId", "kind", "ownerId"),
  FOREIGN KEY ("shop", "snapshotId") REFERENCES "SnapshotRun"("shop", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE "BulkQueryClaim" (
  "appId" TEXT NOT NULL, "shop" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
  "generation" TEXT NOT NULL, "consumer" TEXT NOT NULL,
  "slot" INTEGER, "state" TEXT NOT NULL DEFAULT 'RESERVED', "operationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("appId", "shop", "requestKey"),
  CHECK (("state" IN ('RESERVED','ACTIVE','UNKNOWN') AND "slot" BETWEEN 0 AND 4 AND "slot" IS NOT NULL)
    OR ("state" IN ('RELEASED','REJECTED') AND "slot" IS NULL)),
  CHECK ("state" <> 'ACTIVE' OR "operationId" IS NOT NULL)
);
CREATE UNIQUE INDEX "BulkQueryClaim_appId_shop_slot_key" ON "BulkQueryClaim"("appId", "shop", "slot");
CREATE UNIQUE INDEX "BulkQueryClaim_appId_shop_operationId_key" ON "BulkQueryClaim"("appId", "shop", "operationId");

COMMIT;
