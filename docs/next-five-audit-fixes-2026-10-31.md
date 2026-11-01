# Audit fixes 6–10 — 2026-10-31

These fixes are implemented locally. The original findings in `code-audit-2026-10-31.md` describe the pre-fix implementation.

## 6. Revision-safe secondary reconciliation

`reconciliation-repository.server.js` conditionally acknowledges the observed revision, dirty state, worker fence, lease token and live lease **before** deleting or replacing mirror rows. A failed acknowledgment returns without changing the mirror. Mirror writes and the generation receipt remain in the same transaction, so a later failure rolls back the acknowledgment. Existing retry handling covers PostgreSQL conflicts and Prisma P2002/P2034.

Real PostgreSQL regressions expire the lease between the initial checks and acknowledgment, verify that no mirror write occurs, and inject a mirror failure after acknowledgment to verify rollback of the dirty/applied state and receipt.

## 7. Tenant publication locking and bounded selection

`publication-lock.server.js` provides transaction-scoped shared/exclusive advisory locks keyed by authenticated shop. It uses one server-owned hash namespace consistently across catalog readers, publication, ingestion, reconciliation, synchronization, selection, generation retention/reclamation, exports and privacy cleanup. A compatible ACCESS SHARE table lock remains as a DDL fence; ordinary runtime writers no longer acquire global ACCESS EXCLUSIVE publication locks.

Protected catalog transactions and phase execution use READ COMMITTED, taking their protected data snapshots **after** any advisory-lock wait. The held tenant lock, immutable published generations, pinned generation/coverage and repeated authorization checks preserve the approved target throughout pagination. The generic synchronization transaction helper retains its Serializable default; catalog phase execution explicitly opts into ReadCommitted. Locks end with the transaction and work with transaction-pooled connections.

Selection has a 30-second overall materialization/final-authorization deadline, trusted AbortSignal cancellation, per-statement and lock timeouts, an idle-transaction timeout, rollback on interruption, and a client facade that rejects writes after scope expiry. Single products with more than eight variants now use the existing bounded JSONB batch writer rather than one awaited insert per variant.

PostgreSQL regressions prove that another shop can acquire protection while a writer is active, same-shop writes remain blocked, a waiting reader sees the writer's committed state, locks disappear at transaction completion, and selection timeout/cancellation rolls back membership work and rejects late queries. Existing multi-page selection, schema drift, publication, ingestion, privacy and export checks remain enabled.

**Rollout requirement:** stop/drain the old app and worker instances, then start all instances on this implementation together. A mixed deployment would combine old readers that know only the table barrier with new writers that use tenant advisory locks. Do not perform a rolling mixed-version deployment. No new database schema migration is required.

## 8. Canonical UNLISTED status

Canonical status constraints now include UNLISTED for reads, filtering and writes. Constraint registry version advances from 3 to 4, so incompatible frozen contracts fail closed and must be recreated/reapproved. Tests cover canonical normalization, filter operands, write operands, rejection of unknown statuses, and the mounted authenticated catalog HTTP route.

The Shopify AI Toolkit confirmed UNLISTED against the configured Admin API 2026-10 and schema-validated a productUpdate mutation using this status. No Shopify mutation was executed.

## 9. Status/count execution without product projection

The private compiler now issues distinct catalog_status and catalog_count capabilities. Both retain field authorization, physical-schema proof, tenant/generation bindings, current coverage checks and execution-time revalidation. Status executes no product/variant projection or aggregate. Count executes only its compiler-owned filtered count query. Cursors are rejected for these modes. Product listing behavior remains unchanged.

Mounted HTTP tests record the SQL: repeated status requests execute no product/variant scans, count requests execute one filtered aggregate without loading product projections, and revoked scope prevents status access.

## 10. Live history consistency

History statistics and CSV exports use the loaded records and current filters. The hook adapts processedCount/totalCount into the progress fields used by the UI/export. Empty live results remain empty; request failures expose an error and retry action. Requests abort on reload/unmount, malformed responses fail closed, and demo data requires an explicit demo setting. Fabricated growth metrics and the misleading retry-success toast are removed. Export is labelled as the loaded filtered history, rather than implying all server history has been downloaded.

Frontend regressions cover live statistics/progress, empty results, errors without demo fallback, stale request cancellation, explicit demo mode, malformed responses and backend running-status normalization.

## Verification

- Backend: 1,043 passed, zero failed; one pre-existing TODO.
- Disposable PostgreSQL schema/integration suite: 156 passed.
- Real PostgreSQL filter semantics suite: 20 passed.
- Frontend product tests: 38 passed; UI tests: 21 passed.
- Frontend production build passed with a temporary placeholder API key for compilation only. This artifact is not a production deployment.
- Shopify AI Toolkit schema validation passed for Admin API 2026-10.

The disposable PostgreSQL suites do not use the application database URL. No new migration, live database change, Shopify mutation, app restart or deployment was performed for findings 6–10. The earlier refresh-request migration remains a separate completed deployment; unrelated pending migrations remain unapplied.
