BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

CREATE TABLE mirror.sync_dispatch_recovery_evidence (
  id text PRIMARY KEY,
  dispatch_id text NOT NULL,
  shop_id text NOT NULL,
  run_id text NOT NULL,
  generation_id text NOT NULL,
  delivery_revision bigint NOT NULL CHECK(delivery_revision>=0),
  kind text NOT NULL CHECK(kind IN ('SYNC','RECOVERY')),
  delivery_key text NOT NULL,
  recovery_token text NOT NULL,
  recovery_fence bigint NOT NULL CHECK(recovery_fence>0),
  decision text NOT NULL CHECK(decision IN ('CONSUMED','STILL_ENQUEUED','RETRY_VERIFIED','UNRESOLVED')),
  queue_state text NOT NULL CHECK(queue_state IN ('ABSENT','ENQUEUED','CONSUMED','UNRESOLVED','UNKNOWN')),
  job_id text NOT NULL,
  observed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  CONSTRAINT sync_dispatch_recovery_evidence_fence_unique UNIQUE(dispatch_id,recovery_fence),
  CONSTRAINT sync_dispatch_recovery_evidence_dispatch_fk FOREIGN KEY(dispatch_id)
    REFERENCES mirror.sync_dispatches(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT sync_dispatch_recovery_evidence_execution_fk FOREIGN KEY(shop_id,run_id,generation_id)
    REFERENCES mirror.catalog_import_executions(shop_id,id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT sync_dispatch_recovery_evidence_shop_fk FOREIGN KEY(shop_id)
    REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX sync_dispatch_recovery_evidence_lookup_idx
  ON mirror.sync_dispatch_recovery_evidence(dispatch_id,recovery_fence,expires_at);

CREATE FUNCTION mirror.guard_sync_dispatch_recovery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.dispatch_id,OLD.shop_id,OLD.run_id,OLD.generation_id,OLD.delivery_revision,
      OLD.kind,OLD.delivery_key,OLD.recovery_token,OLD.recovery_fence,OLD.decision,
      OLD.queue_state,OLD.job_id,OLD.observed_at,OLD.expires_at)
    IS DISTINCT FROM (NEW.id,NEW.dispatch_id,NEW.shop_id,NEW.run_id,NEW.generation_id,NEW.delivery_revision,
      NEW.kind,NEW.delivery_key,NEW.recovery_token,NEW.recovery_fence,NEW.decision,
      NEW.queue_state,NEW.job_id,NEW.observed_at,NEW.expires_at)
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'Recovery evidence is immutable and write-once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_sync_dispatch_recovery_evidence BEFORE UPDATE ON mirror.sync_dispatch_recovery_evidence
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_dispatch_recovery_evidence();

COMMIT;

