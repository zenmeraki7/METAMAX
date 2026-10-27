-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Shop" (
    "domain" TEXT NOT NULL,
    "activeRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "revision" BIGINT,
    "status" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogChange" (
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "appliedRevision" BIGINT NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "deadLetterAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogChange_pkey" PRIMARY KEY ("shop","productId")
);

-- CreateTable
CREATE TABLE "ProductMirror" (
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "revision" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMirror_pkey" PRIMARY KEY ("shop","productId")
);

-- CreateTable
CREATE TABLE "SnapshotRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INGESTING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SnapshotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotChange" (
    "runId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "dirty" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SnapshotChange_pkey" PRIMARY KEY ("runId","productId")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_resourceId_revision_idx" ON "WebhookEvent"("shop", "resourceId", "revision");

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_id_idx" ON "WebhookEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "CatalogChange_dirty_deadLetterAt_nextAttemptAt_shop_product_idx" ON "CatalogChange"("dirty", "deadLetterAt", "nextAttemptAt", "shop", "productId");

-- CreateIndex
CREATE INDEX "SnapshotRun_status_completedAt_id_idx" ON "SnapshotRun"("status", "completedAt", "id");

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogChange" ADD CONSTRAINT "CatalogChange_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMirror" ADD CONSTRAINT "ProductMirror_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotChange" ADD CONSTRAINT "SnapshotChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SnapshotRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogChange" ADD CONSTRAINT "CatalogChange_valid_revisions"
CHECK ("revision" > 0 AND "appliedRevision" >= 0 AND "appliedRevision" <= "revision" AND "attempts" >= 0);

-- Register existing installations without copying session tokens into app data.
DO $$ BEGIN
  IF to_regclass('public.shopify_sessions') IS NOT NULL THEN
    INSERT INTO "Shop" ("domain", "updatedAt")
    SELECT DISTINCT "shop", CURRENT_TIMESTAMP FROM "shopify_sessions"
    WHERE "shop" ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'
    ON CONFLICT ("domain") DO NOTHING;
  END IF;
END $$;
