# Live migration deployment — 29 October 2026

Applied the seven existing repository migrations to the database configured by
the application. The deployment was explicitly requested by the user.

## Target and recovery

| Item | Value |
| --- | --- |
| Neon project | `bitter-dream-29677040` |
| Database | `newmeta_app` |
| Application branch | `express-backend-20261027` / `br-frosty-darkness-aod5t1wf` |
| Live direct endpoint | `ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech` |
| Pre-deployment recovery branch | `live-migration-recovery-20261029` / `br-bitter-king-ao3atpjv` |
| Recovery parent LSN | `0/AF64A18` |
| Migration test branch | `live-migration-test-20261029` / `br-delicate-feather-aoqpi9w4` |

The recovery branch has no compute. The test branch was copied from that recovery
point; all migrations, migration checksums, physical mappings and zero-drift
comparison passed there before live deployment. Its temporary test compute
`ep-wild-scene-aoryowq0` was suspended after verification. Both branches are
retained. The project's default `main` branch was not a deployment target.

To recover, create a fresh branch from the preserved recovery point, verify its
endpoint and explicitly select its connection. Do not reset or delete the live
branch or replace the existing application URL as an automatic rollback.

## Applied history

1. `20261028000000_metamax_foundation`
2. `20261028000100_subscription_cache`
3. `20261028000200_typed_metafield_values`
4. `20261028000300_execution_reliability`
5. `20261028000400_sync_hardening`
6. `20261028000500_generation_contract_models`
7. `20261029000000_catalog_import_jobs`

Prisma's migration ledger is `mirror._prisma_migrations`. Each recorded checksum
matches its local migration file. The application namespace was initially empty;
the historic data conversions operated on the mirror tables created by the same
deployment. No migration targeted either existing Shopify session table.

## Local configuration and schema

The existing pooled `DATABASE_URL` is preserved. `web/.env` now also contains the
matching direct `DIRECT_DATABASE_URL`, including `schema=mirror`, so migration
history stays in the application namespace. `web/prisma.config.mjs` loads that
ignored environment file while honoring explicit process environment overrides.
No credentials are stored in the Prisma schema or this report.

The canonical models remain in `web/prisma/`. The generated live snapshot at
`web/prisma-live/schema.prisma` now includes `public` and `mirror`: 41 models,
with Prisma's internal ledger excluded. The read-only introspection configuration
remains separate from the migration configuration.

Prisma 7.10.1 inferred an invalid one-to-one reverse relation for the composite
publication foreign key. The local normalization script uses the canonical
model's reverse collection instead of inventing a database unique constraint.
Validation and a read-only database-to-snapshot diff both pass after this fix.

## Verification

- All seven migrations are applied; Prisma reports the database up to date.
- Canonical schema versus live database: no difference.
- Introspected snapshot versus both live schemas: no difference.
- Live snapshot validates with Prisma 7.10.1.
- 42 PostgreSQL tables, including the internal migration ledger.
- All 28 installed physical filter field bindings verify.
- 29 custom mirror triggers remain installed.
- Shopify session tables preserve their exact pre-deployment fingerprints:
  zero session rows and two session-adapter migration rows.
- Backend suite: 706 passing, zero failing, one existing TODO.

The existing `ACCESS EXCLUSIVE` publication barrier and the ingestion-run lease
fields were preserved. This deployment creates no speculative `mirror.sync_runs`
table and does not activate the separate phase-worker contract. No merchant
catalog import was run; publishing an initial generation remains necessary to
serve catalog filters.

Evidence: `.audit/live-migration-recovery.json`,
`.audit/live-migration-{test,live}-{deploy,diff}.txt`,
`.audit/live-migration-live-verification.json`, `.audit/live-prisma-diff.txt`,
`.audit/live-prisma-validate.txt` and `.audit/live-migration-backend.txt`.
