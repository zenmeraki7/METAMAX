CREATE TABLE mirror.operation_finalizations(
 shop_id text NOT NULL,command_id bigint NOT NULL,installation_version text NOT NULL,execution_fence bigint NOT NULL,
 item_id bigint,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','RUNNING','RETRY','REVIEW_REQUIRED','SUCCEEDED')),
 history_pending boolean NOT NULL DEFAULT true,undo_pending boolean NOT NULL DEFAULT false,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),fence bigint NOT NULL DEFAULT 0,
 lease_token text,lease_until timestamptz(3),next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),last_error text,
 updated_at timestamptz(3) NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,command_id),
 FOREIGN KEY(shop_id,command_id) REFERENCES mirror.job_commands(shop_id,id) ON DELETE CASCADE,
 FOREIGN KEY(shop_id,item_id) REFERENCES mirror.job_items(shop_id,id) ON DELETE CASCADE,
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),CHECK(state<>'SUCCEEDED' OR(NOT history_pending AND NOT undo_pending))
);
CREATE INDEX operation_finalization_due ON mirror.operation_finalizations(state,next_attempt_at,lease_until);
ALTER TABLE mirror.operation_finalizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY metamax_tenant_isolation ON mirror.operation_finalizations USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
-- Reviewed worker-only control-plane discovery; no browser query binding exists.
CREATE POLICY metamax_control_plane ON mirror.operation_finalizations TO metamax_engine_runtime USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON mirror.operation_finalizations TO metamax_engine_runtime;
CREATE INDEX operation_finalization_command_scan ON mirror.job_commands(kind,status,id);
