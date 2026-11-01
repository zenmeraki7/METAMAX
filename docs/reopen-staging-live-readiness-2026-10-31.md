# Reopen verified staging: live readiness check

Requested migration: `20261031130000_reopen_verified_staging`.

SHA-256: `176e23dfce2373afd43b82faac2c579317a4bb5935670e393a5467b194d16c50`.

Verified application target: Neon project `bitter-dream-29677040`, branch `express-backend-20261027` / `br-frosty-darkness-aod5t1wf`, database `newmeta_app`. The project's default branch is not the deployment target.

Read-only live checks:

- The requested migration is absent from `mirror._prisma_migrations`.
- All 16 recorded, completed migration checksums match their current local files. No unfinished migration was returned.
- `mirror.guard_generation_status()` still has the original expected definition, without the staging-reopen exception. No newer live function changes were identified.
- The required catalog import executions, catalog import jobs and catalog changes relations exist.
- Exactly one enabled `guard_generation_status` trigger is installed on mirror.generations.

Deployment must stage only the applied lineage plus this requested migration. Numerous unrelated migrations are still pending locally; do not run an unrestricted `prisma migrate deploy` against the full directory.

The migration replaces the guard function only. It preserves the existing guards and adds the narrowly bounded VERIFIED-to-RECONCILING exception for unpublished staging with dirty work and a live eligible execution. It does not authorize changing published snapshot rows.

Prior disposable PostgreSQL regression tests passed, including both late-webhook windows. Rehearsal against a fresh copy of the live branch remains outstanding: Neon rejected creation of `reopen-staging-rehearsal-20261031` with `branches limit exceeded` (HTTP 422). No branch was created, removed, reset or repurposed. No live DDL or migration-ledger write was performed.

Next: make a branch slot available, create a rehearsal branch from the explicit application branch, test this exact migration and migration-ledger deployment there, then deploy only this migration through the existing Prisma/direct-connection workflow and verify the guard definition and recorded checksum. Retain the original guard definition/recovery point; do not automatically reset the live branch as rollback.
