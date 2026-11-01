# Catalog refresh migration deployment — 2026-10-31

Applied the explicitly requested `20261031120000_catalog_refresh_requests` migration to the configured `newmeta_app` database on Neon endpoint `ep-odd-surf-aoil4uxa` (branch `br-frosty-darkness-aod5t1wf`).

- Existing applied migration checksums matched the workspace; no unfinished migrations were present.
- The migration was rehearsed against the configured database in a transaction and rolled back successfully before deployment. Creating an additional Neon test branch was blocked by the project's branch limit; the previous disposable PostgreSQL regression suite also passed all 153 checks.
- Prisma deployed from a staging directory containing the 15 already applied migrations and only the requested new migration. The 12 other pending migrations were excluded and remain pending.
- Applied history increased from 15 to 16 migrations. The new history checksum matches the checked-in SQL.
- Verified all seven columns, the primary and foreign keys, three check constraints, and the partial due-work index.
- One installation-scoped catch-up refresh request was seeded and is pending processing by the catalog-import scheduler.

The application environment was not changed and no application process was restarted. Raw verification evidence is in `.audit/catalog-refresh-20261031/`; credentials are not included in those reports. The targeted deployment helper is `web/scripts/deploy-catalog-refresh.js`.
