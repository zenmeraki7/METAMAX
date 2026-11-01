# Schema drift and role verification — 1 November 2026

The reported drift and integration failures are repaired. Three forward migrations
were applied to the configured `newmeta_app` database. All 49 migrations have
matching local checksums. Application rows were not removed or rewritten by the
repair: the database retained one shop, 21,987 products and 22,034 variants.

## Database repairs

- `20261101001100_complete_export_tenant_policies` restores RLS and the exact
  `metamax_tenant_isolation` policy on `export_engine.jobs` and
  `export_engine.target_approvals`. Replay is safe. An incompatible existing
  policy aborts the transaction instead of broadening access or partly applying.
- `20261101001200_catalog_worker_readiness` exposes only a lifecycle boolean to
  the operation worker. Discovery no longer needs catalog-import table access.
  Claim and dispatch triggers retain the advisory barrier and live checks.
- `20261101001300_catalog_installation_cleanup` grants the catalog worker DELETE
  and SELECT of `subscriptions.shop_id`, under existing tenant RLS, for reinstall
  cleanup. It grants no billing-field read, INSERT or UPDATE. An unused external
  SECURITY DEFINER grant is removed from the history runtime role.

A fresh PostgreSQL 18.6 replay and the live database now match for normalized
application DDL, all 106 policies, object/column ACLs, schema-scoped default
privileges and normalized migration/function ownership. Canonical Prisma models
and the refreshed 70-model introspection snapshot each report no differences.

The comparison covers `mirror`, `export_engine` and `edit_history`; it excludes
application row contents, database-wide settings, deployment login membership,
external infrastructure and adapter-owned `public` session tables. Public session
storage has its own restricted-login integration test.

## Runtime and integration corrections

Approval and undo transactions initialize tenant scope from authenticated
identity before RLS reads. Schedule discovery binds each occurrence to the
persisted schedule's tenant and installation, then independently authorizes every
execution phase. Terminal failed occurrences remain immutable on cancellation.

Export workers await installation-bound authentication capture. History hooks
receive an expiring, exact-tenant publication read-lock capability while arbitrary
LOCK, transaction control and writes remain unavailable through their query API.

Historical item completion verifies current worker ownership and exact immutable
approval, target, item, field and value evidence. Expired approvals or replaced
publications do not prevent inspecting a write that is already verified, and do
not grant new send authority. A lost completion COMMIT acknowledgment is recovered
from the exact durable item/snapshot/evidence state without resending Shopify writes.

Fixtures now use the correct catalog-worker profile, current stored-session and
installation guards, real successful-import evidence, current write-capability
versions and staged-download checkpoints. Global-scanner tests wait for their
own job's result instead of depending on UUID service order. No guards were
disabled and no migration-owner credentials were substituted for tested runtime
roles to make execution pass. Admin fixtures only seed and inspect test data.

Method-specific authority, lifecycle, transaction and uncertainty contracts are
recorded in [the backend interface standard](backend-interface-contracts.md).
Existing working-tree changes present before this work were retained.

## Subsequent role-coverage finding

The [Priority 3 test run](integration-migration-test-run-2026-11-01.md) confirmed
that the export suite uses owner-backed execution. A production-equivalent
merchant-role probe fails enabled export startup with PostgreSQL 42501. The
passing export test count below is lifecycle evidence, not production-role
compatibility certification. No export grants were broadened.

## Verification results

| Check | Result |
| --- | --- |
| Backend suite | 1,337 passed, 0 failed, 1 skipped |
| Complete PostgreSQL schema suite | 167 passed, 0 failed |
| Actual-role RLS/rollback suite | 13 passed, 0 failed |
| Operation dispatch PostgreSQL suite | 21 passed, 0 failed |
| Export PostgreSQL suite | 33 passed, 0 failed |
| Fresh history PostgreSQL suite | 111 passed, 0 failed |
| History upgrade PostgreSQL suite | 112 passed, 0 failed |
| Both Prisma schema validations | Passed |
| Canonical Prisma -> live diff | No difference |
| Refreshed snapshot -> live diff | No difference |
| Migration replay -> live DDL/policy/privilege comparison | No difference |

Counts are suite-local and include Node parent tests; do not sum them as unique
coverage. The initially green filter/Phase 1/progress suites were also audited;
the final full schema suite exercises the integrated catalog/filter paths.

Reproduce the principal role gate from the repository root:

```powershell
npm --prefix web run test:roles:postgres
npm --prefix web run test:schema
npm --prefix web run test:operations
npm --prefix web run test:exports
npm --prefix web run test:history:postgres
npm --prefix web run test:history:upgrade
npm --prefix web test
```

The PostgreSQL runner creates disposable localhost databases and never reads the
application DATABASE_URL. Set FILTER_POSTGRES_BIN to a PostgreSQL binary directory
for native clusters, or use its Docker fallback. The full suite has a bounded
five-minute deadline; the verified schema run took about 141 seconds.

The role suite uses genuine non-owner, NOSUPERUSER, NOBYPASSRLS logins inheriting
the actual migration-defined merchant, catalog-worker, operation-worker and
history profiles. It verifies transaction-local tenant initialization, connection
reuse without leaked scope, cross-shop denied writes, rollback of earlier allowed
writes after denial, worker domain separation, history field immutability, rejection
of mixed membership, and both successful and adversarial incremental RLS repair.

Read-only checks also verified the configured live `metamax_app_runtime`,
`metamax_catalog_runner` and `metamax_operation_runner` logins and effective role
profiles. Live HISTORY_DATABASE_URL, HISTORY_MAINTENANCE_DATABASE_URL and
HISTORY_PRIVACY_DATABASE_URL are not configured. History behavior was verified
with real restricted roles in disposable PostgreSQL, not a deployed history login.

Task-local evidence is retained under `.audit/`: `drift-summary.json`,
`drift-repair-result.json`, `live-role-verification.json`, `verified-schema.log`,
`verified-roles.log`, `verified-history.log`, `verified-history-upgrade.log`,
`final-operations.log`, `final-exports.log`, `final-backend-green.log`,
`final-canonical-live-drift.log` and `final-live-snapshot-drift.log`.
