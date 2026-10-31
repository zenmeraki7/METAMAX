-- Export installation IDs are immutable historical fences, not permanent
-- references to a mutable current-installation value. Keeping the composite FK
-- would make reinstall impossible while any historical export job exists.
-- Admission/claims/reads still require the exact active installation in SQL.
ALTER TABLE export_engine.jobs DROP CONSTRAINT jobs_shop_id_installation_id_fkey;
ALTER TABLE export_engine.jobs ADD CONSTRAINT jobs_shop_id_fkey
  FOREIGN KEY(shop_id) REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE mirror.export_manifest_jobs DROP CONSTRAINT export_manifest_jobs_shop_id_installation_id_fkey;
ALTER TABLE mirror.export_manifest_jobs ADD CONSTRAINT export_manifest_jobs_shop_id_fkey
  FOREIGN KEY(shop_id) REFERENCES mirror.shops(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
