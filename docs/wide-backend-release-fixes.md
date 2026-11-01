# Wider backend release corrections

These changes address the attached NEW-01–12 and WIDE-001–013 findings against the current checkout. They do not certify a deployed database or unavailable integration environment.

| Finding | Resolution |
| --- | --- |
| NEW-01 | Exact installation/command/fence/token lease renewal runs during processing. Renewal failure aborts new transport work and local acknowledgments. |
| NEW-02 | Both existing-dispatch branches reload current tenant, installation, approval and write permission. |
| NEW-03 | Persisted counts distinguish success, failure, pending and uncertainty; mixed terminal results report PARTIAL independently of internal FAILED status. |
| NEW-04 | Stale errors during recovery inspection stop the worker without retrying Shopify or acknowledging an item. |
| NEW-05 | Recovery persistence failure is explicit. Independent scanning discovers interrupted history requests without a task written by the original worker. |
| NEW-06 | Durable finalization records track History and Undo independently, retry failures and escalate unresolved inconsistencies. |
| NEW-07 | Merchant, catalog-worker and operation-worker roles are separate. Additional hardening revokes merchant command ownership/outcome writes, outbox publication and deletion of dispatch evidence. Merchant cancellation and authorized delivery requeue retain only necessary column privileges. |
| NEW-08 | Merchant and worker gateways require issued database profiles. The operation outbox now also rejects raw or merchant pools. Business modules cannot import process/migration pools. |
| NEW-09 | Installation authority is normalized and checked against immutable selection/approval/command provenance at phase boundaries. |
| NEW-10 | Installed writer registry declares eight product and five variant fields with exact resource/mutation/normalization/observation/Undo metadata. Inventory and unsupported fields remain rejected. |
| NEW-11 | Required versioned coordinates, exact field resolution and adapter descriptors are hashed and independently revalidated. |
| NEW-12 | Shop plus parent-product family admission uses transaction-scoped advisory serialization and durable unresolved-history exclusion. Real PostgreSQL concurrency verification remains required. |
| WIDE-001 | Outbox exhaustion persists `review_required` and sanitized error state, emits alerts and is independently scanned after an abandoned final lease. Authorized `requeueDispatch` preserves the original command, dedupe identity and outbox row, rechecks live permission and records review. |
| WIDE-002 | Exhausted refresh revisions persist review state and emit alerts. `requeueCatalogRefresh(session, {expectedRevision, reason})` requires a currently validated session and exact active installation/revision, resets only reviewed pending work and emits an audit entry. A newer verified webhook revision resets its own scheduling budget. |
| WIDE-003/004 | Saved ASTs are re-parsed, semantically revalidated and checked against their stored fingerprint. New recipes use the Filter Engine AST fingerprint. Existing exact legacy JSON fingerprints are verified for compatibility and returned with a canonical AST fingerprint. This recipe digest is explicitly distinct from live execution fingerprints. |
| WIDE-005 | Selection and dispatch enforce matching mutation budgets: 100,000 selected products for bulk/Undo, 1,000 rows for installed imports, 100,000 actual variant targets; exports retain the 1,000,000 read-selection budget. Explicit request arrays remain bounded at 10,000. |
| WIDE-006 | The installed recurrence contract is explicitly UTC with fixed hourly/daily/weekly intervals. Non-UTC timezones are rejected; merchant-local/DST scheduling is unsupported and must not be advertised by callers. |
| WIDE-007 | Existing error envelopes are documented as separate versioned HTTP adapters: catalog import uses `{error: string}`; export domain failures use `{error:{code,message,retryable}}`, while export control boundary failures use `{error:string}`. Consumers must inspect their endpoint contract; no incompatible blanket response rewrite was applied. |
| WIDE-008 | Product-list REST syntax is a bounded presentation adapter. It produces the canonical AST and passes through the same semantic validation/compiler/executor; it is not a separate authorization or SQL language. Reusable engine callers use AST input directly. |
| WIDE-009/012 | Production uses the `export_engine.v2` lifecycle repository with nested identity and real request-cancellation semantics. A dedicated control adapter supplies one camelCase Export Job DTO to routes and download authorization. Status counts now come from that DTO; private claim/storage fields remain internal. |
| WIDE-010 | Approval independently compares the stored selection operation with the requested operation. A regression rejects export-to-bulk reinterpretation before drafting. |
| WIDE-011 | Explicit selections reject unresolved requested IDs atomically; missing IDs cannot silently shrink the approved target set. Duplicate aliases that resolve to the same product are represented by the actual frozen membership count. |
| WIDE-013 | `export_engine.v2` is the active production route/service/repository/dispatcher/worker composition. `mirror.export_manifest_jobs` and `services/export.server.js` remain compatibility implementations for existing internal callers/tests, not interchangeable production components. The control adapter rejects manifest compatibility repositories. |

## History snapshot identity

`snapshot-service.server.js` revalidates the issued write resolution and compares its exact registry, writer version, definition revisions and resolved descriptors. It independently resolves the filter's own field set and compares its registry digest, definitions, descriptors and datasets with the issued filter plan, plus every filter code version. Read-filter and mutation field sets may legitimately differ; equating their whole registry digests would reject valid operations. Existing shop, operation, phase, generation, coverage, target, approval and schema comparisons still apply. AFTER evidence separately retains the complete original BEFORE binding.

## Delivery review contract

`dispatchNext()` is worker infrastructure. An exhausted or abandoned final event is durably marked for review. Queue acknowledgement failure does not prove absence from Redis; authorized requeue uses the same deterministic queue job ID and original database command, whose worker remains idempotent. It does not create another approval or mutation plan. Stale event leases cannot acknowledge or change review disposition.

`dispatchService.requeueDispatch({authContext, contractId, kind, sourceCommandId?, reason})` uses the merchant gateway, reloads the exact current approval and write authorization, requires an existing undispatched reviewed outbox row and eligible command, resets the bounded delivery budget and audits the decision. If approval expired or adapter coordinates changed, the method rejects; it cannot renew an old mutation grant. Redis work is only scheduling, never execution authority.

Catalog refresh recovery is a read/synchronization action using the current validated Shopify session. It neither acknowledges a revision nor allocates a replacement mutation command during recovery. The subsequent scanner uses its original exact-revision allocation path. A stale revision or installation cannot be reset by an older recovery call.

## Deployment and verification

Migrations `20261101000400_merchant_command_privileges` and `20261101000500_dispatch_review` are additive corrections following the prior role split and lifecycle migrations. They have not been applied. Credential provisioning now requires the latest hardening migration ledger entry. No credentials were provisioned or rotated.

Focused tests cover role rejection, fenced heartbeat/ownership, partial results, stale exception handling, recovery persistence, finalization, review/requeue identity, exact refresh revision recovery, saved-filter integrity, strict target resolution and the actual export lifecycle repository/control adapter. PostgreSQL integration fixtures additionally compose production export source/storage/evidence/service/repository/dispatcher/worker and control routes, with transport-only S3/queue fixtures. They require the disposable PostgreSQL harness; unit tests alone do not certify database privilege, race or storage behavior.

Validation on this checkout: all 1,275 backend tests pass, Prisma validation passes, and changed integration files pass syntax checks. The PostgreSQL schema/integration harness cannot start because Docker Desktop's Linux engine pipe is unavailable. Production-role grants, new migrations, concurrent admission and real PostgreSQL recovery scenarios remain unverified and unapplied.
