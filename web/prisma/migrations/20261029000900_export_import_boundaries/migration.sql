CREATE TABLE mirror.import_previews (
  id text PRIMARY KEY,shop_id text NOT NULL,snapshot_id text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','APPROVED')),
  payload jsonb NOT NULL,canonical_preview text NOT NULL,preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now(),expires_at timestamptz(3) NOT NULL,
  contract_id text,approved_by text,approved_at timestamptz(3),
  UNIQUE(shop_id,id),FOREIGN KEY(shop_id,snapshot_id) REFERENCES mirror.selection_snapshots(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,contract_id) REFERENCES mirror.execution_contracts(shop_id,id) ON DELETE RESTRICT,
  CHECK(status<>'APPROVED' OR (contract_id IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE FUNCTION mirror.guard_import_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.snapshot_id,NEW.payload,NEW.canonical_preview,NEW.preview_hash,NEW.created_by,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.snapshot_id,OLD.payload,OLD.canonical_preview,OLD.preview_hash,OLD.created_by,OLD.created_at,OLD.expires_at)
    OR (OLD.status='APPROVED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Import preview is immutable' USING ERRCODE='23514';
  END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_import_preview BEFORE UPDATE ON mirror.import_previews FOR EACH ROW EXECUTE FUNCTION mirror.guard_import_preview();

CREATE TABLE mirror.export_jobs (
  id text PRIMARY KEY,shop_id text NOT NULL,command_id bigint NOT NULL,
  installation_version text NOT NULL,generation_id text NOT NULL,coverage_revision text NOT NULL,mapping_version text NOT NULL,snapshot_id text NOT NULL,
  read_lease_id text NOT NULL,format text NOT NULL CHECK(format IN('jsonl','csv')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','WRITING','RETRY','READY','FAILED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),fence bigint NOT NULL DEFAULT 0,
  lease_token text,lease_until timestamptz(3),next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  artifact_key text,sha256 text,byte_length bigint,row_count bigint,last_error text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE(shop_id,id),UNIQUE(shop_id,command_id,format),
  FOREIGN KEY(shop_id,command_id) REFERENCES mirror.job_commands(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,snapshot_id) REFERENCES mirror.selection_snapshots(shop_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(shop_id,generation_id,coverage_revision,mapping_version) REFERENCES mirror.generations(shop_id,id,coverage_revision,mapping_version) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK(status<>'WRITING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK(status<>'READY' OR (artifact_key IS NOT NULL AND sha256 IS NOT NULL AND byte_length IS NOT NULL AND row_count IS NOT NULL))
);
CREATE FUNCTION mirror.guard_export_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.command_id,NEW.installation_version,NEW.generation_id,NEW.coverage_revision,NEW.mapping_version,NEW.read_lease_id,NEW.snapshot_id,NEW.format,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.shop_id,OLD.command_id,OLD.installation_version,OLD.generation_id,OLD.coverage_revision,OLD.mapping_version,OLD.read_lease_id,OLD.snapshot_id,OLD.format,OLD.created_at)
    OR (OLD.status IN('READY','CANCELLED') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Export pins and completed artifacts are immutable' USING ERRCODE='23514';
  END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_export_job BEFORE UPDATE ON mirror.export_jobs FOR EACH ROW EXECUTE FUNCTION mirror.guard_export_job();

CREATE FUNCTION mirror.guard_active_read_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='DELETE' OR NEW.status::text IN('RETIRED','FAILED')) AND EXISTS(
    SELECT 1 FROM mirror.generation_read_leases l WHERE l.shop_id=OLD.shop_id AND l.generation_id=OLD.id AND l.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Active read leases retain the published generation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER guard_active_read_retention BEFORE UPDATE OR DELETE ON mirror.generations FOR EACH ROW EXECUTE FUNCTION mirror.guard_active_read_retention();
