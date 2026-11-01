-- Historical rows have no trustworthy installation provenance. Never attach
-- them retroactively to the shop's current installation.
ALTER TABLE mirror.selection_snapshots ADD COLUMN installation_version text;
ALTER TABLE mirror.selection_snapshots ADD COLUMN target_mode text CHECK(target_mode IN('EXPLICIT','ALL_MATCHING','ALL_MATCHING_WITH_EXCLUSIONS'));
ALTER TABLE mirror.job_schedules ADD COLUMN installation_version text;
ALTER TABLE mirror.schedule_occurrences ADD COLUMN installation_version text;
ALTER TABLE mirror.schedule_occurrences ADD COLUMN execution_result jsonb;
UPDATE mirror.job_schedules SET enabled=false WHERE installation_version IS NULL;
UPDATE mirror.schedule_occurrences SET status='REVIEW_REQUIRED',lease_token=NULL,lease_until=NULL,
 last_error='INSTALLATION_PROVENANCE_MISSING' WHERE status NOT IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED','REVIEW_REQUIRED');

CREATE FUNCTION mirror.bind_execution_installation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_version text; schedule_version text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.installation_version IS DISTINCT FROM OLD.installation_version THEN
   RAISE EXCEPTION 'Execution installation is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='schedule_occurrences' THEN
   IF (NEW.shop_id,NEW.schedule_id,NEW.scheduled_for,NEW.template,NEW.operation) IS DISTINCT FROM
      (OLD.shop_id,OLD.schedule_id,OLD.scheduled_for,OLD.template,OLD.operation) THEN
    RAISE EXCEPTION 'Occurrence identity and instructions are immutable' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 SELECT installation_version INTO current_version FROM mirror.shops WHERE id=NEW.shop_id AND uninstalled_at IS NULL FOR SHARE;
 IF current_version IS NULL THEN RAISE EXCEPTION 'Current installation required' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='schedule_occurrences' THEN
  SELECT installation_version INTO schedule_version FROM mirror.job_schedules WHERE shop_id=NEW.shop_id AND id=NEW.schedule_id FOR SHARE;
  IF schedule_version IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'Schedule installation changed' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.installation_version=COALESCE(NEW.installation_version,current_version);
 IF NEW.installation_version IS DISTINCT FROM current_version THEN RAISE EXCEPTION 'Execution installation changed' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='selection_snapshots' THEN NEW.target_mode=COALESCE(NEW.target_mode,'EXPLICIT'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_selection_installation BEFORE INSERT OR UPDATE ON mirror.selection_snapshots FOR EACH ROW EXECUTE FUNCTION mirror.bind_execution_installation();
CREATE TRIGGER bind_schedule_installation BEFORE INSERT OR UPDATE ON mirror.job_schedules FOR EACH ROW EXECUTE FUNCTION mirror.bind_execution_installation();
CREATE TRIGGER bind_occurrence_installation BEFORE INSERT OR UPDATE ON mirror.schedule_occurrences FOR EACH ROW EXECUTE FUNCTION mirror.bind_execution_installation();

-- Global discovery is worker-only. Merchant phase execution keeps tenant scope.
GRANT SELECT,UPDATE(next_run_at,last_run_at,fence,enabled) ON mirror.job_schedules TO metamax_operation_worker;
GRANT SELECT,INSERT,UPDATE ON mirror.schedule_occurrences TO metamax_operation_worker;
CREATE POLICY metamax_operation_control ON mirror.job_schedules TO metamax_operation_worker USING(true) WITH CHECK(true);
CREATE POLICY metamax_operation_control ON mirror.schedule_occurrences TO metamax_operation_worker USING(true) WITH CHECK(true);
