# Dispatch migration deployment — 29 October 2026

The four dispatch migrations were deployed to the configured live database after
the user explicitly authorized deployment. This closes the migration deployment
step; overall syncing remains an integration candidate.

## Target and migration history

- Neon project: `bitter-dream-29677040`.
- Configured branch: `express-backend-20261027`
  (`br-frosty-darkness-aod5t1wf`). This is not the project's default branch.
- Database: `newmeta_app`; application schema: `mirror`.
- Preflight: eight completed migrations, matching local checksums, no dispatch
  ledger or scheduling tables and exactly four pending migrations.
- Applied successfully:
  - `20261029000200_sync_dispatch_reservations`
  - `20261029000300_sync_dispatch_ledger`
  - `20261029000400_sync_dispatch_lifecycle`
  - `20261029000500_dispatch_consumption_receipts`
- Final history: twelve completed migrations with matching checksums and no
  pending migrations. The canonical Prisma schema diff reports no difference.

## Recovery copy and isolated validation

A fresh branch, `dispatch-deploy-recovery-20261029`
(`br-long-credit-aoc5hnxe`), preserves the predeployment database at parent LSN
`0/B34A8F8`, timestamp `2026-10-29T12:09:42Z`.

Neon's branch limit prevented creating a separate second validation branch.
Instead, the unchanged recovery branch database `newmeta_app` was streamed into
scratch database `dispatch_validation_20261029` on that branch. Only the scratch
database received test migrations. Its data preservation, physical mappings,
startup verification and canonical schema diff all passed before live deployment.
The recovery branch's original `newmeta_app` remains the recovery copy; the
migrated scratch database is not a predeployment recovery source.

Temporary compute `ep-falling-pond-aofxlzmy` was suspended after validation.
Neither branch nor database was deleted. Reopening a database connection can wake
the endpoint. Recovery requires a deliberate operational decision; no automatic
rollback or application connection switch was performed.

## Live verification

- Runtime storage verification passed without starting workers or requesting
  Shopify operations.
- All 28 filter field mappings passed physical-schema verification.
- Every existing shop has scheduling authority; no obsolete duplicate dispatch
  authority tables remain.
- All 43 preexisting application/session tables retained their row counts and
  fingerprints over original columns. Application business tables were empty at
  deployment; the existing session migration records were preserved. This is not
  evidence of a completed merchant sync.
- The application `.env` file remained byte-for-byte unchanged.
- Prisma reports the database schema up to date and no difference from the
  canonical schema.

Evidence is stored under `.audit/dispatch-deploy-*`, including the installed
preflight, scratch validation, live Prisma deployment log, before-table
fingerprints, live verification, migration status and schema diff. These reports
contain metadata and fingerprints, not connection credentials or table contents.

The operational script is `web/scripts/deploy-dispatch-migrations.js`. It pins
destinations, validates installed checksums, rejects an unexpected pending
migration set, requires matching scratch-tested migration hashes before live
deployment, checks active execution leases and verifies preservation afterward.
It uses a host-local Prisma cache/runtime and is a deployment record/tool for this
environment, not a portable CI deployment command.

BullMQ/Redis transport, authoritative recovery evidence and deployed end-to-end
failure/restart testing remain open; see `dispatch-release-readiness.md`.

## Approved follow-up: recovery evidence and app startup

The user subsequently approved migration
`20261029000600_sync_dispatch_recovery_evidence` explicitly after automatic
approval review required authorization beyond the original four migrations.
It was validated against the existing isolated scratch database, then applied
to live `newmeta_app`. All thirteen migrations have matching checksums, the
canonical Prisma schema diff is empty, runtime storage verification passes and
all 45 preexisting tables retain their row counts and fingerprints. The Prisma
`observedAt` default was aligned with SQL's `clock_timestamp()`.

Evidence: `.audit/recovery-evidence-{scratch,live}-verification.json` and
`.audit/recovery-evidence-{scratch,live}-migration.txt`. The original recovery
database remains unchanged and its temporary compute was suspended again.

The Shopify development preview was started for `demo-zen-store.myshopify.com`.
The backend returned `{"status":"ok"}` from `/health`, the frontend served
JavaScript successfully and PostgreSQL, Redis and the Filter Engine initialized.
The required `read_inventory` scope was added for configured inventory webhooks;
Shopify CLI configuration validation passes. Background worker lock timeouts
were observed, so successful startup does not establish end-to-end sync safety.
`.audit/app-running-20261029.json` records the active process session and URLs.
