-- METAMAX durable dispatch ledger, PostgreSQL 14+.
-- 20261029000200 already created the dispatch ledger. Evolve it in place;
-- never create a parallel ledger or another SyncRun/execution table.
BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER guard_sync_dispatch_identity ON mirror.sync_dispatch_deliveries;
ALTER TABLE mirror.sync_dispatch_deliveries RENAME TO sync_dispatches;
ALTER TABLE mirror.sync_dispatches RENAME COLUMN reservation_token TO dispatch_token;
ALTER TABLE mirror.sync_dispatches RENAME COLUMN last_error TO last_error_code;
ALTER TABLE mirror.sync_dispatches ALTER COLUMN reserved_until DROP NOT NULL;
ALTER TABLE mirror.sync_dispatches ALTER COLUMN state SET DEFAULT 'PENDING';
ALTER TABLE mirror.sync_dispatches
  ADD COLUMN next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  ADD COLUMN attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN enqueued_at timestamptz(3),
  ADD COLUMN sync_run_id bigint;

-- Keep TEXT run_id bound to the globally unique phase execution. The actual
-- SyncRun is ingestion_runs.id (BIGINT), so bind it separately without casts.
UPDATE mirror.sync_dispatches d SET sync_run_id=j.run_id
FROM mirror.catalog_import_jobs j
WHERE j.id=d.run_id AND j.shop_id=d.shop_id AND j.generation_id=d.generation_id;
ALTER TABLE mirror.sync_dispatches ALTER COLUMN sync_run_id SET NOT NULL;

CREATE OR REPLACE FUNCTION mirror.guard_sync_dispatch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.shop_id,OLD.run_id,OLD.generation_id,OLD.sync_run_id,OLD.delivery_revision,OLD.kind,OLD.delivery_key)
    IS DISTINCT FROM (NEW.id,NEW.shop_id,NEW.run_id,NEW.generation_id,NEW.sync_run_id,NEW.delivery_revision,NEW.kind,NEW.delivery_key)
    OR NEW.reservation_fence<OLD.reservation_fence
    OR (NEW.dispatch_token<>OLD.dispatch_token AND NEW.reservation_fence<=OLD.reservation_fence)
    OR (NEW.dispatch_token<>OLD.dispatch_token AND OLD.reserved_until>clock_timestamp())
    OR (NEW.reservation_fence>OLD.reservation_fence AND NEW.dispatch_token=OLD.dispatch_token)
    OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id) THEN
    RAISE EXCEPTION 'Dispatch identity and fencing are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE mirror.sync_dispatches DROP CONSTRAINT sync_dispatch_deliveries_state_check;
UPDATE mirror.sync_dispatches SET
  state=CASE state WHEN 'DISPATCHED' THEN 'ENQUEUED' WHEN 'UNCERTAIN' THEN 'UNKNOWN'
    WHEN 'EXPIRED' THEN 'PENDING' WHEN 'SUPERSEDED' THEN 'REVIEW_REQUIRED' ELSE state END,
  attempt=LEAST(reservation_fence,2147483647)::integer,
  next_attempt_at=COALESCE(reserved_until,now()),
  enqueued_at=CASE WHEN state='DISPATCHED' THEN updated_at END,
  last_error_code=CASE WHEN state='SUPERSEDED' THEN COALESCE(last_error_code,'DELIVERY_SUPERSEDED') ELSE last_error_code END;

ALTER TABLE mirror.sync_dispatches RENAME CONSTRAINT sync_dispatch_deliveries_pkey TO sync_dispatches_pkey;
ALTER TABLE mirror.sync_dispatches RENAME CONSTRAINT sync_dispatch_deliveries_kind_check TO sync_dispatches_kind_check;
ALTER TABLE mirror.sync_dispatches RENAME CONSTRAINT sync_dispatch_deliveries_delivery_key_key TO sync_dispatches_delivery_key_key;
-- PostgreSQL truncates long generated names. Resolve the old logical unique
-- constraint and execution FK by their trusted catalog bindings, not a guess.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT p.conname INTO STRICT constraint_name FROM pg_constraint p
    WHERE p.conrelid='mirror.sync_dispatches'::regclass AND p.contype='u'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(p.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.num)
        = ARRAY['shop_id','run_id','delivery_revision','kind']::text[];
  EXECUTE format('ALTER TABLE mirror.sync_dispatches RENAME CONSTRAINT %I TO sync_dispatches_logical_delivery_unique',constraint_name);
  SELECT p.conname INTO STRICT constraint_name FROM pg_constraint p
    WHERE p.conrelid='mirror.sync_dispatches'::regclass AND p.contype='f'
      AND p.confrelid='mirror.catalog_import_executions'::regclass;
  EXECUTE format('ALTER TABLE mirror.sync_dispatches RENAME CONSTRAINT %I TO sync_dispatches_execution_fk',constraint_name);
END $$;
ALTER TABLE mirror.sync_dispatches
  ADD CONSTRAINT sync_dispatches_delivery_unique UNIQUE(shop_id,delivery_key),
  ADD CONSTRAINT sync_dispatches_state_check CHECK(state IN ('PENDING','RESERVED','ENQUEUED','UNKNOWN','REVIEW_REQUIRED')),
  ADD CONSTRAINT sync_dispatches_attempt_check CHECK(attempt>=0),
  ADD CONSTRAINT sync_dispatches_reservation_check CHECK(state<>'RESERVED' OR reserved_until IS NOT NULL),
  ADD CONSTRAINT sync_dispatches_shop_fk FOREIGN KEY(shop_id) REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT sync_dispatches_sync_run_fk FOREIGN KEY(shop_id,sync_run_id)
    REFERENCES mirror.ingestion_runs(shop_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX sync_dispatches_retry_idx ON mirror.sync_dispatches(next_attempt_at,reserved_until)
  WHERE state IN ('PENDING','RESERVED','UNKNOWN');
CREATE INDEX sync_dispatches_run_idx ON mirror.sync_dispatches(shop_id,run_id,created_at);
CREATE TRIGGER guard_sync_dispatch_identity BEFORE UPDATE ON mirror.sync_dispatches
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_dispatch_identity();
COMMENT ON COLUMN mirror.sync_dispatches.state IS
  'ENQUEUED acknowledges queue insertion only. Consumers must acquire a fresh durable execution claim.';
COMMIT;
