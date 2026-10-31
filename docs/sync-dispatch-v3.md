# Durable dispatch repository V3

Release status: **integration candidate, not production approved**. See
`dispatch-release-readiness.md` for verified evidence and remaining blockers.

`web/mirror/sync-dispatch-repository.server.js` implements notification
reservation, evidence-backed delivery recovery, atomic consumption and review
exhaustion against the existing domain models. Apply the migration chain through
`20261029000600_sync_dispatch_recovery_evidence` before deploying this code.
Earlier migrations preserve the original ledger as `mirror.sync_dispatches`
and the fairness authority as `mirror.sync_dispatch_schedule`; no second
SyncRun or scheduling authority is created.

## Driver, mapping and transaction contracts

The factory accepts the existing `database` PostgreSQL pool or a `prisma` client,
never both. An optional `mapping` must be a genuine, driver-bound physical proof
from `verifySyncRunDbMapping` for the exact production execution extension.
Plain mappings, guessed SQL identifiers and bigint ingestion IDs substituted for
text execution IDs fail closed. Schema, enabled guards, tenant relationships and
indexes are revalidated inside every transaction.

Transactions use the existing Serializable publication barrier, database clock,
bounded SQL timeouts and retry policy. Only aborted database conflicts retry;
ambiguous commits never do. Shop/execution authority is locked before ledger
writes. All callbacks are trusted, database-only code; Shopify and Redis requests
must happen outside these transactions. Optional `verifyShop` and `needsRecovery`
callbacks add restrictions without weakening built-in installation, generation,
ingestion association, cancellation or external-intent checks.

## Reservation and stable identity

`reserveDispatchBatch({limit:1,reservationSeconds:60})` reserves one eligible
logical delivery immediately before use. It selects shops with due schedule
authority, rotates durable service ordering and reserves atomically.
`maxDispatchAttempts` defaults to 20 (maximum 1000); `maxRunAttempts` defaults to
12 and cannot exceed the physical execution budget. Exhausted ordinary execution
attempts do not block independent recovery discovery.

Keys use Node.js SHA-256 over the durable shop/run/delivery-revision/kind tuple.
They remain unchanged across lease expiry, Redis errors and attempt retries.
Successful phase advancement, DEFER progress and successful execution recovery
advance the database-owned revision. Keys do not include attempt counters and
require no PostgreSQL extension. Only PENDING or verified RETRY_ELIGIBLE rows
can be reserved again. Expired RESERVED, UNKNOWN and ENQUEUED rows require
delivery recovery; expiry alone never proves queue absence.

`markDispatched` checks the deterministic BullMQ job ID, token, logical scope,
installation and live reservation. It records ENQUEUED only. A worker that
already consumed the delivery wins over a late enqueue acknowledgment.
`markDispatchFailure` preserves UNKNOWN outcomes and reservation evidence;
it never fails an execution or clears ingestion state. Stale notification
receipts retain the dispatcher's STALE_CLAIM acknowledgment vocabulary.

## Recovery evidence

- `listRecoveryCandidates({limit:20})` discovers unresolved queue acknowledgments,
  expired reservations/reconciliation leases and stalled consumed claims. It is
  scheduling information, not retry permission. The compatibility entry point
  `recoverExpiredReservations` is discovery-only too.
- `claimDeliveryRecovery({dispatchId,recoverySeconds:120})` locks fresh authority
  and acquires a unique recovery token with a monotonic bigint recovery fence.
  A live recovery owner cannot be replaced.
- `finishDeliveryRecovery({claim,decision,evidenceId})` relocks the delivery and
  invokes `verifyRecoveryDecision({tx,delivery,run,decision,evidenceId})` against
  the fresh snapshot. `createSyncDispatchRecoveryVerifier` persists verified
  observations in `mirror.sync_dispatch_recovery_evidence` (bound to the exact
  delivery, revision, recovery token/fence, job ID and decision with a write-once
  immutability trigger `guard_sync_dispatch_recovery_evidence`) outside the
  completion transaction, then atomically consumes (`SET consumed_at = clock_timestamp()`)
  and verifies the persisted row inside `verifyRecoveryDecision`. A supplied
  evidence ID or caller-proposed decision alone is never sufficient.

Decisions CONSUMED, STILL_ENQUEUED, RETRY_VERIFIED and UNRESOLVED map respectively
to CONSUMED, ENQUEUED, RETRY_ELIGIBLE and REVIEW_REQUIRED. There is no permissive
recovery verifier default: a missing/false verifier raises EVIDENCE_MISSING
without changing the lease. SQL rechecks the token, fence and deadline after
verification. A retry additionally requires the same current revision and queue
route, no live worker lease and an expired original reservation. Verified
receipts cannot revive superseded phases. STILL_ENQUEUED defers inspection for
30 seconds.

## Atomic worker consumption

The production ordinary claim in `sync-run-db-adapter.server.js` and execution
recovery claim in `sync-recovery-repository.server.js` acknowledge consumption in
the same transaction as their fenced claim UPDATE. The shared implementation
verifies shop/run/generation/phase, execution fence, lease token and database
expiry, then stores CONSUMED with the exact claim fence/token. A consumption
failure rolls back both claim and receipt. RESERVED is consumable because a
worker may run before enqueue acknowledgment. Direct DB pollers may claim
without a ledger row.

`acknowledgeConsumptionInTransaction` is restricted to the fresh claim callback;
an independently opened post-claim transaction is rejected. To add custom
`verifyConsumption({tx,delivery,claim})` checks, supply the dispatch repository to
`createCatalogSyncRunDbAdapter` and `createSyncRecoveryRepository`. The phase
runtime wires the same repository into both claim paths. It accepts a configured
`dispatchRepository`, including a persisted recovery evidence verifier.
Built-in scope checks apply regardless of optional callbacks.

## Scheduled exhaustion and monitoring

`markDispatchReviewRequired` is the bounded transition primitive.
`listExhaustedDispatches` discovers PENDING/RETRY_ELIGIBLE rows at the attempt
budget. The DB-only `sync-dispatch-monitor.server.js` worker runs on startup and
every 30 seconds, refuses overlapping cycles and drains on shutdown. It marks
only delivery review state, leaving execution attempts and failure status intact.

`getDispatchMetrics` exposes string-valued counts by state and exhaustion count.
The worker publishes structured `sync_dispatch_monitor` events; the phase runtime
exposes cached metrics internally. Global counts are not exposed through public
or merchant-scoped HTTP endpoints. `web/workers/sync-redis-transport.server.js`
provides the Redis-backed BullMQ-compatible queues (`syncQueue` and `recoveryQueue`)
and `Worker` adapter, wired with `createSyncDispatcher`,
`createBullMQSyncWorker`, `createBullMQRecoveryWorker`, and
`createSyncDispatchRecovery` inside `web/services/catalog-phase-runtime.server.js`.

## Validation and deployment

`npm test` covers input validation, timeouts, monitoring scheduling and shutdown.
`npm --prefix web run test:schema` uses disposable PostgreSQL to test fair
reservation, immutable keys, stale receipts, evidence-backed retries, recovery
fencing, superseded phases, evidence deadlines, atomic consumption rollback and
exhaustion monitoring. A PostgreSQL-backed Prisma transaction protocol test checks
bigint scopes; no generated ORM dependency is added.

The installed-schema preflight in `sync-dispatch-lifecycle.md` is separate from
these tests. No live migration or Redis operation is performed by them.
