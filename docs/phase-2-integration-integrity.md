# Phase 2 integration integrity — 2026-11-01

Source audit and local regression checks completed. Production readiness is **not certified**: actual PostgreSQL integration checks and live Shopify configuration checks remain outstanding, and the export runtime has a database-role integration gap described below. No migration, credential, subscription, or live-store change was made.

## Results

| Area | Evidence and result |
| --- | --- |
| Relative imports and dependencies | `npm --prefix web run verify:integration-imports` parses 479 JavaScript/JSX files, checks 1,354 relative references and 159 package references, including exact filename case for Linux deployment. No missing imports or undeclared production packages. All five nonliteral dynamic imports are in tests. A fresh-process import smoke test also covers the app, filter stack, merchant/worker gateways and history executor without module mocks. |
| Route registration and authentication | Public health/OAuth routes precede protected APIs. Exact webhook POST uses official raw-body verification before JSON parsing. Unknown webhook paths now terminate with 404. Every remaining `/api` route goes through official session authentication and current installation validation before its router; API fallback precedes static/SPA fallback. Tests cover revoked installations across product, filter, catalog, import, export, history and source routes. |
| Scopes and sessions | Shared session policy rejects absent credentials, invalid shops, malformed/expired expiries and online sessions without expiry. Current product permission intersects app scopes with online staff scopes. Offline sessions may be nonexpiring; an offline expiry, when present, is enforced. Background catalog transport rejects online-only credentials and stale installations. Sample product creation now reloads storage and checks current `write_products`, including online staff permission. |
| Webhook authenticity and duplicates | Official SDK tests accept a valid raw-body HMAC and reject invalid, absent and body-tampered signatures. Durable receipts are tenant/event scoped and now compare both topic and payload hash. Transactional fan-out tests cover duplicate delivery and rollback on product/refresh persistence failure. Catalog deliveries without durable storage now fail instead of being acknowledged. Bulk completion records a durable hint; the phase poller remains responsible for exact remote identity/status verification. |
| Transactions and publication fencing | Source and unit tests verify transaction-scoped shared/exclusive advisory barriers keyed by shop. `ACCESS SHARE` is only the DDL fence. READ COMMITTED readers take protected data snapshots after acquiring the barrier; history's SERIALIZABLE path also locks and compares the publication row. Mirror transactions bound lock/statement waits, roll back failures, release/discard connections and retry declared database conflicts. Real PostgreSQL contention, RLS and migration behavior remain unverified in this environment. |

## Fixes made during this audit

- Declared the previously transitive `esbuild` test dependency and the audit tool's `@babel/parser` dependency directly, with matching existing lockfile versions.
- Replaced the production `serve` dependency on development-only `cross-env` with a native Node startup wrapper. Production startup sets `NODE_ENV` before importing the app.
- Added the reusable AST-based import/dependency audit and expanded fresh-process production import coverage.
- Required current product-write permission at sample-product creation and prevented unknown webhook URLs from reaching merchant authentication.
- Bound duplicate webhook receipts to topic as well as payload. Removed direct external-operation terminal-status updates from the completion webhook; signed events do not establish a verified remote terminal outcome.
- Moved catalog-maintenance storage verification before the HTTP listener opens.

## Open release findings

1. **High: enabled exports are not integrated with the restricted runtime role.** `web/index.js` passes the merchant `database` facade to `createExportRuntime()`. That runtime immediately queries `export_engine.jobs` and related tables. The schema is created by `20261030000000_export_lifecycle_recovery`, but the migration chain contains no `export_engine` grants for `metamax_engine_runtime`; the split-role profile only supplies the declared Mirror privileges. Fresh deployment with the documented restricted login therefore cannot enable exports. Export integration tests use their isolated migration-owner pool and do not establish runtime-role compatibility. Resolve this with a reviewed export database gateway/role and matching tenant/worker authority tests; do not give the HTTP login owner privileges. Enabled startup already fails closed; disabled exports return authenticated 503.
2. **PostgreSQL verification blocked.** `npm --prefix web run test:schema` could not connect to Docker's `dockerDesktopLinuxEngine` pipe. No local PostgreSQL binaries were found on PATH or under the standard installation directory. Prisma validation does not substitute for migrations, foreign keys, RLS or contention testing. Run `test:schema`, `test:postgres`, `test:operations`, `test:exports`, `test:history:postgres` and `test:history:upgrade` against the harness's disposable PostgreSQL after making Docker or `FILTER_POSTGRES_BIN` available. Runtime-role export tests must be added as part of finding 1.
3. **Live Shopify configuration unverified.** The checked-in app configuration still has default `shopify.dev` home/callback URLs. Declared scopes are `read_products,write_products,read_inventory,write_inventory`; configured scopes do not prove the installed token or staff member has them. The installed writer does not expose inventory mutation capability, so review whether `write_inventory` should be requested at all. Verify real app URLs, installed scopes, online/offline sessions and registered webhook delivery with the intended deployment. No OAuth flow or live webhook registration was performed.
4. **Deployment composition remains explicit.** Supply separately provisioned merchant, catalog-worker, tenant-read and session-storage credentials. Session storage currently permits `SHOPIFY_SESSION_DATABASE_URL || DATABASE_URL`; the restricted merchant role is not a session-table owner, so production must provide the dedicated session connection. The default operation supervisor has no worker provider and performs no command execution; local executor tests do not prove a production bulk-worker composition exists. Retain the isolated pasted writer without route exposure or executor replacement.

## Checks run

| Check | Result |
| --- | --- |
| Full backend suite, bounded test concurrency | 1,279 passed; zero failures/skips |
| Frontend UI suite | 33 passed |
| Frontend product suite | 48 passed |
| Frontend production build | Passed using a placeholder public API key; no live authentication |
| Import/dependency audit | Passed |
| Backend production dependency tree | `npm ls --omit=dev --depth=0` passed |
| Root Shopify CLI dependency tree | Passed |
| Backend/frontend manifest-lock dependency metadata | Matched; newly declared versions already present in lockfile |
| Prisma validation | Passed using cached Prisma CLI and `prisma.config.mjs` |
| Disposable PostgreSQL schema harness | Blocked by unavailable Docker engine; not passed |

Shopify policy references: [online and offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens) and [raw-body HMAC verification and duplicate delivery](https://shopify.dev/docs/apps/build/events/verify-deliveries). The Shopify toolkit search was attempted but its fetch failed; official documentation was consulted through the web fallback.
