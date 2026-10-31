BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

-- One queue record, with exactly one executor. Legacy rows remain drainable.
ALTER TABLE mirror.catalog_import_jobs ADD COLUMN execution_mode text NOT NULL DEFAULT 'LEGACY'
  CHECK (execution_mode IN ('LEGACY','PHASE'));
ALTER TABLE mirror.catalog_import_jobs ADD CONSTRAINT catalog_import_execution_identity UNIQUE(shop_id,id,generation_id);
CREATE TABLE mirror.catalog_import_executions (
  id text PRIMARY KEY,
  shop_id text NOT NULL REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  generation_id text NOT NULL,
  phase text NOT NULL DEFAULT 'STARTING' CHECK (phase IN ('STARTING','WAITING','INGESTING','RECONCILING','PUBLISHING')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0 AND attempt<=12),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
  lease_token text, lease_until timestamptz(3), worker_id text, next_eligible_at timestamptz(3),
  completed_at timestamptz(3), review_required boolean NOT NULL DEFAULT false,
  recovery_attempts integer NOT NULL DEFAULT 0 CHECK(recovery_attempts BETWEEN 0 AND 8),
  cancel_completed_at timestamptz(3),
  outcome_uncertain boolean NOT NULL DEFAULT false, cancel_requested boolean NOT NULL DEFAULT false, last_error text,
  CONSTRAINT catalog_execution_job FOREIGN KEY(shop_id,id,generation_id)
    REFERENCES mirror.catalog_import_jobs(shop_id,id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT catalog_execution_generation FOREIGN KEY(shop_id,generation_id)
    REFERENCES mirror.generations(shop_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT catalog_execution_identity UNIQUE(shop_id,id,generation_id)
);
CREATE INDEX catalog_execution_shop_lease ON mirror.catalog_import_executions(shop_id,lease_until);
CREATE INDEX catalog_execution_due ON mirror.catalog_import_executions(next_eligible_at,id);
ALTER TABLE mirror.ingestion_runs ADD COLUMN execution_id text;
ALTER TABLE mirror.ingestion_runs ADD COLUMN execution_fence bigint;
ALTER TABLE mirror.ingestion_runs ADD CONSTRAINT ingestion_execution_scope FOREIGN KEY(shop_id,execution_id,generation_id)
  REFERENCES mirror.catalog_import_executions(shop_id,id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE mirror.ingestion_runs ADD CONSTRAINT ingestion_execution_owner CHECK
  ((execution_id IS NULL AND execution_fence IS NULL) OR (execution_id IS NOT NULL AND execution_fence>=0));

CREATE TABLE mirror.sync_external_operations (
  id text PRIMARY KEY, shop_id text NOT NULL, run_id text NOT NULL, generation_id text NOT NULL,
  kind text NOT NULL CHECK(kind='BULK_START'), input_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('PREPARED','DISPATCHING','CONFIRMED','REJECTED')),
  dispatch_fence bigint NOT NULL CHECK(dispatch_fence>0), operation_id text, remote_status text, object_count bigint, last_error text,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(run_id,kind),
  FOREIGN KEY(shop_id,run_id,generation_id) REFERENCES mirror.catalog_import_executions(shop_id,id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK(state<>'CONFIRMED' OR operation_id IS NOT NULL)
);

-- Phase jobs never acquire the legacy orchestration lease. Its nullable initial
-- generation remains compatible with historical LEGACY jobs only.
CREATE FUNCTION mirror.guard_catalog_execution_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.execution_mode<>NEW.execution_mode OR
      (OLD.execution_mode='PHASE' AND (OLD.shop_id,OLD.id,OLD.generation_id,OLD.run_id,OLD.installation_version)
        IS DISTINCT FROM (NEW.shop_id,NEW.id,NEW.generation_id,NEW.run_id,NEW.installation_version))) THEN
    RAISE EXCEPTION 'Import execution identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.execution_mode='PHASE' AND (NEW.lease_until IS NOT NULL OR NEW.generation_id IS NULL OR NEW.run_id IS NULL) THEN
    RAISE EXCEPTION 'Phase import requires a bound generation and no legacy lease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_catalog_execution_mode BEFORE INSERT OR UPDATE ON mirror.catalog_import_jobs
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_execution_mode();

CREATE FUNCTION mirror.reset_catalog_recovery_streak() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lease_token IS NOT NULL AND OLD.worker_id<>'recovery' AND NEW.lease_token IS NULL
    AND NEW.attempt=0 AND NOT NEW.outcome_uncertain AND NOT NEW.review_required AND NOT NEW.cancel_requested THEN
    NEW.recovery_attempts:=0;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reset_catalog_recovery_streak BEFORE UPDATE ON mirror.catalog_import_executions
  FOR EACH ROW EXECUTE FUNCTION mirror.reset_catalog_recovery_streak();

CREATE FUNCTION mirror.guard_sync_external_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.shop_id,OLD.run_id,OLD.generation_id,OLD.kind,OLD.input_hash)
      IS DISTINCT FROM (NEW.id,NEW.shop_id,NEW.run_id,NEW.generation_id,NEW.kind,NEW.input_hash)
    OR (OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id)
    OR NEW.dispatch_fence<OLD.dispatch_fence
    OR (OLD.state='CONFIRMED' AND NEW.state<>'CONFIRMED')
    OR (OLD.remote_status='COMPLETED' AND (NEW.remote_status,NEW.object_count) IS DISTINCT FROM (OLD.remote_status,OLD.object_count)) THEN
    RAISE EXCEPTION 'External operation intent and confirmed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sync_external_intent BEFORE UPDATE ON mirror.sync_external_operations
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_external_intent();

CREATE FUNCTION mirror.propagate_catalog_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j WHERE j.id=NEW.id AND j.shop_id=NEW.shop_id
    AND j.generation_id=NEW.generation_id AND j.execution_mode='PHASE') THEN
    RAISE EXCEPTION 'Execution requires its phase job' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ((OLD.id,OLD.shop_id,OLD.generation_id) IS DISTINCT FROM (NEW.id,NEW.shop_id,NEW.generation_id)
    OR NEW.fence<OLD.fence) THEN
    RAISE EXCEPTION 'Execution identity and fence cannot regress' USING ERRCODE='23514';
  END IF;
  -- The child lease is derived from this lease, never an independent authority.
  IF TG_OP='UPDATE' THEN
    UPDATE mirror.ingestion_runs SET
      execution_fence=NEW.fence,
      lease_token=CASE WHEN NEW.lease_token IS NOT NULL AND NOT NEW.outcome_uncertain AND NOT NEW.review_required AND NOT NEW.cancel_requested THEN NEW.lease_token ELSE NULL END,
      lease_until=CASE WHEN NEW.lease_token IS NOT NULL AND NOT NEW.outcome_uncertain AND NOT NEW.review_required AND NOT NEW.cancel_requested THEN NEW.lease_until ELSE NULL END,
      fence=fence+CASE WHEN NEW.fence<>OLD.fence THEN 1 ELSE 0 END,
      status=CASE WHEN NEW.lease_token IS NOT NULL AND NOT NEW.outcome_uncertain AND NOT NEW.review_required THEN 'RUNNING'::mirror."WorkStatus" ELSE status END
    WHERE shop_id=NEW.shop_id AND execution_id=NEW.id AND status<>'SUCCEEDED'
      AND EXISTS(SELECT 1 FROM mirror.generations g WHERE g.shop_id=NEW.shop_id AND g.id=NEW.generation_id AND g.status='INGESTING');
  END IF;
  UPDATE mirror.catalog_import_jobs SET status=CASE
    WHEN NEW.completed_at IS NOT NULL THEN 'SUCCEEDED'
    WHEN NEW.cancel_requested THEN 'CANCELLED'
    WHEN NEW.review_required THEN 'FAILED'
    WHEN NEW.lease_token IS NOT NULL THEN 'RUNNING' ELSE 'RETRY' END,
    last_error=NEW.last_error,updated_at=now() WHERE id=NEW.id AND shop_id=NEW.shop_id;
  RETURN NEW;
END $$;
CREATE TRIGGER propagate_catalog_execution AFTER INSERT OR UPDATE ON mirror.catalog_import_executions
  FOR EACH ROW EXECUTE FUNCTION mirror.propagate_catalog_execution();
COMMIT;
