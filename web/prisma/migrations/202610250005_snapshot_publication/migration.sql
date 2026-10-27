ALTER TABLE "Shop" ADD COLUMN "activeSnapshotId" TEXT;
ALTER TABLE "CatalogChange" ADD COLUMN "waitingForSnapshot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SnapshotRun"
  ADD COLUMN "generation" TEXT,
  ADD COLUMN "expectedProducts" INTEGER,
  ADD COLUMN "importedProducts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_product_counts"
  CHECK ("importedProducts" >= 0 AND ("expectedProducts" IS NULL OR
    ("expectedProducts" >= 0 AND "importedProducts" <= "expectedProducts")));
CREATE TABLE "SnapshotProduct" (
  "runId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  CONSTRAINT "SnapshotProduct_pkey" PRIMARY KEY ("runId", "productId"),
  CONSTRAINT "SnapshotProduct_runId_fkey" FOREIGN KEY ("runId")
    REFERENCES "SnapshotRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
