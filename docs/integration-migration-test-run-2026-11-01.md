# Priority 3 integration and migration test run — 1 November 2026

All three requested commands passed on isolated PostgreSQL 18.6 databases.
Production-role compatibility is not fully certified: enabled export bootstrap
fails with PostgreSQL 42501 under the restricted merchant role currently supplied
by the application composition root. The export integration suite's owner pool
conceals that integration gap.

## Commands and results

Executed from web/, using the existing native PostgreSQL binaries through
FILTER_POSTGRES_BIN. Each runner invocation created a new localhost database with
a random test password and cleaned it up afterward. No live database data,
permissions, credentials or RLS settings were changed.

| Command | Passed | Failed | Role/migration coverage |
| --- | ---: | ---: | --- |
| npm run test:postgres | 20 | 0 | Owner-created reduced SQL fixture; filter semantics, SQL constraints, cancellation and snapshot concurrency. Does not install the production role schema |
| npm run test:exports | 33 | 0 | Replays all 49 current migrations. Fixture, lifecycle repository and production source/storage/worker orchestration use the migration-owner pool |
| npm run test:history:postgres | 111 | 0 | Migration/upgrade constraints use owner fixture access; current repository, worker, runtime, maintenance and privacy execution use restricted logins inheriting the migration-defined role profiles |
| npm run test:roles:postgres | 17 | 0 | Real merchant, catalog-worker, operation-worker and history logins; NOBYPASSRLS, tenant scope, denied writes, rollback, role separation and scheduling boundaries |
| npm run test:schema | 167 | 0 | Fresh replay of all 49 migrations; integrated catalog/filter, selection, scheduling, ingestion, reconciliation, HTTP, RLS and concurrency checks, including restricted runtime profiles |

All suites had zero skipped tests. Counts are suite-local Node runner counts,
including parent tests; overlapping coverage must not be summed as unique tests.
The full schema suite took about 149 seconds. No database/concurrency check above
was substituted with a unit test.

## Production-equivalent export-role probe

The application [composition root](../web/index.js) supplies the merchant database
facade to createExportRuntime when exports are enabled. A separate probe replayed
all migrations, created an actual LOGIN inheriting only metamax_engine_runtime,
verified NOSUPERUSER/NOBYPASSRLS, and attempted that runtime's database preflight.

Observed result:

- Profile: metamax_engine_runtime.
- Export bootstrap ready: false.
- PostgreSQL code: 42501 (insufficient privilege accessing export_engine).
- Redis/S3 services started: false; the probe stopped at database preflight.

The diagnostic test passes by confirming and recording this failure. It is not
a passing export production-role compatibility test. The 33 owner-backed export
integration tests do not demonstrate that exports can start or execute under the
current deployed role split.

The remaining integration work is a reviewed export database gateway/profile and
matching tenant/worker authority tests, followed by running the export execution
suite through those credentials. Migration-owner fallback, disabling RLS, or
broadening the HTTP merchant login were not used to make the result green.

The reduced filter semantics fixture similarly cannot certify production-role
behavior alone; the additional current-schema and real-role suites provide the
separate integrated filter/RLS evidence. History uses owner access for schema
setup and deliberate corruption probes; its application repository connections
are restricted history logins, with separate issued merchant/worker profiles.

## Evidence

- .audit/priority3-postgres.log
- .audit/priority3-exports.log
- .audit/priority3-history.log
- .audit/priority3-roles.log
- .audit/priority3-schema.log
- .audit/priority3-export-role-probe.log
- .audit/priority3-export-role-result.json

This run supplements [the drift repair verification](schema-drift-and-role-verification-2026-11-01.md)
and [the schedule boundary review](schedule-transaction-boundaries-2026-11-01.md).
The current live history credentials remain unconfigured; this run used real
restricted history roles on disposable databases rather than a deployed history
login. Live migration state was not changed or re-certified during this priority.
