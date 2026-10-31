# SyncRun repository core

`web/mirror/sync-run-repository.server.js` implements the supplied repository core
for the phase worker. Its injected `db` must implement `getRunShop` and
`transaction(work, { isolationLevel: "Serializable" })`. Transaction methods are
listed in the source header and checked before use. No SQL, Prisma migration,
database mutation or startup activation is introduced by this module.

## Integration with deployed services

The concrete adapter and recovery coordinator are implemented and tested in
`sync-db-adapter.md`. Production integration is specified in
`catalog-phase-integration.md`, using a one-to-one execution extension of the
existing queue rather than renaming ingestion fields.

`mirror.ingestion_runs` stores durable ingestion receipts and checkpoints.
`mirror.catalog_import_jobs` owns the request; its one-to-one execution extension
supplies the phase/recovery adapter contract. For PHASE jobs the ingestion lease
is subordinate to that execution lease. Existing bulk-sync, JSONL, reconciliation
and generation services remain in use.

A production SQL adapter must map this interface to those existing records with
an explicit authority hierarchy. Every ingestion write must validate the same
active orchestration claim and the corresponding ingestion lease in its database
transaction. Reclaiming or cancelling orchestration must fence the old ingestion
owner; renewing a child lease must not authorize a superseded parent. The adapter
must use the existing generation/publication repository for final evidence.
Do not create a parallel `mirror.sync_runs` authority or connect the abstract
core directly to an ingestion row by renaming fields.

The existing `ACCESS EXCLUSIVE` lock on `mirror.publications` must be retained
before protected state reads during initial integration. The current transaction
helper uses READ COMMITTED; it is not an implementation of this core's requested
Serializable transaction contract. The separate SQL adapter now implements that
isolation, coarse lock, bounded timeouts and conflict retry behavior explicitly.
Replacing the barrier or proving per-shop throughput requires real PostgreSQL
concurrency tests. Its new PostgreSQL tests preserve and exercise the coarse
barrier; the core's in-memory tests alone make no concurrency claim.

## Adapter evidence and outcomes

- Claims resolve the tenant from durable state, lock the shop and run, recheck the
  hint against the locked row, enforce due eligibility and prevent another live
  run for that shop. Unknown coordination responses fail closed.
- Writes conditionally match tenant, run, generation, phase, lease token, fence,
  attempt and live lease. `tx.now()` must use the database wall clock, such as
  `clock_timestamp()`, rather than a timestamp frozen at transaction start.
- Claimed rows include explicit boolean `reviewRequired` and `outcomeUncertain`
  flags. Optional `cancelRequested: true` also blocks ordinary ownership.
- `verifyStepEvidence` and `verifyPublished` must return the literal boolean true
  only after checking authoritative persisted evidence in the transaction.
  Structural flags, line-read counts and a step's ADVANCE proposal are insufficient.
  Ingestion cannot advance until validated writes and checkpoint counts are durable.
- Successful writes are checked for exact identity, unchanged fence, reset attempt,
  correct phase/completion disposition and released leases. Failed verification
  throws, requiring rollback. The adapter owns actual transaction commit and
  must propagate an uncertain commit outcome rather than returning success.
- A claim increments attempt exactly once. Failure recording preserves it.
  Successful ADVANCE, DEFER and COMPLETE reset it to zero atomically. The cap
  bounds consecutive unsuccessful claims, so healthy polling and chunking do
  not exhaust a lifetime budget. The fence remains monotonic after every reset.
  Claim attempts must be integers from one through the configured cap; zero is
  reserved for unclaimed/reset durable state. Missing/coerced fences, malformed
  recovery counts and partially cleared leases fail closed. An expired retained
  owner token is not an ordinary retry grant; recovery must resolve it first.
- Uncertain failure state blocks ordinary claims until an authoritative recovery
  process resolves it. This core does not expose a browser-accessible recovery
  flag setter. Known exhausted or deterministic failures require review.

## Recovery eligibility

`getRecoveryEligibility({runId, shopId?})` resolves the authoritative tenant, locks
the shop and run, reads the database clock and checks peer ownership. A supplied
shop must match; missing or unavailable records return NOT_FOUND without exposing
another tenant. Its frozen result is a scheduling snapshot, never authorization
to clear uncertainty or repeat an external request.

Eligibility rejects completed, cancelled, reviewed, live-leased, delayed and
unneeded recovery; missing durable recovery counts also fail closed. Eight
recovery attempts block further automatic recovery. The ordinary attempt cap is
independent: an uncertain result on attempt twelve can still be verified using
the recovery budget. Production recovery consumes this scheduling API and
rechecks all durable gates in its fenced claim transaction.

Failure recording now has three mutually exclusive dispositions:

- Known retry: `retryable=true`, `reviewRequired=false`, `outcomeUncertain=false`.
- Recovery pending: `retryable=false`, `reviewRequired=false`, `outcomeUncertain=true`.
- Terminal review: `retryable=false`, `reviewRequired=true`, `outcomeUncertain=false`.

Retry/recovery due times are durable. Recovery pending does not increment or reset
the ordinary attempt counter, and remains available at ordinary-budget exhaustion.
Successful receipts must completely clear owner token, lease expiry and worker;
ADVANCE/COMPLETE clear the prior retry date, and terminal failures cannot retain
a retry date. Corrupted commit receipts cause rollback.

Recorded failures retain `kind: "RECORDED"` and also expose their durable retry,
review and uncertainty disposition. `sync.worker.js` uses that disposition when
reporting REVIEW_REQUIRED or RECOVERY_REQUIRED. It continues to accept the
original minimal RECORDED/STALE_CLAIM receipts from other configured repositories.

## Verification

`mirror/sync-run-repository.test.js` uses an explicitly Serializable, rollback-aware
in-memory adapter. It exercises tenant-hint verification, duplicate and per-shop
claims, live fencing, expiry, uncertainty gates, strict evidence, all phase
transitions, publication completion, corrupted commit results, attempt limits,
and integration with the phase worker. These tests establish the core contract;
the SQL adapter and production phase integration have separate PostgreSQL tests.
