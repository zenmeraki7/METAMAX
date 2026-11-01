ALTER TABLE mirror.outbox_events ADD COLUMN review_required boolean NOT NULL DEFAULT false;
ALTER TABLE mirror.outbox_events ADD COLUMN last_error text;
UPDATE mirror.outbox_events SET review_required=true,last_error='DISPATCH_RETRY_EXHAUSTED' WHERE dispatched_at IS NULL AND attempts>=8;
ALTER TABLE mirror.catalog_refresh_requests ADD COLUMN review_required boolean NOT NULL DEFAULT false;
ALTER TABLE mirror.catalog_refresh_requests ADD COLUMN last_error text;
UPDATE mirror.catalog_refresh_requests SET review_required=true,last_error='REFRESH_RETRY_EXHAUSTED' WHERE requested_revision>scheduled_revision AND attempts>=8;
GRANT UPDATE(review_required,last_error,attempts,available_at,fence,lease_token,lease_until) ON mirror.outbox_events TO metamax_engine_runtime;
-- Catalog review recovery emits a tenant-scoped append-only audit entry.
GRANT INSERT ON mirror.audit_events TO metamax_catalog_worker;
GRANT USAGE,SELECT ON SEQUENCE mirror.audit_events_id_seq TO metamax_catalog_worker;
