-- Lock carrier grants permit SELECT FOR SHARE, never publication-coordinate writes.
ALTER TABLE mirror.publications ADD COLUMN _history_lock integer NOT NULL DEFAULT 0;
GRANT UPDATE(_history_lock) ON mirror.publications TO metamax_history_runtime,metamax_engine_runtime,metamax_operation_worker;
