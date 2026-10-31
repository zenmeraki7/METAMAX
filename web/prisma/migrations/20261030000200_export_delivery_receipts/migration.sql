-- Evidence survives BullMQ cleanup or Redis data loss. It proves observation,
-- not successful execution; only the export job/checkpoint/artifact proves that.
CREATE TABLE export_engine.delivery_receipts (
  event_id uuid PRIMARY KEY REFERENCES export_engine.outbox(id) ON DELETE RESTRICT,
  delivery_key uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES export_engine.jobs(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER export_receipts_immutable BEFORE UPDATE OR DELETE ON export_engine.delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION export_engine.immutable_record();

CREATE TABLE export_engine.target_approvals (
  shop_id text NOT NULL,
  snapshot_id text NOT NULL,
  generation_id text NOT NULL,
  coverage_revision text NOT NULL,
  mapping_version text NOT NULL,
  selection_hash text NOT NULL,
  datasets text[] NOT NULL CHECK(cardinality(datasets)>0 AND cardinality(datasets)<=32),
  -- Historical approval data must not create a permanent generation hold after
  -- selection expiry. Every execution re-joins and verifies the live approved
  -- snapshot under the publication barrier; this row alone is not authority.
  PRIMARY KEY(shop_id,snapshot_id)
);
CREATE TRIGGER export_target_immutable BEFORE UPDATE OR DELETE ON export_engine.target_approvals
  FOR EACH ROW EXECUTE FUNCTION export_engine.immutable_record();

CREATE FUNCTION export_engine.guard_outbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.job_id,NEW.delivery_key,NEW.payload,NEW.event_type,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.job_id,OLD.delivery_key,OLD.payload,OLD.event_type,OLD.created_at) OR NEW.fence_epoch<OLD.fence_epoch THEN
    RAISE EXCEPTION 'Export delivery identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_outbox_identity BEFORE UPDATE ON export_engine.outbox
  FOR EACH ROW EXECUTE FUNCTION export_engine.guard_outbox_identity();
