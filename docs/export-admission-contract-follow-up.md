# Export admission and shared history contract — 2026-11-01

| Finding | Current result |
| --- | --- |
| Route and service both consume admission tokens | Corrected in this pass. The route no longer consumes tokens or extracts a shop for rate limiting. The service alone limits new admission after authenticated, installation-scoped idempotency lookup. Passing `rateLimiter` to `createExportRouter()` now fails at construction with a migration message; configure it on the service instead. This avoids silently disabling a previously configured limiter. Production composition already configures only the service limiter. |
| Inconsistent session-token replacement | Previously corrected and reverified by the full suite. Guard, tenant-admin and filter authority share immutable credential/identity evidence and current-session validation, plus pinned installation checks. See [session/lifecycle follow-up](session-publication-audit-follow-up.md). |
| Unbounded export replay map | Previously corrected. Database-backed lookup allocates no replay map. Legacy atomic-repository hints are limited to 1,000 entries and 60 seconds; durable conflict handling remains the repository's responsibility. |
| Incorrect history titles/states | Previously corrected; now consolidated into `web/shared/history-operation-contract.js`. Persisted kind/state presentation, titles, UI status normalization, status-filter options and badge visuals share one pure module. Partial stays separate from Failed; unrecognized states stay Unknown and emit backend diagnostics. Persistence lifecycle rules and authorization remain in their owning repositories; presentation metadata grants no authority. Verified/failed/uncertain/recorded counts remain intact. |
| Stale catalog summary cache | Previously corrected by removing process-local summary reuse. Counts are queried in each protected transaction, so incremental/recovery writes and replicas need no invalidation broadcast. |
| Publication locks outside transactions | The transaction-only table fence runs first and rejects autocommit before advisory acquisition. Production callers were traced to transaction owners. Actual concurrent publication/read/reclamation and installation-row fencing tests remain pending because local PostgreSQL is unavailable. |
| Two unrelated export factories share a name | Corrected in this pass. `web/export/export-service.server.js` retains the canonical production `createExportService()` factory used by `export-runtime.server.js` and HTTP admission. `web/services/export.server.js` now exports `createLegacyArtifactExportService()` for the legacy `mirror.export_jobs` artifact pipeline. All repository callers were migrated. No ambiguous legacy alias remains. |

## Integration migration

- Move any router-level `rateLimiter` option to the production Export Service. The route authenticates, bounds/parses input and normalizes the idempotency key; it does not own an independent admission budget.
- Legacy artifact consumers must import `createLegacyArtifactExportService` from `services/export.server.js`. It is not interchangeable with the production admission service, which owns `create()`/`verifyRetryExecution()` and uses the `export_engine.v2` runtime.
- No HTTP route, mutation executor or production writer was switched to the legacy artifact implementation. The supplied isolated verified writer remains isolated.

## Validation

- **1,300 backend tests passed**, zero failures/skips.
- **34 UI and 48 product frontend tests passed**; production build passed using a placeholder public API key.
- Import audit: **485 files, 1,372 relative references and 161 package references**, no failures.
- HTTP regression uses persistent idempotency lookup: first admission consumes exactly one token, replay returns the same job after the limiter is exhausted without another token, conflicting reuse returns 409, and a different key is rate-limited. A router limiter is rejected before its `consume()` can run.
- Factory-contract regression verifies the legacy module no longer exports the canonical production name; the updated disposable legacy integration fixture passes syntax checks.
- No database migrations, live credentials or Shopify configuration were changed. Real PostgreSQL concurrency/RLS/migration checks remain blocked by Docker, and previously reported export-role provisioning and live deployment verification remain open.
