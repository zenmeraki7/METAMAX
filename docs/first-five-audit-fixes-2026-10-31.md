# First five audit fixes — 2026-10-31

Implemented against the current working tree. Existing unrelated edits were preserved. Follow-up: the refresh-request migration is now applied to the configured application database; see [deployment verification](catalog-refresh-deployment-20261031.md). Application processes were not restarted.

## Changes

1. **Atomic webhook fan-out:** `recordWebhookEvent` commits the delivery receipt, all unique product journal entries, dirty revisions, and refresh intent in one transaction. Duplicate deliveries return without incrementing product or refresh revisions. A failed later product rolls back the entire delivery.
2. **Refresh after publication:** the running catalog-import scheduler scans durable `catalog_refresh_requests` and atomically allocates requests into the existing import pipeline. Allocation acknowledges the exact requested revision in the same transaction. Requests arriving during active imports remain pending for another generation. Existing import leases, cancellation, bounded retries, installation checks, reconciliation fences, and publication gates remain authoritative. Published generations remain immutable.
3. **Opaque history authentication:** history routes pass the actual opaque authentication context into the read service. Tenant identity is resolved through authentication capabilities and active installation storage, never object properties or browser parameters.
4. **Inventory events:** no guessed inventory-item relation is queried. Related inventory events atomically persist a full catalog refresh even when no product IDs are available. Persistence failures roll back the receipt and fail delivery, allowing retry.
5. **History authorization and lifecycle:** HTTP list, detail, and changes routes use the existing protected repository paging implementation. Reads bind to the active shop and installation, enforce independent history metadata-read authorization, revalidate permission, and exclude purged operations. The default policy requires product-read app scope and, for online sessions, the staff member's own product-read scope. A server-owned `authorizeHistoryRead` hook supports stricter application RBAC. These routes expose metadata, not sensitive snapshot values. Signed cursors bind to the shop, installation, and read action and preserve timestamp ties.

## Migration and rollout

`web/prisma/migrations/20261031120000_catalog_refresh_requests/migration.sql` is applied to the configured application database. Startup verifies that the new storage exists. Twelve other pre-existing pending migrations remain unchanged.

The migration creates a coalescing refresh-request table with revision and retry constraints and a partial due-work index. It seeds one catch-up request for every active published shop, plus active shops with dirty products. This repairs previously acknowledged inventory events and partial fan-outs that may no longer have discoverable dirty rows.

Refresh requests belong to an installation. Stale requests cannot schedule imports for a new installation. A new verified delivery resets counters for the current installation. Scheduler allocation failures use persistent bounded backoff; allocated imports retain the existing import retry/review behavior.

The implementation deliberately reuses **full catalog imports** for refreshes. This preserves generation consistency and avoids inventing an incomplete incremental copy/publish protocol. Frequent changes can therefore incur additional Shopify bulk-export and database work. A later incremental implementation should preserve the same durable event/revision and immutable-publication guarantees.

History cursors use `HISTORY_CURSOR_SECRET`, falling back to `FILTER_CURSOR_SECRET` or `SHOPIFY_API_SECRET`; the key must contain at least 32 bytes. Additional application-specific history RBAC can be supplied through the read-service authorization hook. Existing opaque authentication remains mandatory.

## Verification

- `npm test`: **1,041 passed**, zero failures, one existing TODO.
- Disposable local PostgreSQL 17.10 with all checked-in migrations: **153 checks passed**. No application `DATABASE_URL` was used.
- Frontend product tests: **38 passed**; frontend UI tests: **17 passed**.
- Prisma schema validation: passed.

New PostgreSQL regressions cover concurrent duplicate event delivery, all-or-nothing fan-out, retry after rollback, post-publication product refresh, unmapped inventory refresh, preservation of the old published snapshot, events during active imports, installation replacement, genuine opaque HTTP authentication, denied read permission, cross-shop/old-installation isolation, purge visibility, and signed pagination with timestamp ties.

The schema test's pre-existing subscription foreign-key assertion now accepts PostgreSQL's two applicable SQLSTATEs (`23001`/`23503`) while requiring the exact expected constraint. Both indicate the prohibited installation change was rejected; this allows the suite to run on the available PostgreSQL 17 runtime.

## Remaining audit work

The secondary reconciliation repository's late acknowledgment, global publication-lock contention, canonical `UNLISTED` drift, expensive status counts, frontend demo-history/export behavior, unsupported filter-picker capabilities, boolean coercion, and fabricated sync-source health remain separate findings. These fixes do not claim those remaining issues are resolved.
