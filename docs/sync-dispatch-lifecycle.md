# Dispatch lifecycle migration

Migration: `20261029000400_sync_dispatch_lifecycle`.

The repository migration history already defines `mirror.sync_dispatches` and
the older scheduling table `mirror.sync_dispatch_shops`. The lifecycle migration
extends the ledger and renames that scheduling table into
`mirror.sync_dispatch_schedule`, preserving its fairness cursor. It backfills
every existing shop rather than introducing a parallel scheduling authority.
The existing tenant, execution and bigint SyncRun foreign keys and
`(shop_id, delivery_key)` uniqueness remain intact.

The ledger accepts PENDING, RESERVED, UNKNOWN, ENQUEUED, RECONCILING,
RETRY_ELIGIBLE, CONSUMED, REVIEW_REQUIRED and CANCELLED. New nullable columns store
recovery token/deadline/reason, consumption time and review time. Existing review
rows receive their previous update timestamp. Partial recovery/due indexes and
the schedule eligibility index match the lifecycle access paths.

Scheduling is maintained in the database for installation, soft uninstall,
reinstallation and physical deletion. Repository reservations check and lock the
scheduling row. Terminal notifications and live reconciliation leases cannot be
redispatched. The expiry scanner releases only expired reconciliation leases,
retaining the logical delivery key. ENQUEUED continues to mean queue insertion,
never worker completion.

## Configured database preflight — 29 October 2026

Ran `node web/scripts/inspect-dispatch-migration-state.js` against the configured
database using a Repeatable Read, READ ONLY transaction. The script reads schema
metadata and migration records; it never deploys migrations or prints secrets.
Evidence is in `.audit/dispatch-lifecycle-installed-state.json`.

- Database: `newmeta_app`.
- Eight migrations are applied, through
  `20261029000100_catalog_import_executions`.
- Every installed migration checksum matches its repository file.
- No installed dispatch ledger or scheduling relation exists.
- Pending dispatch chain: `20261029000200_sync_dispatch_reservations`,
  `20261029000300_sync_dispatch_ledger`, then the lifecycle migration.

The lifecycle SQL was **not applied to the configured database**: its required
existing dispatch ledger is absent. The two prerequisite migrations need a
reviewed deployment first; applying this migration by itself would fail. No
production schema or migration-history records were changed by the preflight.

## Verification

The full migration chain passes in disposable PostgreSQL, including populated
predecessor schemas and preserved ledger history. Checks cover schedule backfill,
fairness history, installation/uninstall/reinstall/deletion, lifecycle states,
retry gating, terminal deliveries and reconciliation leases.

- Backend: 827 passing tests, zero failures, one existing TODO.
- PostgreSQL: 108 passing tests, zero failures.
- Prisma 7.10.1 schema validation passes.
