BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;
ALTER TABLE mirror.sync_dispatches
  ADD COLUMN consumed_fence bigint CHECK(consumed_fence>0),
  ADD COLUMN consumed_lease_token text,
  ADD COLUMN recovery_fence bigint NOT NULL DEFAULT 0 CHECK(recovery_fence>=0);
CREATE INDEX sync_dispatch_consumed_idx ON mirror.sync_dispatches(updated_at,id) WHERE state='CONSUMED';
CREATE FUNCTION mirror.guard_sync_dispatch_recovery_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recovery_fence<OLD.recovery_fence OR
    (NEW.recovery_token IS NOT NULL AND NEW.recovery_token IS DISTINCT FROM OLD.recovery_token
      AND NEW.recovery_fence<=OLD.recovery_fence) OR
    (NEW.recovery_fence>OLD.recovery_fence AND NEW.recovery_token IS NULL) THEN
    RAISE EXCEPTION 'Delivery recovery requires a monotonic fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sync_dispatch_recovery_fence BEFORE UPDATE ON mirror.sync_dispatches
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_dispatch_recovery_fence();
COMMIT;
