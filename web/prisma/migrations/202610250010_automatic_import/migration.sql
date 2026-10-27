ALTER TABLE "SnapshotRun"
  ADD COLUMN "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "exportName" TEXT NOT NULL DEFAULT 'products',
  ADD COLUMN "bulkOperationId" TEXT,
  ADD COLUMN "exportManifest" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX "SnapshotRun_status_nextCheckAt_leasedUntil_idx"
  ON "SnapshotRun"("status", "nextCheckAt", "leasedUntil");
