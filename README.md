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

The official in-memory session adapter stores Shopify sessions independently of
the application database. Sessions are lost on restart and are not shared across
server instances. Select a persistent official Shopify session adapter before
production hosting. SQLite's native package could not install on Windows ARM64,
so the replacement does not depend on it.

`GET /health` reports process health. `GET /api/products/count` reads the Shopify
product count using the authenticated session. `POST /api/products` creates five
sample products, as in the official template, and reports Shopify validation
errors as failures. These endpoints require `read_products,write_products`;
existing installations must approve the added write scope when running through
Shopify CLI. Other `/api` endpoints return JSON 404 responses.
Existing mirror, filters, ingestion, mutation gateway, queues,
workers, Prisma schema and migrations have been removed. Frontend screens that
used those APIs need new API wiring; their source and tests were retained.

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
when REDIS_URL is explicitly configured. Shopify sessions still use the existing
memory adapter; the Redis client is available for future backend features.

Official foundation: https://github.com/Shopify/shopify-app-template-node

## Neon Postgres

The backend is connected to database `newmeta_app` in Neon project `newmeta`
(`bitter-dream-29677040`), on development branch `express-backend-20261027`
(`br-frosty-darkness-aod5t1wf`) in Singapore (`aws-ap-southeast-1`).

`web/db/postgres.js` exports the shared `database` pool. The backend verifies the
connection on startup when `DATABASE_URL` is set and closes it on shutdown.
The pooled URL is stored only in ignored `web/.env`, with TLS certificate
verification enabled. Run `npm run db:check` to verify a live read-only query.

The new database has no application tables yet. The empty Prisma placeholders
remain available for later schema work; no ORM or migrations are configured.

## Durable catalog imports

The current source includes the mirror schema and Prisma migration history;
the earlier empty-database description above is historical. Apply migrations
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

