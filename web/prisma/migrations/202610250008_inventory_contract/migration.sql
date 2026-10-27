-- AlterTable
ALTER TABLE "CatalogSyncState" ADD COLUMN     "requiredDatasets" TEXT[] DEFAULT ARRAY['products', 'variants']::TEXT[];

-- CreateTable
CREATE TABLE "Variant" (
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryItemId" TEXT,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("shop","snapshotId","id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "sku" TEXT,
    "tracked" BOOLEAN NOT NULL,
    "requiresShipping" BOOLEAN NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("shop","snapshotId","id")
);

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "fulfillsOnlineOrders" BOOLEAN NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("shop","snapshotId","id")
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "shopifyLevelId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLevel_pkey" PRIMARY KEY ("shop","snapshotId","inventoryItemId","locationId")
);

-- CreateTable
CREATE TABLE "InventoryQuantity" (
    "shop" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryQuantity_pkey" PRIMARY KEY ("shop","snapshotId","inventoryItemId","locationId","name")
);

-- CreateTable
CREATE TABLE "SnapshotDataset" (
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expectedRecords" BIGINT NOT NULL,
    "importedRecords" BIGINT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SnapshotDataset_pkey" PRIMARY KEY ("runId","name")
);

-- CreateTable
CREATE TABLE "OperationalAlert" (
    "shop" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("shop","code")
);

-- CreateIndex
CREATE INDEX "Variant_shop_snapshotId_inventoryItemId_idx" ON "Variant"("shop", "snapshotId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "Variant_shop_snapshotId_productId_idx" ON "Variant"("shop", "snapshotId", "productId");

-- CreateIndex
CREATE INDEX "InventoryItem_shop_snapshotId_sku_idx" ON "InventoryItem"("shop", "snapshotId", "sku");

-- CreateIndex
CREATE INDEX "InventoryLevel_shop_snapshotId_locationId_idx" ON "InventoryLevel"("shop", "snapshotId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryQuantity_shop_snapshotId_locationId_name_idx" ON "InventoryQuantity"("shop", "snapshotId", "locationId", "name");

-- CreateIndex
CREATE INDEX "OperationalAlert_resolvedAt_lastSeenAt_idx" ON "OperationalAlert"("resolvedAt", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotRun_shop_id_key" ON "SnapshotRun"("shop", "id");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_shop_snapshotId_fkey" FOREIGN KEY ("shop", "snapshotId") REFERENCES "SnapshotRun"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_snapshotId_productId_fkey" FOREIGN KEY ("snapshotId", "productId") REFERENCES "SnapshotProduct"("runId", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_shop_snapshotId_fkey" FOREIGN KEY ("shop", "snapshotId") REFERENCES "SnapshotRun"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_shop_snapshotId_fkey" FOREIGN KEY ("shop", "snapshotId") REFERENCES "SnapshotRun"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_shop_snapshotId_inventoryItemId_fkey" FOREIGN KEY ("shop", "snapshotId", "inventoryItemId") REFERENCES "InventoryItem"("shop", "snapshotId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_shop_snapshotId_locationId_fkey" FOREIGN KEY ("shop", "snapshotId", "locationId") REFERENCES "InventoryLocation"("shop", "snapshotId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryQuantity" ADD CONSTRAINT "InventoryQuantity_shop_snapshotId_inventoryItemId_location_fkey" FOREIGN KEY ("shop", "snapshotId", "inventoryItemId", "locationId") REFERENCES "InventoryLevel"("shop", "snapshotId", "inventoryItemId", "locationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotDataset" ADD CONSTRAINT "SnapshotDataset_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SnapshotRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalAlert" ADD CONSTRAINT "OperationalAlert_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- Build the searchable reference from existing canonical JSON. Keep inventory
-- references nonunique and allow inventory and product datasets to load separately.
INSERT INTO "Variant" ("shop", "snapshotId", "id", "productId", "inventoryItemId")
SELECT r."shop", p."runId", v->>'id', p."productId",
       COALESCE(v->>'inventoryItemId', v#>>'{inventoryItem,id}')
FROM "SnapshotProduct" p JOIN "SnapshotRun" r ON r."id"=p."runId"
CROSS JOIN LATERAL jsonb_array_elements(p."data"->'variants') v;
