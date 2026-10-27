-- CreateEnum
CREATE TYPE "CatalogRepairKind" AS ENUM ('PRODUCT', 'VARIANT', 'FULL');

-- CreateTable
CREATE TABLE "CatalogRepair" (
    "shop" TEXT NOT NULL,
    "kind" "CatalogRepairKind" NOT NULL,
    "coveredThrough" TIMESTAMP(3),
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "afterCursor" TEXT,
    "pagesInWindow" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "CatalogRepair_pkey" PRIMARY KEY ("shop","kind"),
    CONSTRAINT "CatalogRepair_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CatalogRepair_nextCheckAt_leasedUntil_idx" ON "CatalogRepair"("nextCheckAt", "leasedUntil");

-- Backfill existing installed shops with independent repair cursors
INSERT INTO "CatalogRepair" ("shop", "kind")
SELECT s."domain", k."kind"::"CatalogRepairKind"
FROM "Shop" s
CROSS JOIN (VALUES ('PRODUCT'), ('VARIANT'), ('FULL')) AS k("kind")
WHERE s."status" = 'ACTIVE'
ON CONFLICT ("shop", "kind") DO NOTHING;
