ALTER TABLE "SnapshotRun" ADD COLUMN "leaseToken" TEXT, ADD COLUMN "leasedUntil" TIMESTAMP(3);
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_lease_pair"
  CHECK (("leaseToken" IS NULL) = ("leasedUntil" IS NULL));
ALTER TABLE "SnapshotChange" ADD COLUMN "appliedRevision" BIGINT NOT NULL DEFAULT 0;
UPDATE "SnapshotChange" SET "appliedRevision"="revision" WHERE NOT "dirty";
CREATE INDEX "SnapshotChange_runId_dirty_productId_idx" ON "SnapshotChange"("runId","dirty","productId");
-- Previously sealed imports have durable ingestion counts and may now enter
-- the explicit reconciliation phase. Unsealed legacy runs stay unpublishable.
UPDATE "SnapshotRun" SET "status"='RECONCILING' WHERE "status"='READY_TO_PUBLISH'
  AND "generation" IS NOT NULL AND "expectedProducts"="importedProducts";
