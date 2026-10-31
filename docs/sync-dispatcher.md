# Durable sync dispatcher

`web/workers/sync-dispatcher.js` implements the V2 delivery adapter. The host
supplies a PostgreSQL-backed reservation repository and two BullMQ-compatible
queues, schedules `runOnce()`, and manages process shutdown. This module does
not construct database connections, queue clients, timers for recurring cycles,
or consumers, and does not replace the existing catalog phase runtime.

The repository contract is:

- `reserveDispatchBatch({limit:1,reservationSeconds})` returns zero or one plain
  `{dispatchId,dispatchToken,kind,runId,deliveryKey}` record. IDs are bounded opaque strings;
  `kind` is `SYNC` or `RECOVERY`. `runId` identifies the phase execution, not the
  bigint ingestion run. Tenant authority is resolved from PostgreSQL by consumers.
- `markDispatched({dispatchId,dispatchToken,kind,runId,deliveryKey,jobId})` acknowledges a
  successful enqueue with the exact logical queue identity.
- `markDispatchFailure({dispatchId,dispatchToken,kind,runId,deliveryKey,code})` records an
  uncertain enqueue outcome. Queue errors do not prove that no job was created.
- Both acknowledgment methods return `{kind:'RECORDED'}` or
  `{kind:'STALE_CLAIM'}`. Unverified receipts remain uncertain.

`web/mirror/sync-dispatch-repository.server.js` implements tenant fairness,
transactional reservations, due eligibility, token fencing and expiry. It uses
the existing PostgreSQL pool and verified domain schema, with no Redis or Shopify
calls inside its transactions. No BullMQ dependency is added by this module.

`deliveryKey` must come from durable PostgreSQL state scoped to the authenticated
shop, run and logical execution/phase revision. The repository must reuse it when
a reservation expires or an attempt retries, and change it when a new logical
phase delivery becomes eligible. It must not derive the key from reservation
tokens, retry counts, or ordinary lease fences. If phase polling/chunking requires
another notification, that eligibility transition must also advance the durable
logical delivery revision. The dispatcher rejects absent, malformed, inherited
or accessor-backed keys; it cannot prove the durable provenance of a key supplied
by its repository. The PostgreSQL repository persists this guarantee using the
execution's database-owned `delivery_revision` and immutable delivery rows.

Each delivery is preceded immediately by a single reservation. Exported
`dispatchJobId({kind,deliveryKey})` returns
`metamax-${kind.toLowerCase()}-${sha256(kind + "\0" + deliveryKey)}`. Job IDs do
not include reservation ID/token, so retries use the same logical identity while
the next phase has a distinct ID even if the previous job remains retained.
Queue payloads contain only `{runId}`. Both queues use
one queue attempt and remove finished jobs; durable worker/repository idempotency
is still required after removal. The queues are `metamax-catalog-sync` and
`metamax-catalog-sync-recovery`.

Defaults are 25 deliveries per cycle, a 60-second reservation, and 10-second queue
and repository-call deadlines. Configuration is bounded and the reservation must
exceed the queue/acknowledgment budget plus five seconds. Reservation discovery
also uses the acknowledgment deadline. A repository error during discovery stops
the cycle. Individual queue failures are recorded independently and do not block
other reservations once the failed calls have settled.

A database acknowledgment failure never triggers another enqueue or a
compensating failure write. The database COMMIT may already have succeeded.
Queue receipts must return the expected job ID before delivery is acknowledged.

Concurrent `runOnce()` calls return `ALREADY_RUNNING`. Any operation timeout ends
the current cycle, even if it settles during failure recording. Timeouts stop
waiting without claiming cancellation: later cycles return
`ASYNC_OPERATION_PENDING` until every outstanding call actually settles. Late
enqueue settlement clears an explicitly tracked queue call; database discovery,
acknowledgment and failure-record calls remain tracked independently, so settling
Redis cannot unblock a cycle while a database call is still unresolved. Late
responses/rejections are observed, but cannot enqueue a late reservation or
perform a late delivery acknowledgment. Repository expiry/reconciliation remains
necessary across process crashes and separate dispatcher instances.

`web/workers/sync-dispatcher.test.js` covers bounded discovery/delivery, lazy
reservations, phase-scoped queue identity and retained jobs, malformed records, stale/ambiguous acknowledgments,
independent failures, logger errors, timeouts, late settlement and overlap.
These tests use injected queue/repository doubles, not a live Redis server.

The real PostgreSQL contract, migration and integration tests are documented in
`sync-dispatch-repository.md`.
