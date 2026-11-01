-- Reinstall cleanup removes the old installation's billing cache before rotation.
-- DELETE remains tenant-scoped by the existing subscription RLS policy.
-- History sends are fenced by definer-owned triggers, not a callable grant.
BEGIN;
GRANT DELETE ON mirror.subscriptions TO metamax_catalog_worker;
GRANT SELECT(shop_id) ON mirror.subscriptions TO metamax_catalog_worker;
REVOKE EXECUTE ON FUNCTION mirror.assert_catalog_edit_ready(text) FROM metamax_history_runtime;
COMMIT;
