# Introspected application database

Refreshed on 1 November 2026 with Prisma 7.10.1 from the configured
newmeta_app PostgreSQL database. This is a read-only introspection snapshot,
not the application migration source. It contains 70 application/session models
across public, mirror, export_engine and edit_history.

The canonical domain models live in ../prisma/ and migrations remain the source
of truth for checks, triggers, functions, policies and privileges Prisma cannot
fully represent. Matching Prisma models alone does not certify tenant isolation
or full schema drift.

From web/, refresh and validate using the pinned Prisma CLI:

~~~powershell
npx --package prisma@7.10.1 prisma db pull --config prisma-live.config.mjs
node scripts/normalize-live-schema.js
npx --package prisma@7.10.1 prisma validate --config prisma-live.config.mjs
~~~

The config uses the existing migration environment, prefers the explicitly
configured direct endpoint, and enforces read-only mode and bounded timeouts.
Credentials are never stored in this snapshot. The normalization script fixes
Prisma's inferred publication and history snapshot reverse-relation cardinality
without inventing unique constraints, and preserves the two separate job-item
foreign keys. It changes model metadata only.

For PostgreSQL role and rollback verification, run npm run test:roles:postgres.
For full drift verification compare a schema-only dump with a fresh migration
replay, including RLS, policies, triggers and functions, and compare privileges
separately. Public session tables belong to the official session adapter.
