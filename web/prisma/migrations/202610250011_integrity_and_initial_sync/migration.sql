-- =====================================================
-- METAMAX: Integrity and Initial Sync
-- Requires successful migrations 000-010
-- =====================================================

-- 1. Extend inventory repair capabilities.

ALTER TYPE "CatalogRepairKind"
  ADD VALUE IF NOT EXISTS 'INVENTORY_ITEM';

ALTER TYPE "CatalogRepairKind"
  ADD VALUE IF NOT EXISTS 'INVENTORY_LEVEL';


-- 2. Create durable initial sync requests.

CREATE TABLE "InitialSyncRequest" (
  "shop" TEXT NOT NULL,
  "generation" TEXT NOT NULL,

  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "snapshotId" TEXT,

  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextCheckAt" TIMESTAMP(3)
      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMP(3),

  "lastError" TEXT,

  "createdAt" TIMESTAMP(3)
      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3)
      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "InitialSyncRequest_pkey"
      PRIMARY KEY ("shop", "generation"),

  CONSTRAINT "InitialSyncRequest_shop_fkey"
      FOREIGN KEY ("shop")
      REFERENCES "Shop"("domain")
      ON DELETE CASCADE
      ON UPDATE CASCADE,

  CONSTRAINT "InitialSyncRequest_status_check"
      CHECK (
        "status" IN (
          'PENDING',
          'RUNNING',
          'COMPLETED',
          'FAILED',
          'CANCELLED'
        )
      ),

  CONSTRAINT "InitialSyncRequest_attempts_check"
      CHECK ("attempts" >= 0),

  CONSTRAINT "InitialSyncRequest_lease_check"
      CHECK (
        ("leaseToken" IS NULL)
        = ("leasedUntil" IS NULL)
      ),

  CONSTRAINT "InitialSyncRequest_completion_check"
      CHECK (
        "status" <> 'COMPLETED'
        OR "completedAt" IS NOT NULL
      )
);

CREATE INDEX "InitialSyncRequest_status_nextCheckAt_leasedUntil_idx"
ON "InitialSyncRequest" (
  "status",
  "nextCheckAt",
  "leasedUntil"
);


-- 3. Repair Prisma nullability drift.

UPDATE "CatalogSyncState"
SET "requiredDatasets" =
    ARRAY['products', 'variants']::TEXT[]
WHERE "requiredDatasets" IS NULL;

ALTER TABLE "CatalogSyncState"
  ALTER COLUMN "requiredDatasets" SET NOT NULL;


-- 4. Enforce inventory reconciliation invariants.

ALTER TABLE "InventoryChange"
ADD CONSTRAINT "InventoryChange_revision_check"
CHECK (
  "revision" > 0
  AND "appliedRevision" >= 0
  AND "appliedRevision" <= "revision"
  AND "attempts" >= 0
) NOT VALID;

ALTER TABLE "InventoryChange"
ADD CONSTRAINT "InventoryChange_lease_check"
CHECK (
  ("leaseToken" IS NULL)
  = ("leasedUntil" IS NULL)
) NOT VALID;


-- 5. Protect snapshot inventory revisions.

ALTER TABLE "SnapshotInventoryChange"
ADD CONSTRAINT "SnapshotInventoryChange_revision_check"
CHECK (
  "revision" > 0
  AND "appliedRevision" >= 0
  AND "appliedRevision" <= "revision"
) NOT VALID;


-- 6. Protect repair scheduling state.

ALTER TABLE "CatalogRepair"
ADD CONSTRAINT "CatalogRepair_lease_check"
CHECK (
  ("leaseToken" IS NULL)
  = ("leasedUntil" IS NULL)
) NOT VALID;

ALTER TABLE "CatalogRepair"
ADD CONSTRAINT "CatalogRepair_attempts_check"
CHECK (
  "attempts" >= 0
  AND "pagesInWindow" >= 0
) NOT VALID;


-- 7. Protect dataset counters.

ALTER TABLE "SnapshotDataset"
ADD CONSTRAINT "SnapshotDataset_counts_check"
CHECK (
  "expectedRecords" >= 0
  AND "importedRecords" >= 0
  AND "importedRecords" <= "expectedRecords"
) NOT VALID;


-- 8. Protect snapshot retry counters.

ALTER TABLE "SnapshotRun"
ADD CONSTRAINT "SnapshotRun_attempts_check"
CHECK ("attempts" >= 0) NOT VALID;


-- 9. Backfill initial requests for verified stores
-- whose initial sync has not started.

INSERT INTO "InitialSyncRequest" (
  "shop",
  "generation"
)
SELECT
  s."domain",
  s."generation"
FROM "Shop" s
JOIN "CatalogSyncState" c
  ON c."shop" = s."domain"
  AND c."generation" = s."generation"
JOIN "InstallationState" i
  ON i."shopHash" = encode(
    sha256(convert_to(s."domain", 'UTF8')),
    'hex'
  )
  AND i."generation" = s."generation"
WHERE
  s."status" = 'ACTIVE'
  AND s."installationVerified" = true
  AND i."status" = 'ACTIVE'
  AND c."status" = 'NOT_STARTED'
ON CONFLICT ("shop", "generation") DO NOTHING;

-- Inventory schedule backfill runs in migration 012 after enum values commit.
