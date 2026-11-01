# Shopify Node.js / Express foundation

The backend uses Shopify's official Node/Express app template, cloned from
`https://github.com/Shopify/shopify-app-template-node` at commit
`4e73e21a8dd424f1784d916e532103683291cde9`. Only backend files were selected;
the template's frontend submodule was never initialized. The existing
React/Polaris frontend in `web/frontend` is preserved.

## Run

Use Node.js 22 or 24. Install the three package boundaries:

```powershell
npm ci
npm --prefix web ci
npm --prefix web/frontend ci
npm run redis:up
npm run dev
```

Shopify CLI supplies authentication configuration during development. For
standalone hosting, configure `web/.env` using `web/.env.example`, build the
frontend with `SHOPIFY_API_KEY` set, and run `npm --prefix web run serve`.

For interface development without Redis, set `$env:REDIS_ENABLED = "false"`
before `npm run dev`. Remove that override when Redis is available again.

## Backend

- `web/index.js`: starts Express and handles shutdown.
- `web/app.js`: OAuth routes, signed webhooks, authenticated APIs, CSP and SPA serving.
- `web/shopify.js`: official Shopify Express integration and Admin API version.
- `web/privacy.js`: privacy hooks and uninstall/session cleanup.
- `web/product-creator.js`: the template's five-product sample, updated for API 2026-10.
- `web/template-tests`: HTTP and session regression tests.

The app uses the official PostgreSQL session adapter in web/shopify.js. Configure
SHOPIFY_SESSION_DATABASE_URL with its dedicated session-storage login; runtime
merchant and worker logins must not own application tables or access migration
credentials. Sessions persist across restarts. The database roles and transaction
scopes are verified independently from Shopify session authentication.

GET /health reports process health. Authenticated catalog/count/filter APIs query
the verified, published mirror. POST /api/products retains the template sample
creator, requires current product-write permission, and runs under the catalog
edit barrier. Unsupported API paths return JSON 404 responses.

The source includes the Field/Filter Engines, durable catalog imports,
reconciliation, frozen selections, approvals, workers, exports and edit history.
A missing dependency or unverified schema fails closed; feature configuration
and role-specific database credentials are required before enabling workers.

Existing databases and their data were not deleted. Private `.env` files
are ignored. The prior
custom backend source is recoverable from the ignored local archive
`.shopify/legacy-backend-before-template.zip`.

The backend immediately before this import is also saved locally at
`.shopify/backend-before-upstream-20261027.zip`. The upstream checkout is in
`.shopify/upstream-node-template`. Both are ignored by Git.

Local adaptations retain the testable Express app factory, shutdown handling,
health check, JSON API errors and uninstall cleanup. The obsolete REST resource
import and unused example billing configuration are omitted. The upstream MIT
license is retained in `web/TEMPLATE-LICENSE.md`.

## Checks

The backend is a separate npm package in `web/`. Installing only the root
package does not install `pg`, `express`, or the backend test dependencies.
From the repository root, bootstrap and run the filter checks with:

```powershell
npm run setup:tests
npm run test:filters
npm run test:phase1:postgres
```

`setup:tests` uses the backend lockfile and includes development dependencies.
The PostgreSQL command requires a running Docker engine (or the existing
`FILTER_POSTGRES_BIN` configuration) and creates a disposable local database.
Independent Node test files that import backend dependencies should live under
`web/` so Node resolves that package's dependencies. For a script outside that
directory, use `createRequire` anchored to `web/package.json` instead of assuming
root-level dependency resolution. CI already runs `npm ci` inside `web/`.

```powershell
npm test
npm --prefix web/frontend run test:ui
npm --prefix web/frontend run test:products
```

CI installs with lockfiles and tests Node.js 22/24. No Prisma generation, database
migration, background worker or storage bucket is required for the template tests.

## Local Redis

On this Windows development machine, the native Memurai Developer service
`MemuraiMetamax` provides Redis at `127.0.0.1:6380` and starts automatically.
It binds only to localhost, persists data with AOF, and uses `noeviction`.
Its configuration is `C:\ProgramData\Memurai\Metamax\memurai.conf`.
When using this service, skip `redis:up` and `redis:stop`; check it with
`Get-Service MemuraiMetamax` and `npm run redis:check`. Memurai Developer is
for development/testing and requires restarting after ten days of uptime.

Run `npm run redis:up` to start the Redis service in `compose.yaml` and
`npm run redis:check` to verify PING and a temporary SET/GET. Run
`npm run redis:stop` to stop the service while retaining its data.

The backend connects through `web/db/redis.js` on development startup using
`REDIS_URL=redis://127.0.0.1:6380`. This host port avoids the existing service on
6379 and is bound to localhost only. Redis data persists in the Compose named
volume with append-only persistence enabled. A backend inside the same Compose
network should instead use `redis://redis:6379`. Production startup connects
when REDIS_URL is explicitly configured. Shopify sessions use PostgreSQL. Redis supplies configured queue transports;
durable database claims and fences remain authoritative across queue removal.

Official foundation: https://github.com/Shopify/shopify-app-template-node

## Neon Postgres

The backend is connected to database `newmeta_app` in Neon project `newmeta`
(`bitter-dream-29677040`), on development branch `express-backend-20261027`
(`br-frosty-darkness-aod5t1wf`) in Singapore (`aws-ap-southeast-1`).

`web/db/postgres.js` exports the shared `database` pool. The backend verifies the
connection on startup when `DATABASE_URL` is set and closes it on shutdown.
The pooled URL is stored only in ignored `web/.env`, with TLS certificate
verification enabled. Run `npm run db:check` to verify a live read-only query.

The application schema and ordered migrations live in web/prisma/. The backend
uses pg pools at runtime; Prisma supplies schema tooling and migrations, rather
than a generated runtime client. The prisma-live directory is a separate
introspection snapshot. Apply forward migrations with the pinned Prisma CLI and
a direct migration-owner connection; never use db push to replace custom SQL.

## Durable catalog imports

The current source includes the mirror schema and Prisma migration history;
the earlier template-only database state has been replaced. Apply migrations
through `web/prisma.config.mjs` before starting the backend. In particular,
`20261029000000_catalog_import_jobs` installs the durable import queue.

Authenticated merchants can queue an import with `POST /api/mirror/sync`, inspect
`GET /api/mirror/sync/:id`, and cancel with `POST /api/mirror/sync/:id/cancel`.
Installation now automatically queues the initial mirror import after verified
OAuth, before redirecting into the app. Repeated callbacks reuse the installation's
durable request. A startup scanner resumes pending installation scheduling, and
the authenticated mirror-status request repairs an interrupted first enqueue.
Uninstall fences old work; reinstall starts a fresh request after its cleanup.
See [automatic installation syncing](docs/install-mirror-sync-20261029.md).
The startup worker streams the Shopify export, resumes durable checkpoints,
reconciles current products and publishes verified coverage. It requires an
offline session with product-read access. See
[the catalog import contract](docs/catalog-import-20261029.md) for deployment,
retry, cancellation and verification details.


## Restricted database verification

Run npm --prefix web run test:roles:postgres to test real merchant, catalog-worker,
operation-worker and history logins, tenant-scope initialization, denied writes,
rollback and connection reuse. Tests use disposable localhost PostgreSQL only.
The other database suites are test:schema, test:operations, test:exports,
test:history:postgres and test:history:upgrade in web/package.json. Set
FILTER_POSTGRES_BIN to an installed PostgreSQL binary directory to use a native
temporary cluster; otherwise the runner uses Docker.

DATABASE_URL is the restricted merchant login. CATALOG_WORKER_DATABASE_URL and
OPERATION_WORKER_DATABASE_URL belong to their separate worker profiles.
TENANT_DATABASE_URL supplies restricted source reads; history runtime, privacy
and maintenance each have separate credentials. DIRECT_DATABASE_URL belongs only
to migration tooling. See web/.env.example and docs/backend-interface-contracts.md.
