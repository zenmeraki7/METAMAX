# Catalogue sync audit — 31 October 2026

The implemented sync pipeline has substantial transactional safeguards, but it is not free of defects. This review found seven issues, including a reproducible Redis dispatch stall after a late webhook. Production also has an overdue refresh request with no active import job. No application code, credentials, production rows, or deployment settings were changed for this audit.

This is an end-to-end review of the implemented catalogue path, including its failure boundaries. It is not a claim that every repository file or every possible execution schedule has been exhaustively verified. Local tests replace Shopify with controlled responses; no new live Shopify export, cancellation, installation, or uninstall was triggered.

## Findings

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| CS-001 | P1 | Redis dispatcher cannot resume a reopened generation in PUBLISHING | Real PostgreSQL reproduction |
| CS-002 | P1 | Sync controls ignore online staff product permissions | Service calls backed by real PostgreSQL |
| CS-003 | P2 | Slow product reads can loop forever after the product lease expires | Real PostgreSQL, simulated elapsed lease time |
| CS-004 | P2 | Ingestion repeatedly downloads and parses the saved prefix | Actual ingestion service, instrumented stream/checkpoints |
| CS-005 | P2 | Cancellation cleanup accepts an absent or unverified result | Real phase runtime and PostgreSQL |
| CS-006 | P2 | Completed executions prevent old generation reclamation | Real PostgreSQL foreign-key rejection |
| CS-007 | P3 | Missing pagination cursor can certify a partial product snapshot | Actual product reader with malformed response |

### CS-001 — Redis dispatch stalls after publication reopens staging

[`sync-dispatch-repository.server.js:69`](../web/mirror/sync-dispatch-repository.server.js#L69) permits PUBLISHING only when the generation is VERIFIED or PUBLISHED. However, [`catalog-sync-steps.server.js`](../web/mirror/catalog-sync-steps.server.js) deliberately reopens VERIFIED staging to RECONCILING when a webhook dirties products. `publish()` can return DEFER while retaining execution phase PUBLISHING. That state is supported by the generation trigger and execution recovery repository, but excluded by the dispatch repository.

Reproduction: advance an eleven-product import to PUBLISHING; deliver a webhook dirtying eleven products; process one publication step. Its reconciliation budget handles ten products and returns DEFER. The generation is now RECONCILING, the execution is due in PUBLISHING, and one dirty product remains. `reserveDispatchBatch()` returns an empty array. A direct `processOne()` invocation can finish the same work, proving that the dispatcher predicate is the missing boundary.

Impact: when queue workers exist, `catalog-phase-runtime.processOne()` performs maintenance and then returns rather than processing ordinary steps directly. Therefore the deployed Redis path can remain stuck, while the fallback poller and existing late-webhook tests succeed. The old published generation remains protected, but the replacement never publishes. A late webhook between the final reconciliation check and publication can also produce this reopened state even with fewer products.

Correction: centralize the permitted phase/generation combinations; allow the deliberately reopened PUBLISHING/RECONCILING combination in dispatch admission and acknowledgment. Test the full dispatcher-to-worker loop, including DEFER, redelivery, recovery, and final publication. Do not remove the dirty-product publication check.

### CS-002 — Interactive sync authorization ignores staff scopes

[`catalog-import.server.js:13`](../web/services/catalog-import.server.js#L13) checks credentials, shop, expiry and `session.scope`, but does not intersect online sessions with `onlineAccessInfo.associated_user_scope`. `authenticate()` feeds this helper into enqueue, status, current and cancel. Enqueue then uses the shop's offline credentials for the background work.

Reproduction: store a valid online session with app scope `read_products` and staff scope `read_orders`; provide the valid shop offline session. The real service accepts enqueue, returns status, and accepts cancellation. The existing source-status and filter preparation paths deny the same staff scope combination.

Impact: a staff member whose effective grant lacks product access can control product imports using the app's broader offline grant. This is conditional on such an online session reaching these endpoints; the probe does not claim that the currently configured authentication mode issues one to every request. Authentication proves session identity, not this operation permission.

Correction: share the trusted current app/staff authorization check across interactive sync controls, including the older refresh route. Preserve explicitly shop-authorized OAuth installation and background scanner paths. Recheck authorization before the transaction's protected action; do not accept identity kind or scopes from HTTP input.

Shopify documents `associated_user_scope` as the intersection of app scopes and user permissions: [access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

### CS-003 — Product lease expiry is treated as successful supersession

[`reconciliation-service.server.js:196`](../web/mirror/reconciliation-service.server.js#L196) claims each dirty product for 30 seconds. `reconcileLatestProduct()` does not renew this lease during its complete Shopify read. The parent execution heartbeat renews the execution/ingestion leases, not the separate row in `catalog_changes`.

At [`reconciliation-service.server.js:264`](../web/mirror/reconciliation-service.server.js#L264), an expired product lease produces the same `{applied:false,superseded:true}` result as a genuinely newer revision. No exception reaches `recordFailure()`. The phase sees remaining dirty work and records a successful DEFER, resetting its failure streak.

Reproduction: keep the parent execution live; expire only the product claim while its authoritative read is in progress; return a complete valid snapshot. Three attempts each returned DEFER, with the product still dirty and `attempts=0`. Elapsed time was simulated by changing the lease deadline in the disposable fixture; no production deadlines were changed.

Impact: a product whose complete read repeatedly takes more than 30 seconds cannot finish, and its retry/backoff/dead-letter policy does not engage. Pagination or throttling makes this relevant to larger product families. Fencing prevents a stale write, which is correct; the missing piece is progress and failure disposition.

Correction: renew the exact product claim under its current revision, fence and token, or use a bounded reader deadline that leaves enough lease time for the commit. Distinguish lease expiration from a newer revision and account for unsuccessful attempts without penalizing a superseding webhook.

### CS-004 — Bounded new writes do not bound replay work

[`catalog-sync-steps.server.js`](../web/mirror/catalog-sync-steps.server.js) opens the export URL anew on every INGESTING step. [`jsonl-ingestion.server.js:243`](../web/mirror/jsonl-ingestion.server.js#L243) starts parsing at the beginning each time. Saved chunks avoid duplicate writes, but every earlier record is still downloaded, parsed and checksum-validated. `maxNewChunks=5` bounds only newly committed chunks.

Reproduction: 1,200 products with one variant each, using the actual ingestion service with its production batch size 100 and five-new-chunk budget. Completing 2,400 JSONL records required **5,402 line reads across three passes**. The fixture used in-memory checkpoint persistence to measure stream consumption; it was not a network benchmark.

Impact: with k steps, cumulative prefix work grows approximately quadratically in k. Every step also consumes Shopify status/session checks and remote bandwidth. The worker has a 90-second step deadline. If replaying the committed prefix alone approaches that deadline, later steps can repeatedly time out before making any new progress, ultimately requiring review. That deadline failure is inferred from the measured replay behavior and worker deadline; this audit did not benchmark a production-sized export to find its threshold.

Correction: durably stage the immutable download with identity/checksum evidence and resume from a verified byte/chunk boundary, or use another genuinely bounded streaming design. A raw byte offset against an unverified regenerated or changed remote file is insufficient. Keep atomic row/checkpoint writes and durable EOF validation.

### CS-005 — Remote cleanup can be recorded without an exact result

[`catalog-phase-runtime.server.js:245`](../web/services/catalog-phase-runtime.server.js#L245) checks only top-level error length and `payload.userErrors` length. Its success branch sets `remoteConfirmed=true` without requiring a payload, exact operation ID, or terminal status. It subsequently sets `cancel_completed_at` and clears uncertainty.

Reproduction: after starting and binding an export, cancel its import and return `{data:{bulkOperationCancel:null}}` from the remote adapter. The real runtime returns CANCELLED and records `cancel_completed_at`. A mismatched operation ID or a matching CANCELING status is likewise not checked by that branch.

Impact: the local generation remains fenced and cannot publish, but the system can stop tracking a remote export that has not been proven canceled. The cancellation success path is weaker than the legacy bulk cancellation adapter's ID check. Shopify explicitly says cancellation starts a process and can complete after a delay: [bulkOperationCancel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationCancel).

Correction: validate the exact response identity and distinguish accepted cancellation from terminal cleanup. Persist pending cleanup for CANCELING, poll the exact bound operation to a terminal state, and preserve uncertainty for missing/malformed responses. Retain the existing fence checks around every final acknowledgment.

### CS-006 — Old generations cannot be reclaimed while execution records remain

[`publication-repository.server.js:630`](../web/mirror/publication-repository.server.js#L630) provides generation cleanup, but no application-startup or scheduled production caller was found. More importantly, even explicitly calling it cannot reclaim normal phase-generated snapshots: the [`catalog_execution_generation` foreign key](../web/prisma/migrations/20261029000100_catalog_import_executions/migration.sql) uses ON DELETE RESTRICT. Cleanup checks selection/read references but does not retire or detach historical phase execution references. No execution-history purge path was found.

Reproduction: complete an import, complete a replacement import, simulate the first generation's retention having elapsed, and call the real cleanup repository. PostgreSQL rejects deletion because `catalog_import_executions` still references the old generation. Only the retention deadline was changed under a temporarily disabled retention guard in the disposable fixture; that guard was restored before the actual cleanup call. PostgreSQL's foreign-key enforcement remained enabled throughout.

Impact: full refreshes retain complete old catalogues indefinitely in this application's current lifecycle. Frequent webhook-triggered full refreshes amplify storage growth. Simply wiring a cleanup timer will encounter the foreign-key failure.

Correction: define a bounded, audited retention lifecycle for execution/job/dispatch history and generation references, respecting uncertain external outcomes and active consumers. Then schedule bounded reclamation. Do not solve this by indiscriminately cascading deletion through live work or approvals.

### CS-007 — An omitted end cursor can certify a partial snapshot

[`shopify-catalog-source.server.js:68`](../web/mirror/shopify-catalog-source.server.js#L68) assigns `after` from `endCursor` when `hasNextPage` is true, but validates it only if it is not undefined. If the cursor property is missing, the loop terminates and returns `complete:true`.

Reproduction: the actual reader receives a valid product and variants page with `pageInfo:{hasNextPage:true}` and no endCursor. It accepts the page as the entire product family. A null or repeated cursor is already rejected.

Impact: a malformed or incomplete adapter response can become an authoritative replacement and remove variants omitted from the first page. A conforming Shopify response to the selected fields normally supplies the cursor property; no live Shopify occurrence was observed. This is a fail-closed adapter-contract gap, hence the lower priority.

Correction: whenever `hasNextPage` is true, require a nonempty, advancing string cursor before deciding whether to continue. Missing cursor data must reject the snapshot.

## Live application observation

The read-only inspection explicitly targeted application branch `br-frosty-darkness-aod5t1wf`, database `newmeta_app`, not the project's default branch.

At **31 October 2026, 20:24 IST**:

- One import job was SUCCEEDED; its execution was complete in PUBLISHING, with no review or uncertainty flags.
- One generation was PUBLISHED and one publication pointer existed; there were zero dirty product rows.
- A current-installation refresh request had `requested_revision=1`, `scheduled_revision=0`, `attempts=0`, and zero active import jobs.
- Its eligibility time was **13:15:20 IST**, approximately **7 hours 9 minutes overdue**. The latest import-job update was 29 October.

This is an operational freshness gap, independent of the reproduced reopened-generation bug: the live request has not yet been allocated to a job. The scanner should consider an active, current-installation, due request with no staging/active import. Deployment state, process health, scanner logs and session availability must be checked to establish why it has not progressed. Local process-command inspection was denied by Windows, so this audit does not assert that a particular worker process is stopped. The health route currently returns a constant `ok` and is not evidence that sync scheduling is healthy.

## Complete implemented procedure and boundary coverage

| Stage | Actual implementation and reviewed boundary | Assessment |
| --- | --- | --- |
| Process bootstrap | `index.js`, DB/Redis bootstrap, phase runtime creation, storage verification, scheduler/worker start and shutdown | Production embeds the scheduler in the web process. No separate automatic generation janitor found. Worker progress is not represented by `/health`. |
| Verified request / install | Official Shopify auth callback precedes `onInstall`; sessions reloaded before scheduling; empty-object sync request schema and bounded JSON parser | Shop and session evidence are checked server-side. Staff authorization gap CS-002 remains. |
| Installation lifecycle | Shop tombstone, installation version rollover, cancellation of old work, initial scanner keyset rotation | Reviewed current-installation fencing and existing reinstall/uninstall integration tests. No live reinstall/uninstall performed. |
| Import allocation | Same-shop publication barrier; shop row lock; active/staging exclusion; expected publication capture; generation, ingestion run, job and execution allocated together | Concurrent allocation is serialized and installation versions are checked. Failed/review staging intentionally needs disposition rather than being silently overwritten. |
| Notification dispatch | DB reservation, fairness sequence, logical delivery revision/key, Redis enqueue outside SQL transactions, exact acknowledgments | Stable IDs are delivery deduplication, not authority. CS-001 is a mismatch in allowed phase/generation states. |
| Queue delivery | Run-ID-only payload, Redis active leases, stalled recovery, independent DB execution claims | Browser/queue cannot choose tenant, generation or fence. Redis lease alone cannot authorize writes. Live Redis failure testing was not performed. |
| Worker claim | Fresh physical schema validation, active installation, exact phase/generation, attempt limit, ownership token, monotonic fence and unexpired lease | DB claims and writes enforce current ownership. Successful DEFER resets the failure streak, which exposes CS-003's false-success behavior. |
| Bulk start | Server-owned products/variants query; PREPARED then DISPATCHING ledger; response evidence; atomic exact-ID binding | Ambiguous unbound starts require review; they are not silently reissued or adopted from another current operation. No live bulk start performed. |
| Bulk polling | Exact bound operation ID; COMPLETED required; bounded exact object count; permanent remote failure classification | Partial/failed exports are not eligible for ingestion. Successful polls can DEFER without consuming a failure budget. |
| Download | HTTPS host allowlist, credentials/port rejection, redirect rejection, abortable streaming body | Reviewed empty export and URL rejection paths. Repeated full download/replay is CS-004. Remote availability/expiry were represented by controlled fixtures. |
| JSONL decoding | Fatal UTF-8 decoder; bounded line and batch bytes; grouped parent/variant identities; duplicate checks; product-family size limit | Rejects orphan/unsupported child records, count overrun, invalid records and truncated exports. Only products/variants are advertised as covered. |
| Durable ingestion | Each batch and checksum checkpoint in one transaction; ordinal/count replay checks; ingestion/parent fences; EOF and finished-write evidence | Counts are durable committed writes, not just lines read. RECONCILING is reached only after atomic completion evidence. |
| Webhook delivery | Official raw-body signature verification before handler; durable receipt, all product revisions and refresh intent in one same-shop transaction | Duplicate payload identity is verified; unavailable inventory/collection relation mappings schedule full refresh. No live signed webhook delivery was sent. |
| Reconciliation | Latest dirty row claimed from DB; complete reread; exact revision/fence/token/expiry acknowledgment and product-family replacement in the same transaction | A newer webhook cannot be accidentally acknowledged by an older worker. CS-003 and CS-007 affect completeness/progress boundaries. |
| Coverage | Supported dataset contracts, durable ingestion evidence, no pending dirty work, generation-scoped counts, verified coverage rows | No fabricated collections, inventory-level or metafield coverage is advertised by this importer. Those remain unavailable features, not successfully synced datasets. |
| Publication | Fresh offline authorization; same-shop barrier; late dirty check; expected publication CAS; immutable published generation | Old publication remains available during replacement. Reopening is safe for data but dispatch continuation is broken by CS-001. |
| Post-publication refresh | Durable coalesced requested/scheduled revisions, installation scope, due scanner, bounded credential-failure backoff | Refresh intent is retained across concurrent events; current live pending request has not progressed. This is a full products/variants refresh, not an incremental published-row mutation. |
| Cancellation | Durable local cancellation, parent/child fencing, generation retirement/failure, exact cleanup ownership, uncertain-network recovery | Local data cannot publish after cancellation. Remote confirmation validation has CS-005. |
| Crash / uncertainty recovery | Separate recovery claims, exact operation identity/hash evidence, checkpoint validation, late response evidence, recovery budget, review disposition | Unknown HTTP effects are not undone by SQL rollback. Existing tests cover lost responses, expired leases, stale recovery attempts and shutdown. |
| Legacy drain | Existing LEGACY jobs are still claimed with their older polling/resume/cancel path | Reviewed separately from the active PHASE entry point. Older whole-import execution has different duration/batch behavior; no production legacy backlog was observed. |
| Catalogue consumers | Published context, coverage checks, trusted field mappings, compiler-issued queries, shop/generation binding, signed pagination, retention protection | Existing PostgreSQL tests cover physical bindings, RLS, selection boundaries and old snapshot preservation. This audit did not rerun a live merchant browser journey. |
| Progress / source UI | Current job metadata, phase/count progress, active/idle polling, visibility handling, explicit unsupported sources | Focused UI tests pass. UI success/progress does not replace publication or worker-health evidence. |
| Retention / cleanup | Published retention deadlines, active read/selection checks, explicit cleanup repositories | Missing scheduled lifecycle and execution FK block are CS-006. |

## Validation and artifacts

Fresh runs during this audit:

- **1,068 / 1,068 backend tests passed**, zero skipped/TODO.
- **161 / 161 PostgreSQL schema/integration assertions passed** using a disposable local PostgreSQL 18.6 database, including restricted runtime-role coverage.
- **41 / 41 focused frontend tests passed** for sync notification, source status and catalogue behavior.
- **7 / 7 focused audit test cases passed**. These are defect reproductions: their assertions verify the incorrect current behavior, not a corrected implementation. One container test holds four real-PostgreSQL scenarios; a combined scenario demonstrates both staff authorization and cancellation-result gaps.

Artifacts in the ignored local audit directory:

- `.audit/catalogue-audit-probes.mjs` — reproducible probe source, including strict localhost/database guards.
- `.audit/catalogue-audit-pg-runner.mjs` — disposable database runner derived from the existing project runner; never loads the application DATABASE_URL.
- `.audit/catalogue-audit-probes.log` — final successful reproductions.
- `.audit/catalogue-audit-backend.log`, `.audit/catalogue-audit-schema.log`, `.audit/catalogue-audit-frontend.log` — suite results.
- `.audit/catalogue-audit-live-state.json` — read-only aggregate/refresh observations; contains no credentials or session tokens.

The first local test-server launch was obstructed by Windows sandbox token restrictions. The successful runs used the existing runner outside that sandbox, still pinned to a fresh disposable localhost database. All runner-managed clusters were stopped and removed. No production mutation was used to demonstrate any finding.

## Recommended order

1. Fix CS-001 and add a queue-path regression before relying on the reopened-staging deployment.
2. Align interactive sync permission checks (CS-002).
3. Diagnose the overdue live refresh without discarding its durable intent.
4. Repair product lease progress and bounded ingestion replay (CS-003/004).
5. Require exact remote cancellation evidence (CS-005).
6. Implement a reference-aware retention lifecycle (CS-006) and reject incomplete page cursors (CS-007).

Live Shopify, live Redis outage behavior, real production-sized throughput, the running deployment's source revision and worker logs remain unverified. Passing tests do not establish those properties.
