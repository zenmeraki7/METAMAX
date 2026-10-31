# Catalog phase orchestration

The migration `20261029000100_catalog_import_executions` extends the existing
catalog-import queue with a one-to-one execution record. It does not reinterpret
the BIGINT `SyncRun` ingestion identity as a text execution identity.

## Authority and compatibility

`catalog_import_jobs` owns the request, installation, cancellation and expected
publication. Its immutable `execution_mode` selects exactly one executor:

- LEGACY jobs drain through the existing whole-import worker and its job lease.
- PHASE jobs use `catalog_import_executions`, whose ID equals the job ID. The job
  has no legacy lease. Composite foreign keys bind job, shop and generation.

Generation allocation, job insertion, execution insertion and child ingestion
association commit together. There is no visible phase job with a null generation.
The new adapter maps the execution extension, not `ingestion_runs`.

The execution lease is authoritative. Database triggers propagate its lease and
fence to the child ingestion run. Both ingestion writer lease checks and ingestion
service writes recheck the live execution, installation and cancellation. Legacy
ingestion APIs cannot independently reclaim a phase-managed child. Reconciliation
keeps its revision CAS and adds an execution check in the same write transaction.
The existing publication ACCESS EXCLUSIVE barrier remains first in lock order.

## Budget and durable gates

The attempt counter bounds consecutive claims without a successful receipt.
Claim increments it, failure preserves it, and successful ADVANCE, DEFER and
COMPLETE reset it atomically to zero. The monotonic fence still distinguishes
every claim. Long polling and chunking have no lifetime twelve-claim ceiling.

The production validators in `catalog-execution.server.js` require:

- STARTING: a confirmed ledger operation matching the exact bound child run.
- WAITING: that operation completed with a valid, persisted expected count.
- INGESTING: successful required dataset receipts, durable writes, verified EOF,
  matching committed checkpoint totals and contiguous checkpoint ordinals.
- RECONCILING: verified generation/coverage and no dirty catalog revisions.
- COMPLETE: the exact published generation, matching coverage/mapping revisions
  and complete required dataset coverage.

Step proposals alone cannot satisfy these gates. Claim/record checks also verify
the current installation and installed generation schema/source/mapping contract.

Ingestion commits at most ten new chunks per step. It replays the same immutable
export from its beginning, verifying committed checkpoint hashes before appending
new chunks. A deferral does not certify EOF or change the generation to RECONCILING.
This avoids a new storage-offset contract but means resumed downloads reread the
committed prefix; very large exports can still hit the worker's bounded deadline.

## External starts and recovery

The immutable `sync_external_operations` ledger records the exact input hash and
DISPATCHING intent before a remote start. The exact response operation ID is
retained before binding it to ingestion. Starts with ambiguous outcomes cannot be
repeated through ordinary claims. Recovery never adopts `currentBulkOperation`.

The private production recovery repository claims an expiring fenced recovery
lease. Its verifier reads the exact persisted operation ID for STARTING/WAITING.
A start dispatched without a provable response ID requires review. Confirmed IDs
can be rebound under the current claim. Other phases replay their fenced database
operations, checkpoint hashes and revision acknowledgments. Private, scoped,
expiring verification receipts cannot be supplied by an HTTP client.

Recovery failures persist bounded backoff; eight recoveries without successful
phase progress require review. Expired final claims are rediscovered before
replay. Successful phase receipts reset the recovery streak. Cancellation fences
writes immediately; interrupted local cleanup is rediscovered after its lease
expires. Shutdown aborts active phase work and leaves durable recovery state.
Remote cancellation is bounded and best effort: failure cannot authorize local
publication, and does not prevent fencing/cancelling local staging. A publication
that committed before cancellation remains the authoritative completed result.

Recovery scheduling uses the repository's locked `getRecoveryEligibility` read,
followed by fresh durable checks during the recovery claim. Uncertainty on the
last ordinary attempt remains eligible for that separate recovery budget; it
does not become an ordinary retry or an automatically terminal review.
The recovery orchestrator bounds each repository stage as well as verification,
accepts the runtime shutdown signal and reports durable review on exhaustion.
See `sync-recovery-orchestrator.md` for its API and acknowledgment guarantees.

## Startup and verification

`web/index.js` constructs the verified phase runtime before starting the import
service. New authenticated requests use phase execution; the legacy dispatcher
excludes PHASE jobs. The existing periodic database scanner drives both the phase
worker and recovery, independently of queue retention. No BullMQ deployment is
required. Startup fails clearly if the migration is absent or incompatible.

Production PostgreSQL integration tests live in
`web/mirror/integration/catalog-phases.js`, alongside the generic adapter tests.
They use the real migrated orchestration tables, existing JSONL writer,
reconciliation and publication services, with simulated Shopify responses.
They do not execute mutations against a merchant's Shopify store.

## Applied database state, 29 October 2026

The migration was applied first to the existing isolated Neon test branch,
then to `newmeta_app` on `express-backend-20261027`. Prisma reported zero drift
on both. Live verification matched all eight migration checksums and all 28
filter mappings; both public Shopify session-table fingerprints were unchanged.
The refreshed live snapshot contains 43 models. The database has 44 tables
including its migration ledger, and 33 custom mirror triggers.

Recovery branch `phase-integration-recovery-20261029` (`br-dark-truth-aobb0xvc`)
preserves the pre-migration configured branch at LSN `0/B25E600`, without a compute.
No schema was reset and no application jobs or Shopify requests were started by
live verification. The source is wired for the next application start; this
change does not restart or deploy an already running application process.

Evidence is saved in `.audit/sync-phase-live-verification.json`,
`.audit/live-migration-live-verification.json`,
`.audit/sync-phase-schema-final.txt`, `.audit/sync-phase-backend.txt` and
`.audit/sync-phase-filter-regressions.txt`. Local integration tests simulate
Shopify responses; the actual operations were also schema-validated against the
app's pinned Shopify Admin API 2026-10.
