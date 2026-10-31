BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

ALTER TABLE mirror.catalog_import_executions ADD COLUMN delivery_revision bigint NOT NULL DEFAULT 0 CHECK(delivery_revision>=0);
CREATE FUNCTION mirror.advance_sync_delivery_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.phase IS DISTINCT FROM NEW.phase OR
    (OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL AND NEW.attempt=0
      AND NOT NEW.outcome_uncertain AND NOT NEW.review_required AND NOT NEW.cancel_requested
      AND NEW.completed_at IS NULL AND OLD.worker_id IS DISTINCT FROM 'cancel') THEN
    NEW.delivery_revision:=OLD.delivery_revision+1;
  ELSIF NEW.delivery_revision<>OLD.delivery_revision THEN
    RAISE EXCEPTION 'Logical delivery revision is database owned' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER advance_sync_delivery_revision BEFORE UPDATE ON mirror.catalog_import_executions
  FOR EACH ROW EXECUTE FUNCTION mirror.advance_sync_delivery_revision();

CREATE SEQUENCE mirror.sync_dispatch_fairness_sequence;
CREATE TABLE mirror.sync_dispatch_shops (
  shop_id text PRIMARY KEY REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  last_served bigint NOT NULL DEFAULT 0 CHECK(last_served>=0)
);
CREATE TABLE mirror.sync_dispatch_deliveries (
  id text PRIMARY KEY, shop_id text NOT NULL, run_id text NOT NULL, generation_id text NOT NULL,
  delivery_revision bigint NOT NULL CHECK(delivery_revision>=0),
  kind text NOT NULL CHECK(kind IN ('SYNC','RECOVERY')),
  delivery_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('RESERVED','UNCERTAIN','DISPATCHED','EXPIRED','SUPERSEDED')),
  reservation_token text NOT NULL, reservation_fence bigint NOT NULL CHECK(reservation_fence>0),
  reserved_until timestamptz(3) NOT NULL, job_id text, last_error text,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(shop_id,run_id,delivery_revision,kind),
  FOREIGN KEY(shop_id,run_id,generation_id) REFERENCES mirror.catalog_import_executions(shop_id,id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX sync_dispatch_expiry ON mirror.sync_dispatch_deliveries(reserved_until,id);
CREATE FUNCTION mirror.guard_sync_dispatch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.shop_id,OLD.run_id,OLD.generation_id,OLD.delivery_revision,OLD.kind,OLD.delivery_key)
    IS DISTINCT FROM (NEW.id,NEW.shop_id,NEW.run_id,NEW.generation_id,NEW.delivery_revision,NEW.kind,NEW.delivery_key)
    OR NEW.reservation_fence<OLD.reservation_fence
    OR (NEW.reservation_token<>OLD.reservation_token AND NEW.reservation_fence<=OLD.reservation_fence)
    OR (NEW.reservation_token<>OLD.reservation_token AND OLD.reserved_until>clock_timestamp())
    OR (NEW.reservation_fence>OLD.reservation_fence AND NEW.reservation_token=OLD.reservation_token)
    OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id) THEN
    RAISE EXCEPTION 'Dispatch identity and fencing are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sync_dispatch_identity BEFORE UPDATE ON mirror.sync_dispatch_deliveries
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_dispatch_identity();
COMMIT;
