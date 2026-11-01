# Tenant security rollout — 31 October 2026

This supersedes the earlier unverified rollout status in tenant-database-gateway.md. It does not claim that every repository was rewritten into a named-statement API.

## Applied database changes

Application target: `newmeta_app`, Neon application branch `br-frosty-darkness-aod5t1wf` (not the default main branch).

Only these requested/new security migrations were deployed, each through a staged Prisma lineage excluding unrelated pending migrations:

- `20261031130000_reopen_verified_staging`
- `20261031140000_source_read_rls`
- `20261031150000_runtime_tenant_rls`

Live migration history now contains 19 completed migrations. Existing checksums were preserved. Final verification confirmed the exact staging guard body, its enabled trigger, and RLS on all 50 currently installed tenant tables.

An obsolete disposable migration-test branch was removed following the user's approval; the application/default/recovery branches were preserved. Fresh rehearsal branch `br-fancy-block-aoigs917` was created from the application branch. Role/RLS changes and the official session adapter were rehearsed there before live deployment. Test logins on that branch were disabled after rehearsal.

## Runtime credentials and boundaries

| Connection | Login | Boundary |
|---|---|---|
| Application engine | metamax_app_runtime | Non-owner, NOBYPASSRLS, no elevated reachable role, no schema creation, TRUNCATE/TRIGGER, migration-ledger access or mapping-registry writes |
| Source HTTP reads | metamax_http_reader | Separate read profile for shops/publications/generations/coverage/import-job metadata; named gateway statements and live session authorization |
| Official Shopify session storage | metamax_shopify_sessions | Separate non-owner, NOBYPASSRLS login; DML on existing public.shopify_sessions and SELECT on its migration ledger |
| Migration CLI | Existing owner | Loaded only by CLI infrastructure from ignored web/.env.migrations; removed from the runtime .env |

The installed Shopify SDK issues CREATE TABLE IF NOT EXISTS even when its tables are already installed. Its separate infrastructure login therefore needs CREATE on public. This login has no mirror/history privileges and is never handed to tenant repositories. It is not accepted by the application's runtime verifier.

Underlying application pools are private. Legacy services receive an audited facade, not the pg pool, connection configuration or owner credentials. Connections expose only query/release, are rejected after release, and revalidate effective roles/ownership/RLS policies on each acquisition. Checks are batched in one SQL statement and no permission grant is cached. The source endpoint was migrated to an operation-bound named-statement repository with no owner fallback. Other existing repositories remain explicit trusted infrastructure adapters with tenant/installation predicates, field/compiler validation and durable worker fences; they were not all converted to named statements.

## RLS policy exceptions

Catalog payload and ordinary history rows use tenant-scoped policies. The application control plane has explicit broader policies for job admission, queue scanning, generation lifecycle metadata, cancellation and recovery. Coverage/change metadata has a read exception; control-plane audit insertion has an insert exception. These exceptions are enumerated in the migration and runtime verifier. They do not grant unscoped access to products, variants, snapshots or other catalog payloads.

Existing history SECURITY DEFINER maintenance/privacy APIs retain their separate NOLOGIN owner and maintenance profiles, with explicit policies matching their independently constrained privileges. The application engine is not a member of those roles. RLS is not protection against a fully compromised application process or arbitrary SQL with access to tenant GUCs; parameterized server-owned SQL, compiler provenance, authorization and fenced transitions remain required.

## Additional corrections

- Removed the webhook module's unused global database import.
- Removed the profiler's SQL-execution interface; it now inspects supplied plans as data.
- Set transaction-local tenant context before publication barriers and worker-owned child queries.
- Preserved exact worker identity/version/fence/token/lease checks; external Shopify dispatch and uncertain-outcome recovery were not replaced with transactions.
- Catalog/filter preparation is classified WRITE because it extends generation retention. Source-only reads use READ under sync_sources.read.
- Online catalog access now requires effective staff product scope as well as app scope, including before retention metadata is changed.
- Replaced the stale HTTP-field TODO with a rejection/positive-control test using actual AST parsing and canonical normalization.

## Verification and limits

- Backend: 1,068 passed, zero failures and zero TODOs in the final run.
- Disposable PostgreSQL schema/catalog/worker suite: 161 passed, including actual restricted engine credentials, role/policy drift, cross-shop denial, cancellation/recovery, session storage and source gateway tests.
- Disposable PostgreSQL history suite: 93 passed.
- Fresh Neon branch: 50 tenant tables audited; no owner/BYPASSRLS, unscoped catalog denial, released-handle rejection and official session adapter verified.
- Configured live application login passed the startup database audit and connected to newmeta_app.
- Live staging guard and runtime-RLS migrations verified again after credential separation.

No secret values were printed or committed. Application source/environment changes require restart/redeployment of any already-running application process to take effect; a database credential file change does not modify credentials held by an existing process. No live Shopify mutation was issued as part of this rollout. Unrelated pending schema migrations and unconfigured export/history service credentials were not silently deployed or provisioned.

Evidence: `.audit/runtime-production-credentials.json`, `.audit/tenant-reader-production.json`, `.audit/runtime-branch-rehearsal.json`, `.audit/{reopen-staging,source-rls,runtime-rls}-20261031/`, `.audit/tenant-runtime-{backend,schema,history}.log`.
