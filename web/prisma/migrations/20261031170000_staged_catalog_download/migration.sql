-- Ingestion spool. Never queried by browser-facing filter compilation.
CREATE TABLE mirror.catalog_downloads (
 shop_id text NOT NULL, run_id bigint NOT NULL, generation_id text NOT NULL,
 operation_id text NOT NULL,url_hash text NOT NULL,etag text NOT NULL,total_bytes bigint NOT NULL CHECK(total_bytes>=0),
 next_byte bigint NOT NULL DEFAULT 0 CHECK(next_byte>=0),line_count bigint NOT NULL DEFAULT 0 CHECK(line_count>=0),
 pending bytea NOT NULL DEFAULT ''::bytea CHECK(octet_length(pending)<=1048576),complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(shop_id,run_id),FOREIGN KEY(shop_id,run_id) REFERENCES mirror.ingestion_runs(shop_id,id) ON DELETE CASCADE,FOREIGN KEY(shop_id,generation_id) REFERENCES mirror.generations(shop_id,id) ON DELETE CASCADE,
 CHECK(next_byte<=total_bytes),CHECK(NOT complete OR(next_byte=total_bytes AND octet_length(pending)=0))
);
CREATE TABLE mirror.catalog_download_chunks (
 shop_id text NOT NULL,run_id bigint NOT NULL,byte_start bigint NOT NULL CHECK(byte_start>=0),byte_end bigint NOT NULL,
 line_start bigint NOT NULL,line_count integer NOT NULL CHECK(line_count>=0),lines jsonb NOT NULL,
 checksum text NOT NULL,source_checksum text NOT NULL,
 PRIMARY KEY(shop_id,run_id,byte_start),FOREIGN KEY(shop_id,run_id) REFERENCES mirror.catalog_downloads(shop_id,run_id) ON DELETE CASCADE,
 CHECK(byte_end>=byte_start),CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines)=line_count)
);
CREATE INDEX catalog_download_line_seek ON mirror.catalog_download_chunks(shop_id,run_id,line_start);
ALTER TABLE mirror.catalog_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.catalog_download_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY metamax_tenant_isolation ON mirror.catalog_downloads USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
CREATE POLICY metamax_tenant_isolation ON mirror.catalog_download_chunks USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON mirror.catalog_downloads,mirror.catalog_download_chunks TO metamax_engine_runtime;

-- Completed input and chunk checksums are durable evidence, not mutable cache.
CREATE FUNCTION mirror.guard_catalog_download() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM mirror.ingestion_runs WHERE shop_id=OLD.shop_id AND id=OLD.run_id)
   AND EXISTS(SELECT 1 FROM mirror.generations WHERE shop_id=OLD.shop_id AND id=OLD.generation_id
    AND(status NOT IN('FAILED','RETIRED') OR retain_until IS NULL OR retain_until>clock_timestamp())) THEN
   RAISE EXCEPTION 'Staged input remains retained' USING ERRCODE='23514';
  END IF;RETURN OLD;
 END IF;
 IF (NEW.shop_id,NEW.run_id,NEW.generation_id,NEW.operation_id,NEW.url_hash,NEW.etag,NEW.total_bytes)
   IS DISTINCT FROM (OLD.shop_id,OLD.run_id,OLD.generation_id,OLD.operation_id,OLD.url_hash,OLD.etag,OLD.total_bytes)
   OR(OLD.complete AND NEW IS DISTINCT FROM OLD)
   OR NEW.next_byte<OLD.next_byte OR NEW.line_count<OLD.line_count THEN
  RAISE EXCEPTION 'Staged source identity and progress are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_catalog_download BEFORE UPDATE OR DELETE ON mirror.catalog_downloads FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_download();
CREATE FUNCTION mirror.guard_catalog_download_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Staged chunks are immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM mirror.catalog_downloads d JOIN mirror.generations g ON g.shop_id=d.shop_id AND g.id=d.generation_id
   WHERE d.shop_id=OLD.shop_id AND d.run_id=OLD.run_id
    AND(g.status NOT IN('FAILED','RETIRED') OR g.retain_until IS NULL OR g.retain_until>clock_timestamp())) THEN
   RAISE EXCEPTION 'Staged chunks remain retained' USING ERRCODE='23514';
  END IF;RETURN OLD;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM mirror.catalog_downloads d WHERE d.shop_id=NEW.shop_id AND d.run_id=NEW.run_id
  AND NOT d.complete AND d.next_byte=NEW.byte_start AND d.line_count=NEW.line_start)
  OR NEW.checksum !~ '^[a-f0-9]{64}$' OR NEW.source_checksum !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Exact staged input boundary required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_catalog_download_chunk BEFORE INSERT OR UPDATE OR DELETE ON mirror.catalog_download_chunks FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_download_chunk();
