# Verified synchronization SQL adapter and recovery coordinator

Production integration now lives in `catalog-phase-integration.md`. Migration
`20261029000100_catalog_import_executions` adds the explicit one-to-one execution
extension and immutable external-operation ledger. Startup supplies production
validators, phase steps, recovery and dispatch for PHASE jobs. The live-schema
gap below records the pre-integration inspection, not the new migration shape.

The supplied adapter and corrected transaction/recovery direction are implemented
in `web/mirror/sync-run-db-adapter.server.js`, `sync-run-schema.server.js`,
`sync-db-transaction.server.js` and `sync-recovery.server.js`.

## Driver and physical mapping

The adapter accepts one existing `database` PostgreSQL pool or `prisma` client.
The application continues to use `pg`. The optional Prisma path receives an
existing generated-client instance; there is no guessed `@prisma/client` import
or newly installed ORM. Its options and parameterized query methods follow the
[Prisma 7 transaction API](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)
and [raw-query API](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries).
Actual database tests exercise `pg`; Prisma interface tests use explicit mocks.

Values are parameterized. SQL identifiers come from a captured, physically
verified mapping capability issued by `verifySyncRunDbMapping`. Plain mappings,
copied receipts, different database clients and schema drift fail closed.
Revalidation occurs within the protected transaction, and relation locks keep
the verified tables stable through use. Physical proof is not authorization.
Reads and mutations now share one private verified-transaction wrapper; no
adapter callback executes before schema revalidation. SQL layout construction,
claim capture and transaction-local mutation handling are separate private helpers.

Verification requires text identities, global run-ID uniqueness for ID-only
notification lookup, a non-null tenant-bound generation, exact phases, an int4
attempt counter with a bounded check, a nonnegative int8 fence, the expected
timestamp/boolean/nullability contracts, mandatory due/lease indexes and foreign
keys to the actual shop and generation registries. SQL/repository claim budgets
must match and cannot exceed the physical attempt check.
Production mappings additionally project the existing `recovery_attempts` column
after verifying its int4 type, nullability and zero-through-eight check. Its absence
cannot be treated as a fabricated zero by repository recovery eligibility.

Claims conditionally match shop, generation, phase, prior fence/attempt, due
eligibility and the SQL limit. Final writes also check owner token, live database
time, attempt, cancellation, uncertainty and review. Failure writes never increment
attempt; successful step writes reset it to zero. The fence stays monotonic.
`getRunState({runId,shopId})` supports fresh durable inspection after an
ambiguous acknowledgment; reading state does not authorize an external action.

## Transactions and lock order

Transactions are Serializable and retain the existing coarse publication lock.
The order is **publication barrier relation lock, then shop row, run row, intent,
evidence/checkpoints and publication rows**. The barrier is distinct from final
publication row locks and remains first for compatibility with existing writers.
Validated static `SET LOCAL` commands avoid establishing an MVCC snapshot before
the barrier. SELECT queries use query methods, not execute methods.

`runSyncDbTransaction` is restricted to reviewed DB-only callbacks. Known aborted
serialization/deadlock conflicts receive bounded retries. Connection failures
before or after callback completion are OUTCOME_UNKNOWN, with no automatic retry.
Callback completion is not proof of COMMIT. The `pg` SQL capability closes at its
deadline, preventing late callbacks from writing through a released transaction.
COMMIT shares that deadline. A hung acknowledgment discards its connection and
remains uncertain instead of queuing rollback behind the unresponsive operation.
The same deadline now bounds BEGIN and rollback cleanup. Explicit uncertainty
anywhere in an error cause chain takes precedence over a retryable wrapper code.
Adapter SQL capabilities close when their callback ends on both driver paths.
JavaScript cannot prove callback purity: HTTP, Shopify, Redis, filesystem and
other nontransactional effects must remain outside this wrapper.

The coarse barrier still serializes merchants. Tests confirm cross-shop blocking;
no narrower replacement is introduced.

## Evidence and recovery

The SQL adapter itself requires phase/publication evidence verified in the same
transaction before ADVANCE/COMPLETE, even when called directly. Proof is private,
bound to the exact locked claim and consumed on use. Re-locking, renewal or other
mutations invalidate it. A validator that finishes after the locked authority has
changed cannot issue proof. Validators receive the authoritative locked row;
caller-supplied row additions do not become evidence or execute accessors.

`verifyShop`, `verifyStepEvidence` and `verifyPublished` are mandatory server-owned,
transaction-aware callbacks. There are no permissive production defaults. They
must check current installation/run eligibility and durable evidence for the exact
tenant, run, generation, phase and fence. The SQL adapter cannot prove an arbitrary
callback's business semantics. Test callbacks query real fixture evidence,
ingestion/checkpoint/row counts and the existing generation service's actual
publication. Production validators now live separately in
`catalog-execution.server.js` and query the migrated orchestration records.

The recovery coordinator (`createSyncRecoveryOrchestrator`, with its prior
`createSyncRecoveryService` alias) claims work, performs bounded read-only external
verification outside transactions and sends immutable evidence to an injected
recovery repository. That repository must atomically verify recovery ownership,
intent identity, generation, lease and evidence before clearing uncertainty.
CONFIRMED/SAFE_TO_RETRY require explicit authoritative evidence; an authority flag
alone is not proof, and a weak or inconclusive remote lookup is insufficient.
UNRESOLVED cannot produce RESUMED. Errors/timeouts persist a fenced failure, and
unverified decision acknowledgments remain uncertain. No browser recovery setter
is installed. The production recovery repository and
exact-operation verifier are supplied privately by `catalog-sync-recovery.server.js`.
Persistence is now extracted into `sync-recovery-repository.server.js`, which
revalidates the fixed physical mapping and applies a complete recovery-owner CAS
to final writes. See `sync-recovery-repository.md` for its transaction contract.
See `sync-recovery-orchestrator.md` for bounded repository stages, cancellation,
strict acknowledgments, unknown outcomes and terminal-review reporting.

## Verified live-schema gap before the execution migration

Read-only Neon inspection on 29 October 2026 confirmed:

- `mirror.ingestion_runs` uses the bigint ingestion identity and ingestion lease
  contract, not the required text orchestration/phase contract.
- `mirror.catalog_import_jobs` has a nullable initial generation and lacks the
  required phase, recovery and owner-token columns. Its physical attempt cap is
  eight, not twelve.
- `mirror.sync_external_operations` does not exist.

The new physical verifier rejected both run-table candidates in read-only mode.
At that inspection no execution migration had been created or applied and the
adapter was not wired to startup. The integration document describes its replacement.
`generation_read_leases` remains reader/dependent-job retention and is unchanged.

Activation requires a deliberate extension of the existing orchestration model,
its generation-allocation boundary and its relationship to the ingestion lease.
Every ingestion write must validate that same authority hierarchy. The proposed
external ledger needs a confirmed run identity and composite tenant/run/generation
foreign keys; its text run ID must not be attached blindly to the bigint ingestion
ID or a nullable, unbound generation. PREPARED/DISPATCHING intent must precede an
external request. Ambiguous starts remain blocked until verified recovery. The
pasted ledger proposal is therefore documented rather than deployed as speculative
SQL or as a parallel execution authority.

## Verification

- Backend: 805 passed, zero failed, one existing TODO.
- Disposable PostgreSQL schema/integration suite: 82 passed, zero failed.
- PostgreSQL filter regressions: 20 passed, zero failed.
- Coverage includes schema rejection, real claim/renewal CAS, duplicate delivery,
  tenant isolation, expiry, attempt limits, cancellation, uncertainty, durable
  ingestion/publication evidence, preserved lock order, real Serializable retries,
  drift, late writes and a durable COMMIT with a deliberately lost acknowledgment.
- Unit tests cover Prisma interface calls, nested error classification, retry
  bounds and recovery outcomes.

Evidence: `.audit/sync-adapter-live-schema.json`,
`.audit/sync-adapter-live-activation.json`, `.audit/sync-db-unit.txt`,
`.audit/sync-db-backend.txt` and `.audit/sync-db-schema.txt`.
