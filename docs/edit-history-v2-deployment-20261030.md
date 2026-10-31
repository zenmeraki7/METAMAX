# Edit History V2 deployment — 30 October 2026

Applied the history migrations requested by the user to the application's
configured Neon database. The installed schema supports History Contract V3.

| Target | Value |
| --- | --- |
| Project | `bitter-dream-29677040` |
| Application branch | `express-backend-20261027` / `br-frosty-darkness-aod5t1wf` |
| Database | `newmeta_app` |
| Direct endpoint | `ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech` |
| Migration ledger | `mirror._prisma_migrations` |

## Applied migrations

1. `20261030110000_edit_history_v1` — the original file, unchanged and actually
   executed, not marked applied without execution.
2. `20261030120000_edit_history_v2_upgrade` — transactionally upgrades empty V1
   to the reviewed V2 constraints, indexes, functions and triggers.

V2's fresh reference file is not stacked on top of V1. The upgrade uses ALTER
TABLE to add the six required snapshot/handoff columns and replace the guards;
it drops no history tables and invents no legacy provenance. It locks all five
history tables and rejects any populated V1 table before changing the schema.
Populated legacy databases require a separate authenticated data migration.

Deployment used an isolated Prisma migration directory containing the 13
already-applied migrations and only these two new migrations. Their installed
checksums match their source files. Eight unrelated pending operation/export
migrations were not applied; this report does not claim the whole root migration
directory is up to date. No application credentials or worker configuration changed.

## Recovery and staging

Neon's branch quota prevented a new recovery branch. The snapshot API also
rejected a snapshot of this non-root branch. A custom-format PostgreSQL recovery
dump was therefore saved before any live DDL, then restored and verified in a
new isolated database on the existing migration-test branch:

- Branch: `live-migration-test-20261029` / `br-delicate-feather-aoqpi9w4`.
- Validation database: `history_v2_validation_20261030`.
- Validation endpoint: `ep-wild-scene-aoryowq0`; suspended after verification.
- Recovery archive: `.audit/history-deploy-20261030/before-history-v2.dump`.
- Archive size and SHA256: `.audit/history-deploy-20261030/recovery.json`.

The audit directory is explicitly ignored by Git because the recovery archive
contains database data. Credentials are not stored in the migration config,
command lines or reports. Retain the archive securely. To recover, restore it to
a new isolated database, verify its hashes and explicitly select the recovered
connection; do not overwrite the live database as an automatic rollback.

Both staging and live deployment preserved row counts and content fingerprints
for all 46 existing public/Mirror tables. The internal migration ledger was
excluded from content preservation checks because the two new entries are
expected. Existing backup/test databases and recovery branches were retained.

## Verification

- Full active migration schema suite: **144 checks passed**.
- Empty-V1 upgrade plus repository suite: **27 checks passed**.
- Upgraded schema matches fresh V2 catalog definitions, including columns,
  constraints, indexes, triggers and function bodies (ignoring comments/spacing
  and physical column order).
- Populated V1 is rejected with legacy rows and schema preserved.
- Prisma completed both migrations in staging and live: **15 applied migrations**.
- Five history tables and their V2 integrity constraints verified on live.
- Deferred BEFORE-snapshot barrier is installed and initially deferred.
- All five mutation evidence comparisons use IS DISTINCT FROM.
- Existing table content fingerprints match before/after; environment file hash
  is unchanged.

Detailed evidence is in the ignored directory:
`stage-deploy.log`, `stage-verification.json`, `live-deploy.log`,
`live-verification.json` and `recovery.json`.

The deployed schema does not activate history routes or external mutations.
Worker integration still requires the trusted execution-plan, live engine
authorization and authenticated receipt adapters described in
[the journal repository contract](edit-history-journal-repository.md).
