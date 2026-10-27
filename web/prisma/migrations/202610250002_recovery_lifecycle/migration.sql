-- Backfill only the new fencing token. Existing installation dates are preserved.
ALTER TABLE "Shop" ADD COLUMN "generation" TEXT;
UPDATE "Shop" SET "generation" = md5(random()::text || clock_timestamp()::text);
ALTER TABLE "Shop" ALTER COLUMN "generation" SET NOT NULL;
ALTER TABLE "Shop" ADD COLUMN "installationVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CatalogChange" ADD COLUMN "manualRetryAt" TIMESTAMP(3);

CREATE TABLE "LifecycleReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopHash" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LifecycleReceipt_shopHash_createdAt_idx" ON "LifecycleReceipt"("shopHash", "createdAt");
