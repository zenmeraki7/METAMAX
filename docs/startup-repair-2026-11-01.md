# Shopify admin startup repair — 1 November 2026

The checkout's client ID resolves to **Metav3**, installed on Demo Zen Store at
`https://admin.shopify.com/store/demo-zen-store/apps/metav3`. The separate
`metamax` installation opened earlier is not this checkout.

Shopify CLI now authenticates and starts its tunnel and frontend. Express crashes
in `web/db/postgres.js:38` because `CATALOG_WORKER_DATABASE_URL` is absent.
`OPERATION_WORKER_DATABASE_URL` is absent too. The configured application branch
is `br-frosty-darkness-aod5t1wf`, database `newmeta_app`; it has 19 completed
migrations. The checkout contains 43 migration directories, leaving 24 pending.
The worker profiles do not yet exist in that database. Reusing the merchant or
migration-owner connection for workers would violate the declared profiles.

The deployment needed for the current checkout includes the pending migration
lineage, separate restricted worker logins, writing their credentials into ignored
`web/.env`, and restart. Pending changes include history/export structures,
catalog download/retention structures, worker privilege separation, and execution
provenance. Legacy schedules without installation provenance are disabled and
active legacy occurrences marked for review. These are durable database changes,
not a frontend repair. No pending migration or new credential was applied to the
application database during diagnosis.

Validation:

- Shopify CLI network/authentication and frontend startup now work.
- Creating a fresh Neon test branch failed: branch limit exceeded.
- An existing rehearsal branch was used for migration testing. The initial
  outer-transaction rollback did not contain migration files' own COMMITs;
  some pending migrations were committed to that test branch without updating
  its migration ledger. It must not be treated as a clean migration baseline.
  A subsequent rehearsal stopped at an existing index. The application branch
  was not used for this rehearsal.
- Docker PostgreSQL schema/integration checks were run with
  `npm --prefix web run test:schema`. The command failed, including SQLSTATE
  42501 permission errors on `mirror.shops` and HTTP authorization expectations
  receiving 500. These failures require investigation; the upgrade is not
  certified by this run.

Next: resolve the role/profile integration failures in a disposable local
database, verify the complete ordered upgrade and runtime profiles, then apply
the reviewed migrations and provision worker credentials on the application
branch. Finally restart Shopify CLI and verify the embedded app in Chrome.
