-- CreateTable
CREATE TABLE "InventoryChange" (
    "shop" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "appliedRevision" BIGINT NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deadLetterAt" TIMESTAMP(3),
    "manualRetryAt" TIMESTAMP(3),
    "waitingForSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryChange_pkey" PRIMARY KEY ("shop","inventoryItemId")
);

-- CreateTable
CREATE TABLE "SnapshotInventoryChange" (
    "runId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "appliedRevision" BIGINT NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SnapshotInventoryChange_pkey" PRIMARY KEY ("runId","inventoryItemId")
);

-- CreateIndex
CREATE INDEX "InventoryChange_dirty_nextAttemptAt_leasedUntil_idx" ON "InventoryChange"("dirty", "nextAttemptAt", "leasedUntil");

-- CreateIndex
CREATE INDEX "InventoryChange_shop_dirty_deadLetterAt_nextAttemptAt_idx" ON "InventoryChange"("shop", "dirty", "deadLetterAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SnapshotInventoryChange_runId_dirty_inventoryItemId_idx" ON "SnapshotInventoryChange"("runId", "dirty", "inventoryItemId");

-- AddForeignKey
ALTER TABLE "InventoryChange" ADD CONSTRAINT "InventoryChange_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotInventoryChange" ADD CONSTRAINT "SnapshotInventoryChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SnapshotRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
