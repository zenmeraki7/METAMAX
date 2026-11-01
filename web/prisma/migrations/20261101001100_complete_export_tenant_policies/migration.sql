-- Repair incremental deployments where export tables followed runtime_tenant_rls.
-- Authority: migration owner only. No data changes or new runtime privileges.
-- Atomic and replay-safe: preserve existing policies; reject incompatible ones.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE t regclass; p record; BEGIN
 FOREACH t IN ARRAY ARRAY['export_engine.jobs'::regclass,'export_engine.target_approvals'::regclass] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  SELECT * INTO p FROM pg_policy WHERE polrelid=t AND polname='metamax_tenant_isolation';
  IF FOUND THEN
   IF NOT p.polpermissive OR p.polcmd<>'*' OR p.polroles<>ARRAY[0::oid]
    OR pg_get_expr(p.polqual,t) IS DISTINCT FROM '(shop_id = current_setting(''app.shop_id''::text, true))'
    OR pg_get_expr(p.polwithcheck,t) IS DISTINCT FROM '(shop_id = current_setting(''app.shop_id''::text, true))' THEN
    RAISE EXCEPTION 'Incompatible export tenant policy on %',t USING ERRCODE='55000';
   END IF;
  ELSE
   EXECUTE format('CREATE POLICY metamax_tenant_isolation ON %s USING(shop_id=current_setting(''app.shop_id'',true)) WITH CHECK(shop_id=current_setting(''app.shop_id'',true))',t);
  END IF;
 END LOOP;
END $$;
COMMIT;
