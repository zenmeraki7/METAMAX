# Mirror synchronization audit fixes — 1 November 2026

- Checkpoint pages now read on a transaction connection after transaction-local shop scope is initialized. Pool-level checkpoint queries and the optional-read fallback are removed. Existing replay checksum validation and independent write fencing remain enforced.
- The legacy bulk-start path commits a query hash and dispatch fence before sending Shopify a request. It saves exact response evidence separately, then binds under current run authority. An ambiguous start cannot be resent automatically; exact late evidence can be bound by a replacement lease. The existing phase-managed external-operation ledger remains separate.
- Failure/cancellation recording errors now propagate in an AggregateError carrying both errors, the original cause, a bounded diagnostic code and outcome uncertainty. No new raw-error logging is introduced.

Contracts: [legacy bulk start and ingestion recovery](backend-interface-contracts.md#legacy-bulk-start-and-ingestion-recovery).

## Verification

- Selected mirror, worker and catalog service unit tests: 309 passed, zero failed or skipped. The final cleanup was additionally checked with 23 focused tests, all passed.
- `npm --prefix web run test:roles:postgres`: 20 passed, zero failed or skipped, on disposable PostgreSQL 18.6 using real restricted logins. This includes concurrent bulk-start fencing, blocked redispatch after lease replacement, conflicting response evidence rejection, and exact late-evidence recovery.
- `npm --prefix web run test:schema`: 168 passed, zero failed or skipped, including a fresh replay of the new migration and existing ingestion/reconciliation/publication/concurrency integration checks.
- The deployed catalog-worker profile intentionally has global control-plane reads on ingestion checkpoints. The initial RLS failure hypothesis is therefore not reproduced under that profile. A separate actual NOBYPASSRLS login with tenant-only SELECT grants confirms unscoped reads see no checkpoints, the fixed replay succeeds, and transaction scope does not leak after commit.
- Existing bulk-start GraphQL validated by the Shopify AI Toolkit for the configured API version, 2026-10. No GraphQL operation shape changed.

Docker was unavailable and sandbox localhost connections were denied. Successful database runs used the existing native PostgreSQL binaries through the isolated runner outside the sandbox. The runner created and removed disposable databases; no live database migration, data, credentials or policy was changed. Real Shopify process-crash injection was not performed; remote response loss uses test doubles, alongside actual PostgreSQL transactions and concurrency.

## Rollout

Apply `20261101001500_legacy_bulk_start_intent` before deploying the code. The startup storage check requires the three new columns. Canonical Prisma and the live-schema reference include them. This additive migration does not reconstruct historical unjournaled remote starts. A lost remote response can still leave a physical Shopify operation without a saved local ID; its durable dispatch intent blocks duplicate starts and requires authoritative/manual recovery. No claim of cross-system atomicity is made.

## Expanded register follow-up: SYNC-004 and SYNC-005

`getSyncRun` and `scanDueDirtyProducts` now execute their existing parameterized, shop-predicated SELECTs through `transaction(database, callback, shopId)` on the connection that initializes transaction-local scope. The existing return shapes, bigint handling, run absence result, scanner bounds/order and due/dirty/dead-letter/lease predicates are preserved. Neither read claims work or acknowledges revisions. Method-specific contracts are recorded in [tenant-scoped sync discovery](backend-interface-contracts.md#tenant-scoped-sync-discovery).

Current validation: 311 selected unit tests and 21 PostgreSQL role tests passed, with zero failures or skips. A real NOBYPASSRLS login with only tenant-scoped SELECT grants proves both methods work where direct unscoped reads return zero rows. Checks cover a foreign-shop run ID, alternating shops on a one-connection pool, due versus delayed/leased/dead-letter/clean rows, result bounds and unchanged revision/acknowledgement state. Unit checks prohibit pool-level reads and verify read-failure rollback. The first three fixes remain present and their regression tests pass. The 168-test schema result above belongs to the preceding change; that full suite was not rerun for this follow-up.

This follow-up requires no additional migration and makes no live database or Shopify changes. The prior bulk-start-intent migration remains required for rollout. Only five finding IDs (SYNC-001 through SYNC-005) were supplied in the expanded register; no verification claim is made for unspecified findings.

## Authorized migration deployment

After the fixes above, the operator explicitly requested deployment of `20261101001500_legacy_bulk_start_intent`. Prisma applied only that migration to the configured Neon `newmeta_app` database. All 50 prerequisite migration checksums matched local files before deployment. Verification confirmed the finished Prisma ledger record, all three nullable columns with their expected types and no defaults, and the validated `ingestion_bulk_start_intent` check constraint. The earlier statements about no live changes describe the fix/test phase; the migration is now installed.

Before the subsequent Git push, the full backend suite passed: 1,346 passed, zero failed, one skipped (1,347 total). The existing database-role and schema results remain separately documented above.
