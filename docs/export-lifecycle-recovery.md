# Export Repository V2 lifecycle recovery

The supplied `export_engine` repository is available through
`createExportRepository({ pool, generationProtection, verifyStoredPart,
verifyFinalArtifact, verifyDeliveryEvidence, reconcileDelivery,
verifyRecoveryEvidence })`. It is implemented in
`web/export/export-lifecycle-repository.server.js`. Existing callers using
`createExportRepository({ database })` retain their existing
`mirror.export_manifest_jobs` admission API. These stores are separate; old
admission records are not silently imported or treated as executable V2 jobs.

Apply the additive `20261030000000_export_lifecycle_recovery` migration through
the normal deployment process, followed by
`20261030000100_export_retry_compatibility` and
`20261030000200_export_delivery_receipts` and
`20261030000300_export_installation_history`. No application database migration is performed
by this change. The Prisma models include the new `export_engine` namespace;
the SQL migration owns the lifecycle checks, immutable-record triggers and
partial scanner indexes. Never use `db push` instead of this migration.

## Generation protection

Construct `generationProtection` with `createExportGenerationProtection` from
`web/export/export-generation-protection.server.js`, passing the actual Mirror
publication service. The adapter acquires the initial read lease in the same
transaction as job creation and delegates renewal/release to the Mirror service.
It verifies shop, installation, generation, coverage revision, mapping version,
lease identity, owner, purpose, availability and PostgreSQL expiry.

Recovery may renew an expired existing lease only while its exact generation
remains published/retained/available. It never acquires a replacement lease or
switches to the current generation. A missing lease fails closed. Job pins remain
historical after release; they do not create a permanent generation FK hold.

Workers must call `renewGenerationProtection` alongside heartbeats, before the
generation lease approaches expiry. Heartbeat renews worker ownership only.
An independently restarted coordinator must periodically invoke:

1. `recoverExpiredJobs({ recoveryOwner, recoveryLeaseMs, batchSize })`.
2. For each returned recovery claim, inspect external storage and call
   `resolveRecoveredJob` with `RESUME`, `FAIL`, or `REVIEW`.
3. `renewPendingGenerationProtection({ batchSize })` to protect queued/waiting jobs.
4. `releaseRetryWaitJobs({ batchSize })` for due, verified retries.
5. `recoverExpiredOutbox` and `recoverStalledReconciliations`.
6. `reconcileUnknownOutbox` for due uncertain events.
7. `releaseTerminalGenerationProtections({ batchSize })` for crash-safe cleanup.

`export-runtime.server.js` now composes the production S3 verification adapters,
BullMQ dispatcher/worker and Mirror bridge. The application starts that
coordinator only when `EXPORTS_ENABLED=true`; missing dependencies fail startup.
See [production configuration](export-production-adapters.md). Worker retry transitions
persist RETRY_WAIT, release ownership and mark `retry_verified=false`.
Due unverified retries enter RECOVERING; neither the retry dispatcher nor the
database transition guard allows them into QUEUED. Exhausted recovery or
reconciliation attempts require review. Operator review can cancel the job;
there is no implicit review-to-resume override.

## Recovery and cancellation

Expired RUNNING/FINALIZING ownership becomes RECOVERING with a new UUID token
and strictly greater fence. A crashed recovery owner can itself be reclaimed.
Only the durably committed checkpoint and ordered parts can authorize resume.
RESUME enters RETRY_WAIT with bounded exponential delay; the next worker keeps
the original RUNNING or FINALIZING phase and receives another fresh fence.
RESUME sets `retry_verified=true`; `releaseRetryWaitJobs` releases only due,
verified rows and appends the new outbox event in that same transaction. This
preserves Contract V2's RUNNING/FINALIZING → RETRY_WAIT behavior while extending
RETRY_WAIT → RECOVERING → RETRY_WAIT → QUEUED for evidence-based recovery.

`verifyRecoveryEvidence` must independently establish `verified: true`,
`safeToResume: true`, and `artifactStatus: "ABSENT"`, bound to the supplied
`partSetHash`, `checkpointVersion` and `checkpointHash`. ABSENT means the final
artifact's absence is proven by authoritative storage/assembly evidence,
including resolution of any outstanding writes. Queue absence alone is never
sufficient. Existing/uncertain final output requires REVIEW or FAIL. All durable
parts are independently reverified. The checkpoint/part set, exact generation
and PostgreSQL ownership are checked again in the deciding transaction.

The production S3 adapter instead establishes `FENCED_UNREGISTERED` with a
matching current fence and verified attempt namespaces. Every upload uses a
different conditional-create key and exact immutable version. A late old-fence
upload can leave an orphan, but cannot overwrite a committed version or register
an artifact with its revoked database claim. This permits safe replay without
claiming that uncertain external writes never happened.

Cancellation changes active jobs to CANCELLING while retaining the current
claim. `acknowledgeCancellation` requires that live token/fence and increments
the fence at completion. `finalizeCancellation` handles jobs with no live owner;
the recovery scanner also finishes cancellations after an owner crashes.
Terminal cleanup releases the actual generation lease and records release
atomically, making replay safe after a coordinator crash.

## Storage evidence and byte accounting

Every part and final artifact has a required `storageVersion`. Trusted storage
adapters must pin that exact immutable object version and independently return
`verified: true`, `immutable: true`, `rowCountVerified: true`, plus matching
`storageKey`, `storageVersion`, `checksum`, `rowCount`, and `byteCount`.
Version identity is included in the ordered part-set hash; a mutable key or ETag
without immutability guarantees is insufficient.

`jobs.bytes_committed` always counts stored intermediate-part bytes.
`artifacts.byte_count` counts final downloadable bytes, and
`artifacts.source_byte_count` records the intermediate total used in assembly.
The trusted final-artifact verifier binds the ordered part-set hash and returns
the matching `sourceByteCount` and format accounting version:

| Format | Version | Final object semantics |
| --- | --- | --- |
| CSV | `csv-assembled-v1` | Serialized CSV with the approved header/encoding/assembly policy |
| JSONL | `jsonl-assembled-v1` | Assembled JSONL with the approved newline/encoding policy |
| XLSX | `xlsx-packaged-v1` | Final packaged XLSX workbook, including container overhead/compression |

The repository verifies independent final size/rows, durable part totals and
format contract; it never equates intermediate bytes with final bytes.
Intermediate bytes have an 8 GiB budget; final output has the existing 2 GiB
budget. Accounting adapters must verify assembly semantics, not just echo a
version tag. Final expiry is checked using PostgreSQL time and limited to 30 days.

## Outbox and errors

Dispatch claims join authoritative QUEUED, uncancelled job state and the active
installation. Expired dispatch ownership becomes UNKNOWN; expired reconciliation
ownership becomes UNKNOWN with a higher fence and backoff, eventually REVIEW_REQUIRED.
Reconciliation exceptions are retried with a bounded policy rather than
immediately requiring review. Redelivery requires positive `safeToRetry` evidence;
confirmed delivery requires positive confirmation. Each new execution release
creates a new logical outbox event; retrying one event preserves its delivery key.

Idempotency compares the original request fingerprint, returning its existing
immutable manifest even if a fresh publication resolves differently. Public
database errors use stable export codes and redact raw dependency messages.
BIGINT counters/fences are decimal strings; unsafe JavaScript numeric fences
are rejected. PostgreSQL `clock_timestamp()` decides ownership, deadlines and
retry eligibility.

Competing finalizers for the same immutable artifact return the one registered
outcome; exact completion replays do not mutate terminal state. A different
object version, checksum, format, row/byte count, part count, expiry or checkpoint
fails integrity validation. This is idempotent database registration, not proof
that a production storage adapter uploads or assembles bytes idempotently.

## Verification

`web/export/export-repository-contract.test.js` adapts the supplied scripted-pg
tests to the current generation-protection, immutable-version and DB-time lease
contracts. It checks early identity/sequence rejection, stale heartbeats,
rollback after part insertion, expired delivery becoming UNKNOWN, and refusing
retry/delivery without positive evidence. Unexpected SQL fails the double;
mock verification adapters remain confined to the test file. These tests assert
control flow and statement ordering, not PostgreSQL semantics or concurrency.

Run those checks with:

```powershell
node --test web/export/export-contract.test.js web/export/export-lifecycle-repository.test.js web/export/export-repository-contract.test.js
```

Run focused export and Mirror tests with Node's test runner. Run the real
database recovery suite using `node web/scripts/test-filter-postgres.js --exports`
with Docker or `FILTER_POSTGRES_BIN` pointing to a complete local PostgreSQL
runtime. The runner creates a disposable database and never reads the app's
DATABASE_URL. Tests include stale fences, concurrent recovery, cancellation,
recovery-owner crashes, external uncertainty, immutable versions, independently
verified row counts, format accounting, outbox reconciliation crashes/backoff,
generation renewal/release, retry limits and application-clock skew. Concurrent
checkpoint commits, retry scanners and finalizers are exercised against real
PostgreSQL connections. Storage/queue evidence uses test adapters; production
the production verification logic reads and compares actual stored bytes in
those tests. Live S3/BullMQ service smoke tests remain a separate deployment check.
