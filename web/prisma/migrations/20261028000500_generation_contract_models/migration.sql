BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;
-- CreateTable
CREATE TABLE "mirror"."generation_read_leases" (
    "shop_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "coverage_revision" TEXT NOT NULL,
    "mapping_version" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_read_leases_pkey" PRIMARY KEY ("shop_id","id")
);

-- CreateTable
CREATE TABLE "mirror"."generation_product_revisions" (
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_product_revisions_pkey" PRIMARY KEY ("shop_id","generation_id","product_id")
);

-- CreateIndex
CREATE INDEX "generation_read_leases_shop_id_expires_at_idx" ON "mirror"."generation_read_leases"("shop_id", "expires_at");

-- CreateIndex
CREATE INDEX "generation_read_leases_shop_id_generation_id_expires_at_idx" ON "mirror"."generation_read_leases"("shop_id", "generation_id", "expires_at");

-- CreateIndex
CREATE INDEX "generation_read_leases_shop_id_operation_owner_idx" ON "mirror"."generation_read_leases"("shop_id", "operation", "owner");

-- AddForeignKey
ALTER TABLE "mirror"."generation_read_leases" ADD CONSTRAINT "generation_read_leases_shop_id_generation_id_coverage_revi_fkey" FOREIGN KEY ("shop_id", "generation_id", "coverage_revision", "mapping_version") REFERENCES "mirror"."generations"("shop_id", "id", "coverage_revision", "mapping_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mirror"."generation_product_revisions" ADD CONSTRAINT "generation_product_revisions_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."generation_product_revisions" ADD CONSTRAINT "generation_product_revisions_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "mirror"."catalog_changes"("shop_id", "product_id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
