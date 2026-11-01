-- Expand only the explicit undo identity allowlist; preserve immutable targets.
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT undo_requests_resource_gid_check;
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT undo_requests_resource_gid_check
 CHECK(resource_gid IS NULL OR resource_gid ~ '^gid://shopify/(Product|ProductVariant)/[1-9][0-9]*$');
