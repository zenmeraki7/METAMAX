BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE mirror.job_commands,mirror.job_items IN ACCESS EXCLUSIVE MODE;
ALTER TABLE mirror.job_items ADD COLUMN restore_snapshot_id BIGINT;

-- CreateTable
CREATE TABLE "mirror"."edit_operations" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "command_id" BIGINT NOT NULL,
    "preview_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."idempotency_records" (
    "shop_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "mirror"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "command_id" BIGINT,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "fence" BIGINT NOT NULL DEFAULT 0,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("shop_id","operation","key")
);

-- CreateTable
CREATE TABLE "mirror"."mutation_journal" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "source_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "sync_run_id" BIGINT,
    "payload_hash" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),

    CONSTRAINT "mutation_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."product_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "edit_item_id" BIGINT NOT NULL,
    "before_values" JSONB NOT NULL,
    "before_hash" TEXT,
    "after_hash" TEXT,
    "before_revision" BIGINT,
    "after_revision" BIGINT,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mirror"."undo_operations" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source_operation_id" BIGINT NOT NULL,
    "restore_operation_id" BIGINT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'COMPARE_AFTER_HASH',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "undo_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edit_operations_shop_id_id_key" ON "mirror"."edit_operations"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "edit_operations_shop_id_command_id_key" ON "mirror"."edit_operations"("shop_id", "command_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "mirror"."idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "mutation_journal_shop_id_source_key_key" ON "mirror"."mutation_journal"("shop_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "mutation_journal_shop_id_product_id_revision_key" ON "mirror"."mutation_journal"("shop_id", "product_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "product_snapshots_shop_id_id_key" ON "mirror"."product_snapshots"("shop_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_snapshots_shop_id_edit_item_id_key" ON "mirror"."product_snapshots"("shop_id", "edit_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "undo_operations_shop_id_restore_operation_id_key" ON "mirror"."undo_operations"("shop_id", "restore_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_items_shop_id_id_key" ON "mirror"."job_items"("shop_id", "id");


-- Preserve legacy item receipts and before-values before adding aggregate FKs.
INSERT INTO mirror.edit_operations (shop_id,command_id,preview_id,created_at)
SELECT c.shop_id,c.id,c.contract_id,c.created_at FROM mirror.job_commands c
WHERE c.kind = 'bulk_edit' OR EXISTS (SELECT 1 FROM mirror.job_items i WHERE i.shop_id=c.shop_id AND i.command_id=c.id);
INSERT INTO mirror.product_snapshots (shop_id,edit_item_id,before_values,before_revision)
SELECT shop_id,id,before_values,observed_revision FROM mirror.job_items WHERE before_values IS NOT NULL;
ALTER TABLE mirror.job_items DROP COLUMN before_values;

-- AddForeignKey
ALTER TABLE "mirror"."job_items" ADD CONSTRAINT "edit_item_operation_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."edit_operations"("shop_id", "command_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."job_items" ADD CONSTRAINT "job_items_shop_id_restore_snapshot_id_fkey" FOREIGN KEY ("shop_id", "restore_snapshot_id") REFERENCES "mirror"."product_snapshots"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."edit_operations" ADD CONSTRAINT "edit_operations_shop_id_command_id_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."job_commands"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."edit_operations" ADD CONSTRAINT "edit_operations_shop_id_preview_id_fkey" FOREIGN KEY ("shop_id", "preview_id") REFERENCES "mirror"."execution_contracts"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."idempotency_records" ADD CONSTRAINT "idempotency_records_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "mirror"."shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."idempotency_records" ADD CONSTRAINT "idempotency_records_shop_id_command_id_fkey" FOREIGN KEY ("shop_id", "command_id") REFERENCES "mirror"."job_commands"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."mutation_journal" ADD CONSTRAINT "mutation_journal_shop_id_product_id_fkey" FOREIGN KEY ("shop_id", "product_id") REFERENCES "mirror"."catalog_changes"("shop_id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."mutation_journal" ADD CONSTRAINT "mutation_journal_shop_id_sync_run_id_fkey" FOREIGN KEY ("shop_id", "sync_run_id") REFERENCES "mirror"."ingestion_runs"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."product_snapshots" ADD CONSTRAINT "product_snapshots_shop_id_edit_item_id_fkey" FOREIGN KEY ("shop_id", "edit_item_id") REFERENCES "mirror"."job_items"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."undo_operations" ADD CONSTRAINT "undo_operations_shop_id_source_operation_id_fkey" FOREIGN KEY ("shop_id", "source_operation_id") REFERENCES "mirror"."edit_operations"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror"."undo_operations" ADD CONSTRAINT "undo_operations_shop_id_restore_operation_id_fkey" FOREIGN KEY ("shop_id", "restore_operation_id") REFERENCES "mirror"."edit_operations"("shop_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE mirror.mutation_journal ADD CONSTRAINT journal_metadata CHECK
  (revision > 0 AND (payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$')
   AND (applied_at IS NULL OR applied_at >= recorded_at)
   AND (purge_after IS NULL OR purge_after > recorded_at));
ALTER TABLE mirror.product_snapshots ADD CONSTRAINT snapshot_confirmation CHECK
  ((before_hash IS NULL OR before_hash ~ '^[a-f0-9]{64}$')
   AND (after_hash IS NULL OR after_hash ~ '^[a-f0-9]{64}$')
   AND (before_revision IS NULL OR before_revision >= 0)
   AND (after_revision IS NULL OR after_revision >= 0)
   AND (confirmed_at IS NULL OR (before_hash IS NOT NULL AND after_hash IS NOT NULL AND confirmed_at >= captured_at)));
ALTER TABLE mirror.undo_operations ADD CONSTRAINT undo_compare_after CHECK
  (source_operation_id <> restore_operation_id AND mode = 'COMPARE_AFTER_HASH');
ALTER TABLE mirror.idempotency_records ADD CONSTRAINT idempotency_lifecycle CHECK
  (length(operation) BETWEEN 1 AND 128 AND length(key) BETWEEN 1 AND 255
   AND request_hash ~ '^[a-f0-9]{64}$' AND fence >= 0 AND expires_at > created_at
   AND (status <> 'RUNNING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
   AND (status <> 'SUCCEEDED' OR completed_at IS NOT NULL)
   AND (response IS NULL OR octet_length(response::text) <= 524288));

CREATE FUNCTION mirror.guard_edit_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Edit operation binding is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mirror.job_commands c JOIN mirror.execution_contracts p
    ON p.shop_id=c.shop_id AND p.id=c.contract_id
    WHERE c.shop_id=NEW.shop_id AND c.id=NEW.command_id AND c.contract_id=NEW.preview_id
      AND p.status='APPROVED' AND p.expires_at > now()) THEN
    RAISE EXCEPTION 'Edit command requires its matching approved preview' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_edit_operation BEFORE INSERT OR UPDATE ON mirror.edit_operations
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_edit_operation();

CREATE FUNCTION mirror.guard_mutation_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observed bigint; applied bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.applied_at IS NULL OR OLD.purge_after IS NULL OR OLD.purge_after > now() THEN
      RAISE EXCEPTION 'Journal entry remains retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'applied_at') IS DISTINCT FROM (to_jsonb(OLD)-'applied_at')
    OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at)) THEN
    RAISE EXCEPTION 'Journal intent is immutable' USING ERRCODE='23514';
  END IF;
  SELECT revision,applied_revision INTO observed,applied FROM mirror.catalog_changes
    WHERE shop_id=NEW.shop_id AND product_id=NEW.product_id FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.revision > observed OR (NEW.applied_at IS NOT NULL AND NEW.revision > applied) THEN
    RAISE EXCEPTION 'Journal acknowledgement exceeds durable revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_mutation_journal BEFORE INSERT OR UPDATE OR DELETE ON mirror.mutation_journal
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_mutation_journal();

CREATE FUNCTION mirror.guard_product_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_status text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM mirror.job_items i JOIN mirror.job_commands c
      ON c.shop_id=i.shop_id AND c.id=i.command_id JOIN mirror.execution_contracts p
      ON p.shop_id=c.shop_id AND p.id=c.contract_id WHERE i.shop_id=OLD.shop_id AND i.id=OLD.edit_item_id
      AND c.status IN ('SUCCEEDED','FAILED','CANCELLED') AND p.expires_at <= now()) THEN
      RAISE EXCEPTION 'Undo snapshot remains retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status::text INTO item_status FROM mirror.job_items WHERE shop_id=NEW.shop_id AND id=NEW.edit_item_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    IF NEW.before_hash IS NULL OR NEW.confirmed_at IS NOT NULL OR item_status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
      RAISE EXCEPTION 'Capture hashed before-values before mutation completes' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.shop_id,NEW.edit_item_id,NEW.before_values,NEW.before_revision,NEW.captured_at) IS DISTINCT FROM
       (OLD.shop_id,OLD.edit_item_id,OLD.before_values,OLD.before_revision,OLD.captured_at)
      OR (OLD.before_hash IS NOT NULL AND NEW.before_hash IS DISTINCT FROM OLD.before_hash)
      OR (OLD.after_hash IS NOT NULL AND NEW.after_hash IS DISTINCT FROM OLD.after_hash)
      OR (OLD.after_revision IS NOT NULL AND NEW.after_revision IS DISTINCT FROM OLD.after_revision)
      OR (OLD.confirmed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Captured undo values and confirmations are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.confirmed_at IS NOT NULL AND item_status IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Undo requires confirmed successful mutation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_product_snapshot BEFORE INSERT OR UPDATE OR DELETE ON mirror.product_snapshots
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_product_snapshot();

CREATE FUNCTION mirror.guard_undo_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Undo binding is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mirror.edit_operations e JOIN mirror.execution_contracts p
    ON p.shop_id=e.shop_id AND p.id=e.preview_id WHERE e.shop_id=NEW.shop_id AND e.id=NEW.restore_operation_id
    AND p.operation='undo' AND p.status='APPROVED' AND p.expires_at > now()) THEN
    RAISE EXCEPTION 'Undo needs a new approved restoration contract' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_undo_operation BEFORE INSERT OR UPDATE ON mirror.undo_operations
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_undo_operation();

CREATE FUNCTION mirror.guard_edit_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND ((NEW.shop_id,NEW.command_id,NEW.resource_id,NEW.intended_values,NEW.restore_snapshot_id)
    IS DISTINCT FROM (OLD.shop_id,OLD.command_id,OLD.resource_id,OLD.intended_values,OLD.restore_snapshot_id)
    OR (OLD.status='SUCCEEDED' AND NEW.status <> OLD.status)) THEN
    RAISE EXCEPTION 'Edit target and intended values are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.restore_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mirror.product_snapshots s JOIN mirror.job_items original
    ON original.shop_id=s.shop_id AND original.id=s.edit_item_id
    JOIN mirror.edit_operations source ON source.shop_id=original.shop_id AND source.command_id=original.command_id
    JOIN mirror.undo_operations u ON u.shop_id=source.shop_id AND u.source_operation_id=source.id
    JOIN mirror.edit_operations restore ON restore.shop_id=u.shop_id AND restore.id=u.restore_operation_id
    WHERE s.shop_id=NEW.shop_id AND s.id=NEW.restore_snapshot_id AND s.confirmed_at IS NOT NULL
      AND original.resource_id=NEW.resource_id AND restore.command_id=NEW.command_id) THEN
    RAISE EXCEPTION 'Restoration item does not match a confirmed source snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_edit_item BEFORE INSERT OR UPDATE ON mirror.job_items
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_edit_item();

CREATE FUNCTION mirror.guard_idempotency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.expires_at > now() OR OLD.status NOT IN ('SUCCEEDED','FAILED','CANCELLED') THEN
      RAISE EXCEPTION 'Idempotency result remains retained or recoverable' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.shop_id,NEW.operation,NEW.key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM
     (OLD.shop_id,OLD.operation,OLD.key,OLD.request_hash,OLD.created_at)
    OR NEW.fence < OLD.fence OR (OLD.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id)
    OR (OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Idempotency request or completed result is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_idempotency BEFORE UPDATE OR DELETE ON mirror.idempotency_records
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_idempotency();
COMMIT;
