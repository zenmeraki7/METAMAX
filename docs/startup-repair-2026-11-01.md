# Shopify admin startup repair — 1 November 2026

## Completed migration deployment

The user authorized the pending migrations and separately approved the restricted
worker logins. All 24 original pending migrations plus
`20261101000800_complete_incremental_tenant_policies` have now been applied to
`br-frosty-darkness-aod5t1wf` / `newmeta_app`. Prisma reports **44 applied, none
pending**. Original applied migration checksums were verified and preserved.

Scope review confirmed the pending migrations support retained source:

| Migration group | Current owning source |
| --- | --- |
| Operation identity, schedules, approval and finalization | `web/services/{approval,schedules,job-dispatch}.server.js`, `web/workers/` |
| Import preview | `web/services/import-preview.server.js` |
| Export manifest, lifecycle, delivery and installation | `web/export/`, routers imported by `web/app.js` |
| History requests, security, Undo and resource identity | `web/edit-history/`, router imported by `web/app.js` |
| Catalog spool, retention and worker separation | `web/mirror/`, services started by `web/index.js` |

The deleted frontend demo data/helpers require no migrations. No removed feature
implementation was restored. The README's foundation-era removal paragraph is
historical; the current entry points import the modules above.

An exact database copy was restored into disposable Docker PostgreSQL before
deployment. The upgrade revealed an ordering gap: the existing tenant-policy
migration had run before seven older pending tables existed. The new follow-up
adds their scoped RLS policies, the original intended restricted SELECT grants,
and the history maintenance policies omitted by that ordering. Existing
migration files were not rewritten. Final migration bytes passed the clone
rehearsal, all three runtime-profile verifiers passed, and four profile/adversarial
unit checks passed. This is migration/startup validation, not a claim that the
earlier full integration suite now passes.

Before/after counts: **14,987 products, 15,034 variants, one shop**. A pre-upgrade
custom-format backup is retained in ignored `.audit/startup-repair/live-before.dump`.
Audit reports and Prisma status are in `.audit/startup-repair/`.
The catalog and operation worker logins were provisioned with separate restricted
roles; credentials are only in ignored `web/.env`. Live verification confirms
neither owner nor BYPASSRLS access and checks 61 tenant tables for every profile.

The Shopify development server starts successfully: Postgres, Redis, Filter
Engine, and Express are ready. Local and public-tunnel health checks return 200.
The embedded admin page is still blank, and the running sync dispatcher reports
`DELIVERY_OUTCOME_UNKNOWN` / `RESERVATION_FAILED`; these runtime issues are not
certified fixed by the migration deployment.

The remaining text records the earlier diagnosis, before this deployment.

## Earlier diagnosis

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
