ALTER TABLE mirror.schedule_occurrences DROP CONSTRAINT IF EXISTS schedule_occurrences_status_check;
ALTER TABLE mirror.schedule_occurrences ADD CONSTRAINT schedule_occurrences_status_check
  CHECK (status IN ('QUEUED','RUNNING','RETRY','DISPATCHED','EXECUTING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','REVIEW_REQUIRED'));

CREATE OR REPLACE FUNCTION mirror.guard_schedule_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.schedule_id,NEW.scheduled_for,NEW.template,NEW.operation,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.schedule_id,OLD.scheduled_for,OLD.template,OLD.operation,OLD.created_at)
    OR (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
    OR (OLD.contract_id IS NOT NULL AND NEW.contract_id IS DISTINCT FROM OLD.contract_id)
    OR (OLD.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id)
    OR (OLD.status IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED','REVIEW_REQUIRED') AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Schedule occurrence identity and checkpoints are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

