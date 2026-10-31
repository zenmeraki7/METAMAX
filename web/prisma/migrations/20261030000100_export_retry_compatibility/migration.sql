-- Existing RETRY_WAIT rows default to unverified and must pass recovery.
ALTER TABLE export_engine.jobs ADD COLUMN retry_verified boolean NOT NULL DEFAULT false;
CREATE INDEX export_jobs_unverified_retry_due ON export_engine.jobs(next_attempt_at,id)
  WHERE state='RETRY_WAIT' AND NOT retry_verified;

-- Keep the database guard aligned with the recovery extension to Contract V2.
CREATE OR REPLACE FUNCTION export_engine.guard_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.installation_id,NEW.idempotency_key,NEW.request_fingerprint,NEW.manifest_fingerprint,
      NEW.contract_version,NEW.manifest_version,NEW.manifest,NEW.generation_id,NEW.coverage_revision,NEW.mapping_version,
      NEW.compiler_version,NEW.generation_lease_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.shop_id,OLD.installation_id,OLD.idempotency_key,OLD.request_fingerprint,OLD.manifest_fingerprint,
      OLD.contract_version,OLD.manifest_version,OLD.manifest,OLD.generation_id,OLD.coverage_revision,OLD.mapping_version,
      OLD.compiler_version,OLD.generation_lease_id,OLD.created_at)
     OR NEW.fence_epoch<OLD.fence_epoch OR NEW.checkpoint_version<OLD.checkpoint_version
     OR (OLD.generation_protection_released_at IS NOT NULL AND
       (NEW.generation_protection_released_at,NEW.generation_release_reason) IS DISTINCT FROM
       (OLD.generation_protection_released_at,OLD.generation_release_reason))
  THEN RAISE EXCEPTION 'Export identity or monotonic state changed' USING ERRCODE='23514'; END IF;
  IF OLD.state IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') AND
    (to_jsonb(NEW)-'state'-'generation_protection_released_at'-'generation_release_reason') IS DISTINCT FROM
    (to_jsonb(OLD)-'state'-'generation_protection_released_at'-'generation_release_reason')
  THEN RAISE EXCEPTION 'Terminal export execution is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='PENDING' AND NEW.state IN ('VALIDATING','CANCELLING','FAILED')) OR
    (OLD.state='VALIDATING' AND NEW.state IN ('WAITING_FOR_CAPACITY','QUEUED','CANCELLING','FAILED')) OR
    (OLD.state='WAITING_FOR_CAPACITY' AND NEW.state IN ('QUEUED','CANCELLING','FAILED')) OR
    (OLD.state='QUEUED' AND NEW.state IN ('RUNNING','FINALIZING','RETRY_WAIT','CANCELLING','FAILED')) OR
    (OLD.state='RUNNING' AND NEW.state IN ('FINALIZING','RETRY_WAIT','RECOVERING','CANCELLING','FAILED')) OR
    (OLD.state='FINALIZING' AND NEW.state IN ('COMPLETED','RETRY_WAIT','RECOVERING','CANCELLING','FAILED')) OR
    (OLD.state='RECOVERING' AND NEW.state IN ('RETRY_WAIT','REVIEW_REQUIRED','CANCELLING','FAILED')) OR
    (OLD.state='RETRY_WAIT' AND NEW.state IN ('QUEUED','RECOVERING','CANCELLING','FAILED')) OR
    (OLD.state='REVIEW_REQUIRED' AND NEW.state IN ('CANCELLING','FAILED')) OR
    (OLD.state='CANCELLING' AND NEW.state IN ('CANCELLED','FAILED')) OR
    (OLD.state='COMPLETED' AND NEW.state='EXPIRED'))
  THEN RAISE EXCEPTION 'Invalid export lifecycle transition' USING ERRCODE='23514'; END IF;
  IF OLD.state='RETRY_WAIT' AND NEW.state='QUEUED' AND NOT OLD.retry_verified THEN
    RAISE EXCEPTION 'Retry requires verified recovery evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
