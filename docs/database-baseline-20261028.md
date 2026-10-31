# Database baseline — 28 October 2026

## Result

The four existing migrations deploy successfully to an isolated Neon branch.
Prisma reports the database up to date and no model/schema difference. No Prisma
model or existing migration was changed. Production/main and the configured
source branch were not modified.

## Branch and recovery identities

- Project: `newmeta` / `bitter-dream-29677040` (PostgreSQL 18).
- Intended baseline: the branch matched to the app's existing endpoint,
  `express-backend-20261027` / `br-frosty-darkness-aod5t1wf`.
- Development branch: `database-baseline-20261028` /
  `br-gentle-feather-ao3qwrpo`, created from that baseline at LSN `0/AEADAA0`.
- Development database: `newmeta_app`.
- Recovery branch: `database-baseline-recovery-20261028` /
  `br-dry-flower-aobo87gs`, no compute, pinned before migrations at LSN
  `0/AEAE250`, parent timestamp `2026-10-28T13:34:08Z` (19:04:08 IST).
- Neon rejected snapshots of this non-root branch. The retained recovery branch
  is the recovery point instead; it does not follow subsequent parent writes.
- Neither branch has automatic expiry configured. Retain the recovery branch
  until migration verification and subsequent development recovery needs end.
- An empty `metamax_filter_test` database was also created on the development
  branch. Existing tests were ultimately run on disposable localhost clusters;
  their remote-database isolation guards were not weakened.

Before migration, `newmeta_app` had no user tables or migration ledger. A final
read-only check confirmed the source branch still has zero user tables and no
`mirror` schema. The project's `main` branch was not targeted by any SQL.

## Versions and connection configuration

- Node.js: `v24.16.0`; npm: `11.11.1`.
- Prisma CLI: `7.10.1`, run from the existing npm cache; Prisma Client is not
  installed, consistent with the application's existing `pg` runtime.
- Disposable test server: PostgreSQL `18.6`; Neon server: PostgreSQL `18.6`.
- `DATABASE_URL`: pooled application connection consumed by `web/db/postgres.js`.
- `DIRECT_DATABASE_URL`: direct CLI/admin connection consumed by
  `web/prisma.config.mjs` under `datasource.url`.
- `web/prisma/schema.prisma` defines provider/schema metadata, not connection URLs.
- `web/.env.baseline.local` is Git-ignored and contains both URLs for the new
  development branch. The existing `web/.env` was not overwritten.
- Load that private file explicitly with Node's `--env-file=.env.baseline.local`
  for baseline CLI commands; the Prisma config does not automatically load it.
- Use a pinned Prisma CLI (`7.10.1`), not an unversioned download of latest Prisma.

## Migration ledger

The ledger is `public._prisma_migrations`; application objects are in `mirror`.
All four entries finished successfully with one applied step and no rollback.
Their recorded checksums match the local SQL files:

| Migration | SHA-256 |
| --- | --- |
| `20261028000000_metamax_foundation` | `aa00cefb0182abb4a1c1f7b1d0e39b56cf610e31b0b825bbc8fedc2edbe916b7` |
| `20261028000100_subscription_cache` | `d10d6efe53a42500ee32e512d7153421975526006e008ca1a117e42166448080` |
| `20261028000200_typed_metafield_values` | `493b50881c41575c09fa61e6d20713394aef025f1a73b2320f4d8009a54b62fc` |
| `20261028000300_execution_reliability` | `6a7bd2e3b2848a9b5b87afd45b5048436a507219a131bdbb7b2bf7091611fe24` |

Deployment finished at `2026-10-28T13:41:08.700Z` (19:11:08 IST).

## Executed checks

| Check | Result |
| --- | --- |
| Prisma version and `validate` | 7.10.1; valid multi-file schema |
| Migration status before deployment | Four pending migrations; expected for empty baseline |
| `npm test` | 509 pass, zero fail, one existing TODO |
| `npm run test:postgres` | 20 pass, zero fail/skip |
| `npm run test:schema` | 8 pass, zero fail/skip; all migrations and legacy backfills exercised |
| `prisma migrate deploy` on development branch only | All four applied |
| `prisma migrate status` afterwards | Up to date |
| `prisma migrate diff --from-config-datasource --to-schema prisma --exit-code` | Exit 0; no difference |
| Physical catalog verification on Neon | 27 installed field mappings verified |

Physical schema fingerprint:
`c24639eea19290db022fd14885f70edbe96c7ee3d4a0e83b17d9c0b861249653`.

Prisma's model diff does not represent every custom trigger/check/partial index.
The real schema suite separately executes their regression assertions. Passing
this baseline does not establish a production ingestion/worker implementation.

Logs are in `.audit/database-baseline-{backend,postgres,schema,deploy,status,drift,physical-schema}.txt`.

## Reproduce the local real-database tests

From `D:\newmeta\web`, set `FILTER_POSTGRES_BIN` to a complete PostgreSQL binary
directory, then run `npm run test:postgres` and `npm run test:schema`. This session
used the existing portable 18.6 runtime in the user's temporary directory after
restoring its missing share files from its existing archive. These tests never
read the application's DATABASE_URL.

The runner now canonicalizes the temporary root before creating/validating
cleanup paths, avoiding Windows short-path alias mismatches. Windows pg_ctl
uses ignored stdio because server descendants retaining pipe handles caused
spawnSync timeouts; server diagnostics still go to postgres.log. Both suites
passed after these repairs and their disposable clusters were stopped/removed.

## Recovery

Do not edit historical migrations or use `db push` to repair drift. Before a new
schema change, preserve a new branch/recovery point. To recover the pre-migration
baseline, create a new writable branch from `br-dry-flower-aobo87gs`; verify its
endpoint, then explicitly choose its credentials. Do not reset or delete main,
the source branch, or the retained recovery branch as part of normal testing.

## References

- https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7
- https://neon.com/docs/connect/connection-pooling
