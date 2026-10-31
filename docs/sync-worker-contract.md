# Phase-based sync worker

`web/workers/sync.worker.js` implements the supplied worker contract. One
`processRun(runId)` invocation claims authoritative state and runs exactly one
STARTING, WAITING, INGESTING, RECONCILING or PUBLISHING step. It contains no SQL,
GraphQL, normalization or catalog writes. Its BullMQ adapter accepts only a plain
`{ runId }` delivery and returns a paused worker (`autorun: false`). The host
supplies the BullMQ Worker constructor and Redis connection and owns its lifecycle.

## Repository and phase adapters

The repository must implement `claimRun`, `renewLease`, `recordStep` and
`recordFailure`. The step service must implement `startBulk`, `checkBulk`,
`ingestChunk`, `reconcile` and `publish`. The existing
`services/catalog-phase-runtime.server.js` now supplies these contracts using
the existing ingestion, reconciliation and publication services. Startup wires
new PHASE jobs through this runtime; the whole-import worker drains LEGACY jobs.
See `catalog-phase-integration.md` for the schema and authority hierarchy.

`mirror/sync-run-repository.server.js` now supplies the repository core through
an injected transaction adapter. It does not supply PostgreSQL access itself.
See `sync-run-repository-contract.md` for its adapter and persistence boundaries.
The concrete adapter, physical-schema verifier and recovery coordinator are
described in `sync-db-adapter.md`. The production mapping targets the migrated
one-to-one `catalog_import_executions` extension of the existing queue.

- A claim resolves the shop and generation from durable state, checks due retry
  eligibility and phase, coordinates execution per shop, and increments the
  fencing token. Redundant or ineligible deliveries return null before any step.
- All writes, including adapter writes after a remote request, must conditionally
  match shop, run, generation, phase, lease token, fence and unexpired lease.
  Renewal cannot revive an expired or superseded claim. Claim IDs are opaque
  strings, fences are positive PostgreSQL bigint strings, and shops are canonical
  myshopify.com domains.
- An ADVANCE result is a proposal. `recordStep` independently checks durable
  evidence before deciding whether the phase can advance. Ingestion requires
  validated committed rows, a complete checkpoint ledger and verified EOF before
  RECONCILING. A COMPLETE proposal is allowed only in PUBLISHING and requires
  durable verified publication evidence in the repository transaction.
- DEFER stores its next eligible time in PostgreSQL. Retryable failures store
  bounded backoff and uncertainty; deterministic failures require review. An
  uncertain external effect must be reconciled before repeating it. The durable
  scanner must rediscover due work independently of BullMQ job retention.
- Both final recording methods return only RECORDED or STALE_CLAIM. Missing or
  unrecognized outcomes throw an uncertain-result error instead of acknowledging
  delivery. Repository failures and hard deadlines also propagate as uncertain
  outcomes so a consumer can recover from durable state.
  A recorded failure may also return authoritative `retryable`, `reviewRequired`
  and `outcomeUncertain` flags. The worker uses those flags to report
  REVIEW_REQUIRED or RECOVERY_REQUIRED instead of promising an ineligible retry.

## Deadline and lease behavior

The supplied implementation is hardened so a pending heartbeat cannot make the
final drain wait forever. Adapter execution and heartbeat drain share the step
deadline. Renewal loss overrides even an otherwise successful step; an unresolved
renewal at the deadline returns STALE_CLAIM with no final recording call.
Heartbeats never overlap, and none begin once final handling starts.

Claim and final recording calls each have a bounded wait using `stepTimeoutMs`.
Those separate limits bound an invocation to at most three such windows, plus
ordinary scheduling overhead. Repositories must additionally enforce database
statement and lock timeouts. A JavaScript deadline ends the worker's wait; it
does not terminate a synchronous blocking adapter, a remote request or a database
transaction already in progress. All late writes therefore still require the
conditional fence above. Queue idempotency cannot supply this guarantee.

Claims and step results are captured from plain data descriptors without invoking
getters. Queue payloads reject additional string or symbol keys, inherited fields
and accessors. Diagnostic logger failures cannot change business outcomes.

## Verification

`node --test web/workers/sync.worker.test.js` exercises all five phases,
dependency/input validation, bounded retries, premature completion, timeouts,
uncooperative asynchronous steps, hung/failed renewals, non-overlapping heartbeats,
unknown database outcomes, duplicate deliveries and late stale adapters. The
fencing test uses a conditional in-memory repository to verify the orchestration
contract; production SQL behavior is exercised separately by
`mirror/integration/catalog-phases.js` and `mirror/integration/sync-db-adapter.js`.

The file is included automatically by the existing backend `workers/*.test.js`
test command.
