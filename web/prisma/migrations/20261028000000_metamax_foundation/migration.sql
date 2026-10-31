-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "mirror";

-- CreateEnum
CREATE TYPE "mirror"."GenerationStatus" AS ENUM ('INGESTING', 'RECONCILING', 'VERIFIED', 'PUBLISHED', 'RETIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "mirror"."CoverageStatus" AS ENUM ('PENDING', 'INGESTING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "mirror"."WorkStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "mirror"."ApprovalStatus" AS ENUM ('DRAFT', 'APPROVED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "mirror"."OwnerEntity" AS ENUM ('product', 'variant');

-- CreateTable
CREATE TABLE "mirror"."shops" (
    "id" TEXT NOT NULL,
    "installed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMPTZ(3),
    "installation_version" TEXT NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."generations" (
    "shop_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "status" "mirror"."GenerationStatus" NOT NULL DEFAULT 'INGESTING',
    "coverage_revision" TEXT NOT NULL,
    "mirror_schema_version" TEXT NOT NULL,
    "source_contract_version" TEXT NOT NULL,
    "mapping_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "retain_until" TIMESTAMPTZ(3),
    "required_datasets" TEXT[] DEFAULT ARRAY['products', 'variants']::TEXT[],

    CONSTRAINT "generations_pkey" PRIMARY KEY ("shop_id","id")
);

-- CreateTable
CREATE TABLE "mirror"."publications" (
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "coverage_revision" TEXT NOT NULL,
    "mapping_version" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "mirror"."coverage" (
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "mirror"."CoverageStatus" NOT NULL DEFAULT 'PENDING',
    "durable_rows" BIGINT NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(3),
    "verification_hash" TEXT,

    CONSTRAINT "coverage_pkey" PRIMARY KEY ("shop_id","generation_id","name")
);

-- CreateTable
CREATE TABLE "mirror"."ingestion_runs" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "status" "mirror"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "bulk_operation_id" TEXT,
    "expected_lines" BIGINT,
    "processed_lines" BIGINT NOT NULL DEFAULT 0,
    "invalid_lines" BIGINT NOT NULL DEFAULT 0,
    "eof_verified" BOOLEAN NOT NULL DEFAULT false,
    "writes_finished_at" TIMESTAMPTZ(3),
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."ingestion_chunks" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "run_id" BIGINT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "line_count" BIGINT NOT NULL,
    "committed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."catalog_changes" (
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "applied_revision" BIGINT NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "dead_letter_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_changes_pkey" PRIMARY KEY ("shop_id","product_id")
);

-- CreateTable
CREATE TABLE "mirror"."webhook_receipts" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."products" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "description_html" TEXT,
    "vendor" TEXT,
    "product_type" TEXT,
    "status" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "template_suffix" TEXT,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "category_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "source_revision" BIGINT NOT NULL DEFAULT 0,
    "attributes" JSONB,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."variants" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "inventory_item_id" BIGINT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "price" DECIMAL NOT NULL,
    "compare_at_price" DECIMAL,
    "inventory_policy" TEXT NOT NULL,
    "inventory_quantity" BIGINT NOT NULL,
    "taxable" BOOLEAN NOT NULL,
    "requires_components" BOOLEAN NOT NULL,
    "position" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "source_revision" BIGINT NOT NULL DEFAULT 0,
    "attributes" JSONB,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."inventory_items" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "sku" TEXT,
    "tracked" BOOLEAN NOT NULL,
    "requires_shipping" BOOLEAN NOT NULL,
    "unit_cost" DECIMAL,
    "currency_code" TEXT,
    "country_code_of_origin" TEXT,
    "harmonized_system_code" TEXT,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."locations" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."inventory_levels" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "inventory_item_id" BIGINT NOT NULL,
    "location_id" BIGINT NOT NULL,
    "available" BIGINT NOT NULL,
    "on_hand" BIGINT NOT NULL,
    "committed" BIGINT NOT NULL,
    "incoming" BIGINT NOT NULL,

    CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."collections" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."product_collections" (
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "collection_id" BIGINT NOT NULL,

    CONSTRAINT "product_collections_pkey" PRIMARY KEY ("shop_id","generation_id","collection_id","product_id")
);

-- CreateTable
CREATE TABLE "mirror"."product_options" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "position" BIGINT NOT NULL,
    "values" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."categories" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."field_mappings" (
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "mapping_version" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "column_name" TEXT NOT NULL,
    "storage_type" TEXT NOT NULL,
    "definition_token" TEXT,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "field_mappings_pkey" PRIMARY KEY ("shop_id","generation_id","field_id")
);

-- CreateTable
CREATE TABLE "mirror"."metafield_definitions" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "shopify_definition_id" TEXT NOT NULL,
    "locator_id" TEXT NOT NULL,
    "owner_entity" "mirror"."OwnerEntity" NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "shopify_type" TEXT NOT NULL,
    "canonical_type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "definition_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "definition_verified" BOOLEAN NOT NULL DEFAULT false,
    "nullable" BOOLEAN NOT NULL DEFAULT true,
    "writable" BOOLEAN NOT NULL DEFAULT false,
    "mutation_supported" BOOLEAN NOT NULL DEFAULT false,
    "reader_adapter_id" TEXT,
    "writer_adapter_id" TEXT,
    "precision" INTEGER,
    "scale" INTEGER,
    "constraints" JSONB,
    "verified_at" TIMESTAMPTZ(3),
    "verification_expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "metafield_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."product_metafields" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "definition_id" BIGINT NOT NULL,
    "owner_entity" "mirror"."OwnerEntity" NOT NULL DEFAULT 'product',
    "definition_token" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "product_metafields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."variant_metafields" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "variant_id" BIGINT NOT NULL,
    "definition_id" BIGINT NOT NULL,
    "owner_entity" "mirror"."OwnerEntity" NOT NULL DEFAULT 'variant',
    "definition_token" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "variant_metafields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."saved_filters" (
    "shop_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ast_version" INTEGER NOT NULL,
    "ast" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("shop_id","id")
);

-- CreateTable
CREATE TABLE "mirror"."selection_snapshots" (
    "shop_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "coverage_revision" TEXT NOT NULL,
    "mapping_version" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "status" "mirror"."ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "filter_ast" JSONB NOT NULL,
    "filter_fingerprint" TEXT NOT NULL,
    "registry_version" TEXT NOT NULL,
    "definition_revisions" JSONB NOT NULL,
    "selected_count" BIGINT NOT NULL DEFAULT 0,
    "selection_hash" TEXT,
    "frozen_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "selection_snapshots_pkey" PRIMARY KEY ("shop_id","id")
);

-- CreateTable
CREATE TABLE "mirror"."selection_items" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "product_id" BIGINT NOT NULL,

    CONSTRAINT "selection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."execution_contracts" (
    "shop_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "approval_revision" TEXT NOT NULL,
    "status" "mirror"."ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "contract" JSONB NOT NULL,
    "contract_hash" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "execution_contracts_pkey" PRIMARY KEY ("shop_id","id")
);

-- CreateTable
CREATE TABLE "mirror"."job_commands" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "mirror"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancel_requested_at" TIMESTAMPTZ(3),
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,
    "checkpoint" JSONB,
    "result" JSONB,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."job_items" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "command_id" BIGINT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "status" "mirror"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "before_values" JSONB,
    "intended_values" JSONB NOT NULL,
    "observed_revision" BIGINT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,

    CONSTRAINT "job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "command_id" BIGINT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."job_schedules" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL,
    "recurrence" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "template" JSONB NOT NULL,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."job_artifacts" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "command_id" BIGINT NOT NULL,
    "object_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_length" BIGINT NOT NULL,
    "row_count" BIGINT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."audit_events" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "operation_id" TEXT,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "outcome" TEXT NOT NULL,
    "summary" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generations_shop_id_status_created_at_idx" ON "mirror"."generations"("shop_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "generations_shop_id_id_coverage_revision_mapping_version_key" ON "mirror"."generations"("shop_id", "id", "coverage_revision", "mapping_version");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_shop_id_id_key" ON "mirror"."ingestion_runs"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_shop_id_generation_id_dataset_key" ON "mirror"."ingestion_runs"("shop_id", "generation_id", "dataset");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_chunks_shop_id_run_id_ordinal_key" ON "mirror"."ingestion_chunks"("shop_id", "run_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_receipts_shop_id_event_id_key" ON "mirror"."webhook_receipts"("shop_id", "event_id");

-- CreateIndex
CREATE INDEX "products_shop_id_generation_id_status_id_idx" ON "mirror"."products"("shop_id", "generation_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_generation_id_shopify_id_key" ON "mirror"."products"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_shop_id_generation_id_id_key" ON "mirror"."products"("shop_id", "generation_id", "id");

-- CreateIndex
CREATE INDEX "variants_shop_id_generation_id_product_id_id_idx" ON "mirror"."variants"("shop_id", "generation_id", "product_id", "id");

-- CreateIndex
CREATE INDEX "variants_shop_id_generation_id_sku_product_id_idx" ON "mirror"."variants"("shop_id", "generation_id", "sku", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_shop_id_generation_id_shopify_id_key" ON "mirror"."variants"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_shop_id_generation_id_id_key" ON "mirror"."variants"("shop_id", "generation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_shop_id_generation_id_shopify_id_key" ON "mirror"."inventory_items"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_shop_id_generation_id_id_key" ON "mirror"."inventory_items"("shop_id", "generation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_shop_id_generation_id_shopify_id_key" ON "mirror"."locations"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_shop_id_generation_id_id_key" ON "mirror"."locations"("shop_id", "generation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_shop_id_generation_id_shopify_id_key" ON "mirror"."inventory_levels"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_shop_id_generation_id_inventory_item_id_lo_key" ON "mirror"."inventory_levels"("shop_id", "generation_id", "inventory_item_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "collections_shop_id_generation_id_shopify_id_key" ON "mirror"."collections"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "collections_shop_id_generation_id_id_key" ON "mirror"."collections"("shop_id", "generation_id", "id");

-- CreateIndex
CREATE INDEX "product_collections_shop_id_generation_id_product_id_idx" ON "mirror"."product_collections"("shop_id", "generation_id", "product_id");

-- CreateIndex
CREATE INDEX "product_options_shop_id_generation_id_product_id_position_idx" ON "mirror"."product_options"("shop_id", "generation_id", "product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_shop_id_generation_id_shopify_id_key" ON "mirror"."product_options"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_shop_id_generation_id_shopify_id_key" ON "mirror"."categories"("shop_id", "generation_id", "shopify_id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_definitions_shop_id_id_owner_entity_key" ON "mirror"."metafield_definitions"("shop_id", "id", "owner_entity");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_definitions_shop_id_field_id_key" ON "mirror"."metafield_definitions"("shop_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_definitions_shop_id_shopify_definition_id_key" ON "mirror"."metafield_definitions"("shop_id", "shopify_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_definitions_shop_id_locator_id_key" ON "mirror"."metafield_definitions"("shop_id", "locator_id");

-- CreateIndex
CREATE UNIQUE INDEX "metafield_definitions_shop_id_owner_entity_namespace_key_key" ON "mirror"."metafield_definitions"("shop_id", "owner_entity", "namespace", "key");

-- CreateIndex
CREATE UNIQUE INDEX "product_metafields_shop_id_generation_id_product_id_definit_key" ON "mirror"."product_metafields"("shop_id", "generation_id", "product_id", "definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_metafields_shop_id_generation_id_variant_id_definit_key" ON "mirror"."variant_metafields"("shop_id", "generation_id", "variant_id", "definition_id");

-- CreateIndex
CREATE INDEX "selection_snapshots_shop_id_expires_at_idx" ON "mirror"."selection_snapshots"("shop_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "selection_snapshots_shop_id_id_generation_id_key" ON "mirror"."selection_snapshots"("shop_id", "id", "generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "selection_items_shop_id_snapshot_id_product_id_key" ON "mirror"."selection_items"("shop_id", "snapshot_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_commands_shop_id_id_key" ON "mirror"."job_commands"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_commands_shop_id_idempotency_key_key" ON "mirror"."job_commands"("shop_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_items_shop_id_command_id_status_id_idx" ON "mirror"."job_items"("shop_id", "command_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "job_items_shop_id_command_id_resource_id_key" ON "mirror"."job_items"("shop_id", "command_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_shop_id_dedupe_key_key" ON "mirror"."outbox_events"("shop_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_schedules_shop_id_id_key" ON "mirror"."job_schedules"("shop_id", "id");

-- CreateIndex
CREATE INDEX "job_artifacts_shop_id_command_id_idx" ON "mirror"."job_artifacts"("shop_id", "command_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_artifacts_shop_id_object_key_key" ON "mirror"."job_artifacts"("shop_id", "object_key");

-- CreateIndex
CREATE INDEX "audit_events_shop_id_created_at_id_idx" ON "mirror"."audit_events"("shop_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "mirror"."generations" ADD CONSTRAINT "generations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."publications" ADD CONSTRAINT "publications_shop_id_generation_id_coverage_revision_mappi_fkey" FOREIGN KEY ("shop_id", "generation_id", "coverage_revision", "mapping_version") REFERENCES "mirror"."generations"("shop_id", "id", "coverage_revision", "mapping_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mirror"."coverage" ADD CONSTRAINT "coverage_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."ingestion_runs" ADD CONSTRAINT "ingestion_runs_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."ingestion_chunks" ADD CONSTRAINT "ingestion_chunks_shop_id_run_id_fkey" FOREIGN KEY ("shop_id", "run_id") REFERENCES "mirror"."ingestion_runs"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."catalog_changes" ADD CONSTRAINT "catalog_changes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."webhook_receipts" ADD CONSTRAINT "webhook_receipts_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."products" ADD CONSTRAINT "products_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."variants" ADD CONSTRAINT "variants_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."variants" ADD CONSTRAINT "variants_shop_id_generation_id_inventory_item_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "inventory_item_id") REFERENCES "mirror"."inventory_items"("shop_id", "generation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."inventory_items" ADD CONSTRAINT "inventory_items_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."locations" ADD CONSTRAINT "locations_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."inventory_levels" ADD CONSTRAINT "inventory_levels_shop_id_generation_id_inventory_item_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "inventory_item_id") REFERENCES "mirror"."inventory_items"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."inventory_levels" ADD CONSTRAINT "inventory_levels_shop_id_generation_id_location_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "location_id") REFERENCES "mirror"."locations"("shop_id", "generation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."collections" ADD CONSTRAINT "collections_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_collections" ADD CONSTRAINT "product_collections_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_collections" ADD CONSTRAINT "product_collections_shop_id_generation_id_collection_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "collection_id") REFERENCES "mirror"."collections"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_options" ADD CONSTRAINT "product_options_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."categories" ADD CONSTRAINT "categories_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."field_mappings" ADD CONSTRAINT "field_mappings_shop_id_generation_id_fkey" FOREIGN KEY ("shop_id", "generation_id") REFERENCES "mirror"."generations"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."metafield_definitions" ADD CONSTRAINT "metafield_definitions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_metafields" ADD CONSTRAINT "product_metafields_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_metafields" ADD CONSTRAINT "product_metafields_shop_id_definition_id_owner_entity_fkey" FOREIGN KEY ("shop_id", "definition_id", "owner_entity") REFERENCES "mirror"."metafield_definitions"("shop_id", "id", "owner_entity") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."variant_metafields" ADD CONSTRAINT "variant_metafields_shop_id_generation_id_variant_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "variant_id") REFERENCES "mirror"."variants"("shop_id", "generation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."variant_metafields" ADD CONSTRAINT "variant_metafields_shop_id_definition_id_owner_entity_fkey" FOREIGN KEY ("shop_id", "definition_id", "owner_entity") REFERENCES "mirror"."metafield_definitions"("shop_id", "id", "owner_entity") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."saved_filters" ADD CONSTRAINT "saved_filters_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."selection_snapshots" ADD CONSTRAINT "selection_snapshots_shop_id_generation_id_coverage_revisio_fkey" FOREIGN KEY ("shop_id", "generation_id", "coverage_revision", "mapping_version") REFERENCES "mirror"."generations"("shop_id", "id", "coverage_revision", "mapping_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "mirror"."selection_items" ADD CONSTRAINT "selection_items_shop_id_snapshot_id_generation_id_fkey" FOREIGN KEY ("shop_id", "snapshot_id", "generation_id") REFERENCES "mirror"."selection_snapshots"("shop_id", "id", "generation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."selection_items" ADD CONSTRAINT "selection_items_shop_id_generation_id_product_id_fkey" FOREIGN KEY ("shop_id", "generation_id", "product_id") REFERENCES "mirror"."products"("shop_id", "generation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."execution_contracts" ADD CONSTRAINT "execution_contracts_shop_id_snapshot_id_fkey" FOREIGN KEY ("shop_id", "snapshot_id") REFERENCES "mirror"."selection_snapshots"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."job_commands" ADD CONSTRAINT "job_commands_shop_id_contract_id_fkey" FOREIGN KEY ("shop_id", "contract_id") REFERENCES "mirror"."execution_contracts"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."job_items" ADD CONSTRAINT "job_items_shop_id_command_id_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."job_commands"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."outbox_events" ADD CONSTRAINT "outbox_events_shop_id_command_id_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."job_commands"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."job_schedules" ADD CONSTRAINT "job_schedules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."job_artifacts" ADD CONSTRAINT "job_artifacts_shop_id_command_id_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."job_commands"("shop_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."audit_events" ADD CONSTRAINT "audit_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append to the generated initial migration. Never apply this file alone.
-- Runtime writers must acquire the publication barrier BEFORE their first read.

ALTER TABLE mirror.shops ADD CONSTRAINT shop_domain CHECK
  (id ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' AND length(id) <= 255);

ALTER TABLE mirror.generations ADD CONSTRAINT required_datasets_nonempty CHECK
  (cardinality(required_datasets) > 0 AND cardinality(required_datasets) <= 32
   AND array_position(required_datasets, NULL) IS NULL
   AND required_datasets @> ARRAY['products']::text[]
   AND required_datasets <@ ARRAY['products','variants','inventory_items','inventory_levels',
     'locations','collections','product_options','categories','metafields']::text[]);
ALTER TABLE mirror.generations ADD CONSTRAINT generation_verified_timestamps CHECK
  ((status NOT IN ('VERIFIED','PUBLISHED','RETIRED') OR verified_at IS NOT NULL)
   AND (status <> 'PUBLISHED' OR published_at IS NOT NULL));
ALTER TABLE mirror.coverage ADD CONSTRAINT coverage_verified CHECK
  (name ~ '^[a-z][a-z0-9_]{0,63}$' AND durable_rows >= 0
   AND (status <> 'COMPLETE' OR (verified_at IS NOT NULL AND verification_hash IS NOT NULL)));
ALTER TABLE mirror.ingestion_runs ADD CONSTRAINT ingestion_durable_counts CHECK
  (processed_lines >= 0 AND invalid_lines >= 0 AND fence >= 0
   AND (expected_lines IS NULL OR (expected_lines >= 0 AND processed_lines <= expected_lines))
   AND (status <> 'SUCCEEDED' OR (expected_lines IS NOT NULL
     AND expected_lines = processed_lines AND invalid_lines = 0
     AND eof_verified AND writes_finished_at IS NOT NULL)));
ALTER TABLE mirror.ingestion_chunks ADD CONSTRAINT chunk_counts CHECK (ordinal >= 0 AND line_count >= 0);
ALTER TABLE mirror.catalog_changes ADD CONSTRAINT reconciliation_revisions CHECK
  (revision > 0 AND applied_revision >= 0 AND applied_revision <= revision
   AND (dirty OR applied_revision = revision) AND attempts >= 0 AND fence >= 0);

CREATE INDEX catalog_changes_due ON mirror.catalog_changes
  (shop_id, next_attempt_at, product_id) WHERE dirty AND dead_letter_at IS NULL;
CREATE INDEX job_commands_due ON mirror.job_commands (available_at, id)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX job_commands_recover ON mirror.job_commands (lease_until, id)
  WHERE status = 'RUNNING';
CREATE INDEX outbox_events_due ON mirror.outbox_events (available_at, id)
  WHERE dispatched_at IS NULL;
CREATE INDEX job_schedules_due ON mirror.job_schedules (next_run_at, id) WHERE enabled;

ALTER TABLE mirror.products ADD CONSTRAINT product_revision CHECK (source_revision >= 0);
ALTER TABLE mirror.variants ADD CONSTRAINT variant_revision CHECK (source_revision >= 0);
ALTER TABLE mirror.products ADD CONSTRAINT product_shopify_identity CHECK (shopify_id ~ '^gid://shopify/Product/[1-9][0-9]*$');
ALTER TABLE mirror.variants ADD CONSTRAINT variant_shopify_identity CHECK (shopify_id ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$');
ALTER TABLE mirror.catalog_changes ADD CONSTRAINT change_shopify_identity CHECK (product_id ~ '^gid://shopify/Product/[1-9][0-9]*$');
ALTER TABLE mirror.metafield_definitions ADD CONSTRAINT definition_shopify_identity CHECK
  (shopify_definition_id ~ '^gid://shopify/MetafieldDefinition/[1-9][0-9]*$');
ALTER TABLE mirror.product_metafields ADD CONSTRAINT product_metafield_owner CHECK (owner_entity = 'product');
ALTER TABLE mirror.variant_metafields ADD CONSTRAINT variant_metafield_owner CHECK (owner_entity = 'variant');
ALTER TABLE mirror.metafield_definitions ADD CONSTRAINT definition_verification CHECK
  ((precision IS NULL AND scale IS NULL OR (precision IS NOT NULL AND scale IS NOT NULL
     AND precision BETWEEN 1 AND 38 AND scale BETWEEN 0 AND precision))
   AND (NOT definition_verified OR (verified_at IS NOT NULL AND verification_expires_at IS NOT NULL AND verification_expires_at > verified_at
     AND definition_token ~ '^[A-Za-z0-9_-]+$' AND length(definition_token) BETWEEN 16 AND 256)));
ALTER TABLE mirror.selection_snapshots ADD CONSTRAINT selection_frozen CHECK
  (selected_count >= 0 AND expires_at > created_at
   AND (status <> 'APPROVED' OR (frozen_at IS NOT NULL AND selection_hash IS NOT NULL)));
ALTER TABLE mirror.execution_contracts ADD CONSTRAINT contract_approved CHECK
  (status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL));
ALTER TABLE mirror.job_commands ADD CONSTRAINT command_retry_bounds CHECK
  (attempts >= 0 AND max_attempts BETWEEN 1 AND 100 AND attempts <= max_attempts AND fence >= 0
   AND (status <> 'RUNNING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)));
ALTER TABLE mirror.job_items ADD CONSTRAINT item_retry_bounds CHECK (attempts >= 0);
ALTER TABLE mirror.outbox_events ADD CONSTRAINT outbox_retry_bounds CHECK (attempts >= 0 AND fence >= 0);
ALTER TABLE mirror.job_schedules ADD CONSTRAINT schedule_fence CHECK (fence >= 0);
ALTER TABLE mirror.job_artifacts ADD CONSTRAINT artifact_integrity CHECK
  (byte_length >= 0 AND (row_count IS NULL OR row_count >= 0) AND sha256 ~ '^[a-f0-9]{64}$');

-- Freeze all published catalog data. Writers lock this parent row while staging;
-- the status transition waits for in-flight writers rather than racing them.
CREATE FUNCTION mirror.guard_generation_data() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; tenant text; gen text; mapping text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.shop_id, NEW.generation_id) IS DISTINCT FROM (OLD.shop_id, OLD.generation_id) THEN
    RAISE EXCEPTION 'Cannot move rows between tenants or generations' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN tenant := OLD.shop_id; gen := OLD.generation_id;
  ELSE tenant := NEW.shop_id; gen := NEW.generation_id; END IF;
  SELECT status::text, mapping_version INTO s, mapping FROM mirror.generations WHERE shop_id = tenant AND id = gen FOR SHARE;
  -- A cascaded deletion of the parent has already checked retained references.
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF s IS NULL OR (s NOT IN ('INGESTING', 'RECONCILING') AND NOT (TG_OP = 'DELETE' AND s IN ('RETIRED', 'FAILED'))) THEN
    RAISE EXCEPTION 'Generation data is immutable outside staging' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('products', 'variants') AND TG_OP = 'UPDATE' THEN
    IF NEW.source_revision < OLD.source_revision THEN
      RAISE EXCEPTION 'Stale mirror revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'field_mappings' AND TG_OP <> 'DELETE' THEN
    IF NEW.mapping_version <> mapping THEN RAISE EXCEPTION 'Mapping version differs from generation' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['products','variants','inventory_items','locations','inventory_levels',
    'collections','product_collections','product_options','categories','product_metafields',
    'variant_metafields','field_mappings','coverage','ingestion_runs'] LOOP
    EXECUTE format('CREATE TRIGGER guard_generation_data BEFORE INSERT OR UPDATE OR DELETE ON mirror.%I
      FOR EACH ROW EXECUTE FUNCTION mirror.guard_generation_data()', t);
  END LOOP;
END $$;

CREATE FUNCTION mirror.guard_generation_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INGESTING' THEN RAISE EXCEPTION 'Generation must begin INGESTING' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('RETIRED', 'FAILED') THEN RAISE EXCEPTION 'Retire generation before cleanup' USING ERRCODE = '23514'; END IF;
    IF OLD.retain_until > now() THEN RAISE EXCEPTION 'Generation retention has not expired' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.shop_id, NEW.id) IS DISTINCT FROM (OLD.shop_id, OLD.id) THEN
    RAISE EXCEPTION 'Generation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('VERIFIED', 'PUBLISHED', 'RETIRED') AND
    (to_jsonb(NEW) - ARRAY['status','published_at','retired_at','retain_until']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','published_at','retired_at','retain_until']) THEN
    RAISE EXCEPTION 'Verified generation metadata is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('VERIFIED', 'PUBLISHED', 'RETIRED') AND NEW.published_at IS DISTINCT FROM OLD.published_at
    AND NOT (OLD.status = 'VERIFIED' AND NEW.status = 'PUBLISHED' AND NEW.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Publication timestamp is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'INGESTING' AND NEW.status IN ('RECONCILING','FAILED'))
    OR (OLD.status = 'RECONCILING' AND NEW.status IN ('VERIFIED','FAILED'))
    OR (OLD.status = 'VERIFIED' AND NEW.status IN ('PUBLISHED','RETIRED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'Invalid generation state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RECONCILING' AND EXISTS (
    SELECT 1 FROM unnest(NEW.required_datasets) d(name) WHERE NOT EXISTS (
      SELECT 1 FROM mirror.ingestion_runs r WHERE r.shop_id = NEW.shop_id AND r.generation_id = NEW.id
      AND r.dataset = d.name AND r.status = 'SUCCEEDED')) THEN
    RAISE EXCEPTION 'Durable ingestion must finish before reconciliation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'VERIFIED' AND (NEW.verified_at IS NULL OR EXISTS (
    SELECT 1 FROM unnest(NEW.required_datasets) d(name) WHERE NOT EXISTS (
      SELECT 1 FROM mirror.coverage c WHERE c.shop_id = NEW.shop_id AND c.generation_id = NEW.id
      AND c.name = d.name AND c.status = 'COMPLETE'))) THEN
    RAISE EXCEPTION 'Complete verified coverage required' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RETIRED' AND EXISTS (SELECT 1 FROM mirror.publications p
    WHERE p.shop_id = NEW.shop_id AND p.generation_id = NEW.id) THEN
    RAISE EXCEPTION 'Move or remove publication pointer before retirement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_generation_status BEFORE INSERT OR UPDATE OR DELETE ON mirror.generations
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_generation_status();

CREATE FUNCTION mirror.guard_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mirror.generations g WHERE g.shop_id = NEW.shop_id AND g.id = NEW.generation_id
    AND g.status = 'PUBLISHED' AND g.verified_at IS NOT NULL AND g.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only verified published generations may become current' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_publication BEFORE INSERT OR UPDATE ON mirror.publications
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_publication();

-- Selection membership becomes immutable at approval; row locks serialize an
-- insertion with a concurrent freeze. Runtime still verifies counts and hashes.
CREATE FUNCTION mirror.guard_selection_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen timestamptz; approval text; tenant text; snapshot text;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Selection items cannot be changed' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN tenant := OLD.shop_id; snapshot := OLD.snapshot_id;
  ELSE tenant := NEW.shop_id; snapshot := NEW.snapshot_id; END IF;
  SELECT frozen_at, status::text INTO frozen, approval FROM mirror.selection_snapshots
    WHERE shop_id = tenant AND id = snapshot FOR UPDATE;
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF frozen IS NOT NULL OR approval IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Selection is frozen' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_selection_item BEFORE INSERT OR UPDATE OR DELETE ON mirror.selection_items
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_selection_item();

CREATE FUNCTION mirror.guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'Approval must begin DRAFT' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
    IF TG_TABLE_NAME = 'selection_snapshots' THEN
      IF NOT EXISTS (SELECT 1 FROM mirror.generations g WHERE g.shop_id = NEW.shop_id AND g.id = NEW.generation_id
        AND g.status = 'PUBLISHED') THEN
        RAISE EXCEPTION 'Selection requires a published generation' USING ERRCODE = '23514';
      END IF;
      IF NEW.selected_count <> (SELECT count(*) FROM mirror.selection_items
        WHERE shop_id = NEW.shop_id AND snapshot_id = NEW.id) THEN
        RAISE EXCEPTION 'Selection count differs from frozen membership' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM mirror.selection_snapshots s WHERE s.shop_id = NEW.shop_id AND s.id = NEW.snapshot_id
        AND s.status = 'APPROVED' AND s.operation = NEW.operation AND s.expires_at > now()
        AND NEW.expires_at <= s.expires_at) THEN
        RAISE EXCEPTION 'Approved matching selection required' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status IN ('REVOKED','EXPIRED') AND OLD.expires_at <= now() THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'Approval must be revoked or expired before cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.status NOT IN (OLD.status, 'REVOKED', 'EXPIRED') OR
      (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'Approved contract or selection is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_selection_approval BEFORE INSERT OR UPDATE OR DELETE ON mirror.selection_snapshots
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_approval();
CREATE TRIGGER guard_execution_approval BEFORE INSERT OR UPDATE OR DELETE ON mirror.execution_contracts
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_approval();
