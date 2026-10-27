CREATE TABLE "CatalogSyncState" (
  "shop" TEXT NOT NULL PRIMARY KEY,
  "generation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogSyncState_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "InstallationState" (
  "shopHash" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "authenticatedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "InstallationState_status_updatedAt_idx" ON "InstallationState"("status", "updatedAt");

INSERT INTO "CatalogSyncState" ("shop", "generation", "updatedAt")
SELECT "domain", "generation", CURRENT_TIMESTAMP FROM "Shop" WHERE "status"='ACTIVE';

INSERT INTO "InstallationState" ("shopHash", "status", "generation", "authenticatedAt", "updatedAt")
SELECT encode(sha256(convert_to("domain", 'UTF8')), 'hex'), "status", "generation", "installedAt", CURRENT_TIMESTAMP FROM "Shop";

-- Preserve terminal confirmations for tenants already removed by shop/redact.
INSERT INTO "InstallationState" ("shopHash", "status", "generation", "updatedAt")
SELECT DISTINCT ON ("shopHash") "shopHash",
  CASE WHEN "outcome"='SHOP_REDACTED' THEN 'REDACTED' ELSE 'UNINSTALLED' END,
  md5("id"), "createdAt"
FROM "LifecycleReceipt" WHERE "outcome" IN ('SHOP_REDACTED','SHOP_DATA_DELETED_WORKERS_FENCED')
ORDER BY "shopHash", "createdAt" DESC
ON CONFLICT ("shopHash") DO NOTHING;
