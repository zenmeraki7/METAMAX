ALTER TABLE mirror.execution_contracts ADD COLUMN hash_version text NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE mirror.execution_contracts ADD COLUMN canonical_contract text;
ALTER TABLE mirror.execution_contracts ADD CONSTRAINT approval_hash_representation CHECK (
  (hash_version='legacy-v1' AND canonical_contract IS NULL) OR
  (hash_version='canonical-v2' AND canonical_contract IS NOT NULL
    AND canonical_contract::jsonb->'contract'=contract
    AND canonical_contract::jsonb->>'shopId'=shop_id
    AND canonical_contract::jsonb->>'snapshotId'=snapshot_id
    AND canonical_contract::jsonb->>'operation'=operation
    AND canonical_contract::jsonb->>'approvedBy'=approved_by));

CREATE TABLE mirror.schedule_occurrences (
  id text PRIMARY KEY,
  shop_id text NOT NULL,
  schedule_id bigint NOT NULL,
  scheduled_for timestamptz(3) NOT NULL,
  template jsonb NOT NULL,
  operation text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','RETRY','SUCCEEDED','FAILED','CANCELLED')),
  phase text NOT NULL DEFAULT 'SELECT' CHECK(phase IN('SELECT','APPROVE','DISPATCH','DONE')),
  snapshot_id text,
  contract_id text,
  command_id bigint,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
  lease_token text,
  lease_until timestamptz(3),
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(shop_id,id),
  UNIQUE(shop_id,schedule_id,scheduled_for),
  FOREIGN KEY(shop_id,schedule_id) REFERENCES mirror.job_schedules(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,snapshot_id) REFERENCES mirror.selection_snapshots(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,contract_id) REFERENCES mirror.execution_contracts(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,command_id) REFERENCES mirror.job_commands(shop_id,id) ON DELETE RESTRICT,
  CHECK(status<>'RUNNING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(phase='SELECT' OR snapshot_id IS NOT NULL),
  CHECK(phase NOT IN('DISPATCH','DONE') OR contract_id IS NOT NULL),
  CHECK(phase<>'DONE' OR command_id IS NOT NULL)
);
CREATE INDEX schedule_occurrences_due ON mirror.schedule_occurrences(status,next_attempt_at,lease_until);
CREATE FUNCTION mirror.guard_schedule_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.schedule_id,NEW.scheduled_for,NEW.template,NEW.operation,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.schedule_id,OLD.scheduled_for,OLD.template,OLD.operation,OLD.created_at)
    OR (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id)
    OR (OLD.contract_id IS NOT NULL AND NEW.contract_id IS DISTINCT FROM OLD.contract_id)
    OR (OLD.command_id IS NOT NULL AND NEW.command_id IS DISTINCT FROM OLD.command_id)
    OR (OLD.status IN('SUCCEEDED','CANCELLED') AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Schedule occurrence identity and checkpoints are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_schedule_occurrence BEFORE UPDATE ON mirror.schedule_occurrences
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_schedule_occurrence();
