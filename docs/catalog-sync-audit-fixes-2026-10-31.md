# Catalog sync findings CS-001–CS-007 — 2026-10-31

## Changes

- **CS-001:** Dispatch admission and acknowledgment and execution recovery share `catalog-phase-generations.server.js`. PUBLISHING/RECONCILING is an allowed reopened state. Dirty-product checks at publication remain intact. Added a database integration scenario that runs dispatcher → queue worker → DEFER → redundant delivery → missing-delivery recovery → publication.
- **CS-002:** Interactive enqueue, status, current and cancel resolve current stored sessions and use the shared product permission check. Online permissions require product access in both app and associated-user scopes. Enqueue/cancel recheck inside protected transactions; status/current recheck before returning. The older refresh route delegates to this service. OAuth/offline scanner paths retain their stored shop authority.
- **CS-003:** Complete product reads have a 20-second deadline within their 30-second product lease; their abort signal reaches paginated requests in both execution paths. Failed application of an unchanged revision/fence is lease loss, not successful supersession. Failure accounting is revision-fenced, so a newer webhook is not charged the older attempt.
- **CS-004:** Downloads are staged in tenant-scoped PostgreSQL tables. Each step downloads at most five 1 MiB ranges, checks a strong ETag, exact Content-Range and byte length, and uses If-Match for continuation. Operation, URL identity, ETag and total size are pinned. Chunks have checksums and database immutability/retention guards. EOF and record count must be verified before parsing. Parsing resumes from the durable committed line count and chunk ordinal using an internally issued staged source; row/checkpoint transactions and final ingestion EOF validation are unchanged. A changed source, corrupt chunk, truncated range or old checkpoint without a verified spool fails closed.
- **CS-005:** Phase cleanup requires the exact bound operation, a complete error-free response and a terminal status. CANCELING remains pending, with bounded polling of the bound ID. Malformed or mismatched results retain uncertainty; inaccessible or unbound uncertain remote work is not acknowledged as cleaned. Pending and terminal writes retain execution fence/token/expiry checks. Legacy cancellation uses the same exact-result validator and does not report CANCELING as terminal.
- **CS-006:** Under the publication barrier and generation retention/reference checks, terminal job/execution history older than 24 hours is compacted into a credential-free audit summary. Uncertain/review-required executions, unclosed deliveries, live leases, approvals/selections and journal references block reclamation. Explicit child-before-parent deletion releases RESTRICT execution references; no live-work FK was converted to CASCADE. One small job tombstone per installation prevents initial-sync scanners from forgetting a previous attempt. Startup runs a maintenance service: up to five shops per cycle and five generations per shop, with transactional query timeouts. Audit pruning is limited to 100 rows per shop after 90 days. Cascaded catalog deletion may still be substantial for a large generation; a timeout rolls back and retries on a later maintenance cycle. No claim is made that arbitrarily large snapshots now delete within one timeout.
- **CS-007:** hasNextPage=true always requires a nonempty advancing string endCursor before the reader may continue or certify completeness.

## Validation

- Full backend suite: 1,115 tests passed with `--test-concurrency=4`.
- Added runtime/unit regressions for permissions, expired product claims, reader deadlines, resumable staging, corruption/identity changes, cancellation result contracts, missing cursors, reclamation dependency order and maintenance bounds.
- The 1,200-product/2,400-line ingestion regression completes in three ingestion passes with no more than 2,404 line reads and one remote download; committed remote prefixes are not downloaded or parsed again. A separate multi-range test covers continuation across download steps and changed ETags.
- Prisma schema validation passed with the cached Prisma CLI.
- Default-concurrency suite runs intermittently reported child-process failures; isolated reruns passed, and the complete bounded-concurrency run passed.
- `test:schema` could not start: Docker returned EPERM, and no working local PostgreSQL runtime was available. The new SQL migrations, full queue/publication loop, cancellation acknowledgment checks and actual PostgreSQL FK reclamation scenarios are **not database-verified in this pass**.

## Deployment

Apply and verify both migrations before deploying the runtime changes:

1. `web/prisma/migrations/20261031170000_staged_catalog_download/migration.sql`
2. `web/prisma/migrations/20261031180000_catalog_retention_audit/migration.sql`

Neither migration was applied to a live database. Existing partially ingested runs without a staged source need a fresh import. The staging path requires strong ETag and byte-range support; it fails closed when the source cannot prove immutable continuation. Generations blocked by unresolved work or consumer references require the existing recovery/review lifecycle before reclamation.

## Platform references

Shopify's [access-token documentation](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens) defines associated_user_scope as app/user permission intersection. Its [bulkOperationCancel reference](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationCancel) describes asynchronous cancellation. Toolkit documentation search failed with `fetch failed`; these official pages were consulted as the fallback. No new GraphQL operation was generated.
