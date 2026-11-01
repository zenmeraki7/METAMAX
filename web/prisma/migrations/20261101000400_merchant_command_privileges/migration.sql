-- Merchant dispatch may create work and request cancellation. Claiming, worker
-- outcomes, outbox publication and deletion of dispatch evidence are worker or
-- separately authorized maintenance responsibilities.
REVOKE UPDATE,DELETE ON mirror.job_commands FROM metamax_engine_runtime;
GRANT UPDATE(cancel_requested_at,updated_at) ON mirror.job_commands TO metamax_engine_runtime;
REVOKE UPDATE,DELETE ON mirror.outbox_events FROM metamax_engine_runtime;
REVOKE UPDATE,DELETE ON mirror.edit_operations FROM metamax_engine_runtime;
GRANT UPDATE(_history_lock) ON mirror.edit_operations TO metamax_engine_runtime;
