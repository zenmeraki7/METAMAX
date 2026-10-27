# Webhooks and reconciliation

## Run and deploy

Installation automatically reserves the first catalogue import in the same
transaction as the offline session. After commit, the HTTP app immediately
dispatches the pending run to the catalogue worker without waiting for the
import. No dashboard visit or manual refresh is required. If dispatch fails,
the durable recovery scanner picks up the same run. Reauthorization does not
replace a published snapshot, restart an import, or bypass retry backoff.

Use Node 20.19+ (the Docker image uses Node 22). Install backend dependencies
with `npm --prefix web ci`, then run `npm --prefix web run db:generate`.
Run `npm run db:migrate` before starting either process. The migration runner uses
`DATABASE_URL_UNPOOLED`, or derives a direct Neon endpoint from `DATABASE_URL`.
It baselines only a recognized legacy session-only schema, and never resets data.

Run the HTTP app with the existing Shopify development command, or
`npm --prefix web run serve` in production. Run `npm run worker` as a separate,
supervised process alongside it. The backend development command starts and
restarts both the HTTP server and worker automatically. Every worker starts a recovery scan immediately
and every five seconds after the previous scan finishes by default. Redis is an accelerator;
pending work and failures remain in Neon. Multiple workers may run concurrently.
The worker exits on startup if the schema is unavailable. SIGINT/SIGTERM stop
scanning and drain active work, with a configurable six-minute shutdown deadline.

`shopify.app.toml` declares product events, app uninstall, and all three mandatory
privacy topics. `read_products`, `read_inventory`, and `read_locations` are required for the worker's
product/variant inventory fields. Deploy the app config
with the normal Shopify release process and approve the new scope on existing
installations. Local config validation does not register production subscriptions.

## Integrity and initial sync request migrations

Migrations `202610250011_integrity_and_initial_sync` and
`202610250012_inventory_repair_schedules` require successfully applied migrations
000–010 with matching history. Do not resolve or bypass an unresolved failed
migration to deploy them. A database currently at migration 007 needs 008–010
reviewed and deployed before these changes can be used there.

Migration 011 adds `InitialSyncRequest`, keyed by shop and installation generation,
and backfills only verified ACTIVE installations with a matching installation
fence and `NOT_STARTED` catalog state. It also fills null `requiredDatasets` before
setting NOT NULL. The inventory, repair, dataset, and snapshot counter checks use
`NOT VALID`: existing violations remain visible, but subsequent writes must pass.
Audit and repair existing violations before explicitly validating each constraint.

Migration 011 adds inventory repair enum values; migration 012 uses them after
the preceding migration commits. Keep that boundary even if a deployment wraps
each migration file in a transaction. Registration creates all five schedules
idempotently for future installations. The repair scheduler processes all five
kinds for verified ACTIVE installations, excluding exhausted or invalid counters.

Registration also commits one `InitialSyncRequest` per installation generation.
The recovery scanner consumes due PENDING/RUNNING requests before delivering sync
jobs. The consumer attaches to the existing initial run, or reserves one through
the same transactional starter if no run exists. It polls every five seconds
until publication, then marks the request COMPLETED. Failed/cancelled imports are
terminal requests; a published catalog is reused instead of starting another
import. Uninstall cancels unfinished requests and a reinstall creates a new key.
Consumer failures roll back reservation, persist exponential backoff capped at
five minutes, and become FAILED after eight attempts. Redis delivery remains the
existing sync scanner's responsibility, so a queue outage cannot lose a request.

INVENTORY_ITEM repair pages Shopify's updated-item connection in fixed windows
with a one-hour overlap and a five-minute settling delay. INVENTORY_LEVEL repair
pages all known items in the published snapshot without relying on parent item
timestamps. The existing inventory worker then reads complete levels, including
deletions and changed quantities. Each completed sweep schedules another pass in
15 minutes; additional pages are due after one second. Each page handles at most
100 items and a window is bounded to 10,000 pages.

Both inventory processors atomically persist ledger revisions, staging
invalidations, and cursor progress under the Shop publication barrier. They
preserve active reconciliation leases, fence snapshot/generation/repair-lease
changes, and recheck lease expiration before committing progress. They never
acknowledge inventory revisions or write mirrors directly. Failures retain the
cursor, persist bounded backoff, and stop discovery after eight consecutive
failures. Inspect `lastError`, repair the cause, and reset attempts/nextCheckAt
before retrying exhausted schedules. Existing inventory dead-letter controls
continue to manage failures in the actual inventory reconciliation worker.

Applied migration 008 is immutable. For an existing snapshot, audit its variant
projection with `node scripts/repair-variant-projection.js <shop> <snapshot-id>`.
The command defaults to audit-only and reports malformed products, invalid
variants, duplicate IDs, and conflicting existing projections. Any reported issue
requires authoritative reconciliation before continuing; `--apply` refuses all
writes when issues exist. With a clean report, rerun with `--apply` to insert
missing references idempotently under the Shop and snapshot locks. The command
does not mark ingestion complete or publish a snapshot. Existing counters and
dataset/publication checks still determine completeness.

`tests/integrity-initial-sync.test.js` verifies the applied test-branch history
and checksums, then replays the full chain in a disposable schema, one transaction
per migration. It exercises constraint rejection, backfill eligibility, enum
commit boundaries, cascade deletion, registration, and projection repair without
changing application tables or migration history.

## Products page

`/products` reads the authenticated shop's published catalog through
`GET /api/mirror/products`. Installation reserves the initial import automatically;
opening or refreshing this page does not start another import. Keep the worker
process running alongside the HTTP server to perform imports and webhook work.

The page displays queued, export, ingestion, and reconciliation states. Initial
products remain hidden until reconciliation publishes the completed snapshot.
During a subsequent import, the last published catalog remains available. Once
ready, product creation, updates, deletions, and inventory changes are reconciled
into that published catalog by the workers.

The page checks import progress every five seconds and ready catalogs every
30 seconds, using serial requests. Refresh checks immediately. Temporary network,
429, and server failures retain the last response and retry after 5, 10, 20, then
30 seconds; successful reads reset the backoff. Authentication and other client
errors require an explicit refresh. Search and status changes cancel old requests,
and a new snapshot restarts cursor pagination at the first page.

## Installation registration and repair

The installed Express package has no `afterAuth` option or token-exchange route.
Registration therefore happens at its supported SessionStorage boundary rather
than relying on the OAuth callback. Every **validated offline** session passed to
the configured storage adapter commits its session row, ACTIVE Shop, independent
installation fence, and initial `CatalogSyncState` in one Neon transaction.
The same transaction reserves a `PENDING` initial `SnapshotRun` and assigns
`Shop.activeRunId`. Product and inventory webhooks can be accepted immediately
and invalidate that staging run before the export starts. Online sessions do not
create installations. Repeated offline session saves preserve the existing run.
Any future token-exchange implementation must authenticate the exchange and save
the resulting offline session through this same adapter.

Repeated registration preserves the installation generation, original installation
date, and existing sync progress. A confirmed reinstall creates a fresh generation.
Failure of sync initialization rolls back the session and all registration writes.

Unknown-shop behavior:

| State | HTTP | Action |
| --- | --- | --- |
| Registration transaction in progress | 503 | Retry; no receipt or revision |
| Installed shop missing from Neon | 503 | Log `SHOP_REGISTRATION_MISSING`; worker repairs from the saved offline session |
| Confirmed uninstalled/redacted installation | 200 | Ignore; no receipt, revision increment, or queue job |
| Active registered shop | 200 | Commit receipt and invalidation first |
| Neon unavailable | 503 | Retry; never acknowledge a failed commit |

Each worker recovery pass repairs missing Shop/sync rows before scanning dirty
changes. Repairs reread the saved offline token under the installation lifecycle
lock, reject expired sessions, and never reactivate a terminal installation.
`npm run registrations:repair` runs the same repair explicitly. Alert on structured
`SHOP_REGISTRATION_MISSING` errors and monitor `SHOP_REGISTRATION_REPAIRED` events.
Minimal terminal installation fences expire after 90 days only after Shop removal.

## Webhook receipt contract

The raw product webhook endpoint is `/api/webhooks/catalog`. The lifecycle endpoint
is `/webhooks/lifecycle`; `/api/webhooks` remains a compatibility alias for lifecycle
deliveries. Both are mounted before JSON parsing and session authentication.

- HMAC uses original bytes, constant-time comparison, and optional
  `SHOPIFY_API_SECRET_PREVIOUS` during rotation. Keep that previous secret only
  for the rotation window.
- Product metadata requires shop domain, topic, delivery ID, event ID, and trigger
  timestamp. Missing HMAC is an authentication failure (`401`); missing metadata
  is `400`. Invalid identities/JSON are `400`, oversized bodies `413`, unsupported
  media types or compression `415`, and missing primary secret `503`.
- A receipt, revision increment, and active snapshot invalidation commit together
  before `200`. Exact redelivery produces no increment; reused IDs with different
  metadata or payload hashes produce `409` without incrementing revisions.
- Queue failure after commit does not change the `200`. A process crash before
  enqueue is recovered by the scanner. A database failure is never acknowledged.

The product receiver defaults to a 5 MB limit, configurable with
`SHOPIFY_WEBHOOK_BODY_LIMIT`. Configure an equal or tighter limit in the ingress.
The ordinary application JSON parser has a separate 1 MB limit and is registered
once, after webhook mounts. Product create/update subscriptions include only `id`
and `updated_at`; delete subscriptions include only `id`. Keep `updated_at` on
create/update to distinguish successive reduced payloads for webhook debouncing.

The recovery scanner repairs committed dirty revisions; it cannot discover a
webhook that Shopify never delivered. The repair scheduler scans updated products
and variants and requests a full catalog resync weekly.

## Automatic initial catalog import

Deploy migration `202610250010_automatic_import`, regenerate Prisma, and restart
the HTTP and worker processes. `npm run worker` now starts the catalog import
consumer as well as product/inventory reconciliation. The recovery scanner
delivers committed initial requests even if Redis was unavailable at install.
Existing offline installations still at `NOT_STARTED` are repaired into a request.

The worker advances `PENDING → STARTING → WAITING → INGESTING` for each of three
bulk exports: products with every variant, inventory items with every inventory
level and named quantity, and all locations (including inactive/legacy locations).
All queries use the installation's offline token and the shared Shopify budget.
Grouped JSONL streams retain one root at a time and await each validated database
write. Staging is fenced by installation, active run, and the database lease.

Completed Shopify `rootObjectCount`/`objectCount` manifests must agree with the
download and durable unique product, variant, inventory item, level and quantity
counts. The complete location manifest is checked when sealing inventory.
Partial/failed operations never supply a publishable baseline. Empty exports
require verified zero counts. Prices retain their original decimal strings.

After every baseline is committed, sealing moves the run to `RECONCILING`.
The existing revision-fenced workers drain both staging change ledgers and
atomically switch `activeSnapshotId` and the sync state to `READY`. Webhooks
committing during import or reconciliation remain part of that publication barrier.

Run/dataset-specific GraphQL operation names recover bulk submissions whose
responses were lost. Downloads replay from the beginning after a crash; committed
identical product envelopes are idempotent, and inventory replacements are
transactional. Only one lease can write; stale importers are rejected. Export
downloads use signed Shopify result URLs without attaching an access token.

Polling waits 15 seconds between jobs. Failures persist a sanitized error code,
attempt count and exponential retry time (5 seconds up to 5 minutes). Eight
consecutive failures mark the run and sync state `FAILED`; existing published
catalogs remain available. To abandon a failed import, use the existing
`catalog:snapshot cancel --shop <domain> --run <id>` command, then request a new
full run with `npm --prefix web run catalog:snapshot -- request --shop <domain>`.
Keep the failed snapshot for diagnosis.
The importer deliberately fails closed on cross-export count inconsistencies;
a fresh full export may be needed if the catalog changed while datasets exported.

API references: [bulk query workflow](https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/queries),
[bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/bulkOperationRunQuery),
and [bulk operation history](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/bulkOperations).

## API resource controls and recovery

Run `npm run worker:reconcile` from `web/` to start the worker, registration
repair, recovery scanner, and retention scheduler. The existing `npm run worker`
command starts the same runtime. Worker environment defaults are configured in
`web/.env` and documented in `web/.env.example`:

| Setting | Default |
| --- | ---: |
| `RECONCILE_CONCURRENCY` | 5 |
| `RECONCILE_SCAN_INTERVAL_MS` | 5000 |
| `RECONCILE_SHOPS_PER_SCAN` | 20 |
| `RECONCILE_PRODUCTS_PER_SHOP` | 5 |
| `RECONCILE_SCAN_LIMIT` | 100 |
| `RECONCILE_MAX_BACKLOG` | 2000 |
| `RECONCILE_SHUTDOWN_TIMEOUT_MS` | 360000 |

Each scanner rotates through at most 20 due shops and schedules at most five
products per shop per pass, interleaved one product per shop per round, with at
most 100 attempted additions (`RECONCILE_SCAN_LIMIT`). Deduplicated job IDs still
count toward that attempt limit. `RECONCILE_MAX_QUEUED_JOBS` remains a compatibility
alias; `RECONCILE_MAX_BACKLOG` takes precedence when both are set. It counts waiting, active, delayed, prioritized,
paused, and waiting-for-children jobs before enqueueing; the 2000-job limit is a
soft cap because independent scanners and HTTP producers can add work concurrently.
Queue failures leave Neon eligibility untouched. Shutdown stops new worker claims
and scheduled passes, drains in-flight work, then closes queue and database
connections. Configure the process manager's stop grace period above six minutes.

BullMQ owns separate producer and consumer connections. Producer options disable
offline buffering, allow one request retry, and use a 1500 ms connection timeout.
Consumer connections retain offline buffering and unlimited request retries.
Reconciliation jobs use the exported `RECONCILE_JOB`, one execution attempt, and
removal on completion or failure; Neon alone controls exponential retry timing.

The app database's read-only query plans use the existing
`(dirty, deadLetterAt, nextAttemptAt, shop, productId)` index for scanner filtering
and `(shop, productId)` primary key for product lookup, with lease eligibility
filtered afterward. No new index migration was justified by this database's
current plans. Reassess with production-scale data and measured scan latency;
these plans do not establish throughput for large catalogs.

`webhooks.service.js` owns product reconciliation; BullMQ workers delegate to it.
Neon atomically claims due dirty revisions with a unique five-minute lease token,
using the database clock. Live claims are excluded from scanner scheduling and
duplicate jobs skip without fetching Shopify. Expired claims can be reclaimed.
Completion checks the exact revision, lease token, active installation generation,
and unapplied state before replacing the JSON mirror and acknowledging in one
transaction. Lease expiry alone does not invalidate an owner whose token has not
been replaced. Shop locks precede change-row locks in claim and commit paths.

Superseded attempts release only their own lease and do not delay newer work.
Failures persist a jittered retry starting at 4–6 seconds and capped at five
minutes, with dead-letter handling after eight failed attempts. Retry-state write
failures report both errors and leave the lease to expire for scanner recovery.
Only selected database transaction conflicts receive bounded immediate retries.
Deploy migration `202610250004_reconciliation_leases` and regenerate Prisma before
starting updated workers. Stop older workers during rollout: they do not enforce
the new lease ownership check.

## Snapshot waiting and publication

A shop with no `activeSnapshotId` accepts webhooks into Neon but its worker returns
`waiting_for_snapshot` without making Shopify requests or consuming failure
attempts. The lease is released and the row is deferred for 60 seconds. The scanner
skips shops without a published snapshot. Existing JSON mirrors are not silently
promoted to full snapshots by migration: their catalog completeness is unknown.

A trusted initial-catalog importer can use `snapshots.service.js` to start a run,
stage validated complete product envelopes in batches of at most 100, seal the
run, reconcile captured changes, and publish it. Only durable unique staged rows count as imported. Missing
products, count mismatches, conflicting retries, and writes after sealing are
rejected. An exact expected product count must come from the trusted complete
catalog export; count equality alone cannot prove Shopify catalog completeness.
No automatic Shopify bulk export or catalog enumeration is implemented here.

The operator CLI provides the same lifecycle from `web/`:

```powershell
npm run catalog:snapshot -- start --shop example.myshopify.com --expected-products 42
# Save the returned id as RUN_ID. Start the run before collecting the export.
npm run catalog:snapshot -- stage --shop example.myshopify.com --run RUN_ID --file catalog.ndjson
npm run catalog:snapshot -- publish --shop example.myshopify.com --run RUN_ID
# To abandon an incomplete import:
npm run catalog:snapshot -- cancel --shop example.myshopify.com --run RUN_ID
```

`catalog.ndjson` must contain one complete `{ product, variants }` envelope per
line, using the representation returned by `fetchCurrentProduct`, including each
variant's `__parentId`. It is not raw Shopify bulk-operation JSONL. Identical staged
products can be retried without incrementing the imported count. An empty catalog
requires an explicit expected count of zero. This CLI is a trusted database
operator tool, not a merchant endpoint for uploading arbitrary product state.

Sealing validates the durable staged count against the trusted ingestion manifest
and transitions `INGESTING` to `RECONCILING`. Ingestion writes stop at that point.
The `publish` CLI invokes `reconcileAndPublishSnapshot`: it claims the run lease,
calls `applySnapshotChanges(run, token, limit)` in bounded batches (default 25,
maximum 100), and attempts publication after an empty batch. Its default 100-batch
limit makes continuous churn resumable rather than looping without a bound.

Snapshot-run ownership is distinct from each product's Neon lease. One canonical
renewal helper uses the database clock, a 120-second lease, and a 30-second fetch
heartbeat. Expiration updates use `GREATEST` and cannot shorten a longer lease.
Expired or replaced tokens cannot renew. Ownership and active installation/run
identity are checked before every Shopify read, even when the batch is empty.
Lost ownership aborts supported GraphQL requests; the overall three-minute product
read deadline remains in force. Heartbeats never overlap and are drained before
committing or propagating errors.

Each staged write locks Shop, SnapshotRun, SnapshotChange, then SnapshotProduct.
The exact fetched revision is acknowledged with the product replacement in one
ReadCommitted transaction. Newer revisions return `superseded` and stay dirty.
Selected transaction conflicts retry at most once, without refetching Shopify.
`writeProductSnapshot` writes the existing staged JSON rows rather than introducing
relational Product/Variant tables. Creates/deletes during reconciliation can change
the staged product count; ingestion counts remain a record of the sealed baseline.

Publication takes the exclusive Shop lock and validates the current run lease,
sealed ingestion, and absence of dirty/mismatched staged revisions. A webhook
arriving after an empty batch makes publication retry reconciliation. Exact CatalogChange acknowledgment, pointer activation, run completion, and lease
release commit atomically; publication does not copy product or variant rows. Work already reconciled against a previous snapshot
is refreshed in staging before publication, preventing an earlier export baseline
from hiding it. Workers fetching against a previous snapshot cannot write into its
replacement. Queue waking remains best effort and dirty Neon rows remain durable.

The public `publishRun(run, token, expectedLines)` repository function retains its
caller contract. Here `expectedLines` denotes durable complete product envelopes,
matching `expectedProducts`/`importedProducts`, not raw variant lines. Bigint inputs
are compared without conversion to Number. Shop readiness is recorded in
`CatalogSyncState.status`, and publication time in `SnapshotRun.completedAt`;
`readActiveCatalogCounts` exposes these as `syncStatus` and `lastSyncedAt`. No
nonexistent SyncRun, Product, Variant, or Shop status fields are assumed.

While a replacement snapshot is ingesting, workers continue using the previous
published catalog. Cancellation preserves that catalog. Active published snapshots
are protected from retention, and uninstall clears both snapshot pointers and
cascades staged rows. Deploy both `202610250005_snapshot_publication` and
`202610250006_snapshot_reconciliation` before starting the updated server/worker.
The app database rollout remains pending approval; these migrations are tested on
the isolated integration branch. Snapshot publication uses a bounded 30-second transaction;
measure publication time and database capacity for large catalogs before rollout.

All reconciliation GraphQL reads use atomic Redis reservations keyed by app and
shop. Each shop has at most two concurrent requests, a conservative 500-point
budget, and a maximum refill of 50 points/second. Shopify response costs refund
unused reservations and clamp the budget to reported availability. Throttling
imposes a shared cooldown. Redis failure fails closed instead of issuing an
uncontrolled API request. A request has a 15-second network deadline; concurrency
leases expire after 30 seconds, without refunding uncertain API cost.

The worker always reads the latest durable revision. It writes/deletes the mirror
and acknowledges only that exact revision in one transaction. A newer webhook,
another successful worker, or an installation generation change supersedes the
result. Failed fetches and failed mirror transactions both persist retry state.
After eight failed attempts for a revision, the row remains dirty and enters
dead letter. A newly observed revision gets its own retry budget.

### Product and variant reads

`domains/products/products.queries.js` and `products.service.js` read products in
ID-ordered pages of 100 variants, using a smaller follow-up query for subsequent
pages. They support up to 2,048 variants, require an exact variant count, reject
duplicate IDs/positions and nonadvancing cursors, and recheck product version and
count after pagination. Deletion needs two explicit, error-free null responses.
Incomplete/mutating reads throw and leave the durable revision dirty.

`integrations/shopify/graphql.js` shares request budgets and installation fencing
across all pages. Full page requests reserve 400 cost points; version checks reserve
10, with actual-cost refunds and weighted accounting for outstanding requests.
Network calls have a 15-second deadline, and the default full read has a three-minute
deadline. These guards do not make multiple Shopify reads a point-in-time snapshot.

The authoritative catalog uses JSON `SnapshotProduct` rows selected by
`Shop.activeSnapshotId`. Published reads use `readPublishedProduct` or the authenticated
mirror-status route. `ProductMirror` is a compatibility cache; direct reads from that
cache do not reflect pointer publication. `writeCurrentProduct` updates the active
snapshot and compatibility cache in the same revision transaction;
`writeProductSnapshot` updates a specific staging run.
Both use the same mapping and retain the complete variant set in one row. Their
callers own revision acknowledgment and the Shop publication barrier. Ordinary
worker writes keep a bounded ten-second transaction timeout; staged writes and
publication use ReadCommitted transactions capped at 30 seconds. Webhook receipt
transactions retain their short HTTP deadline.

`products.mapper.js` keeps monetary values as decimal strings and removes internal
parent markers. The staged importer uses this same canonical mapping. Automatic Shopify bulk-export
collection remains separate work.
Differential variant updates and the broader Matrixify-style field domains remain
separate work. `featuredImage` is still requested for compatibility; Shopify marks it
deprecated in favor of `featuredMedia`.

Run `npm --prefix web run test:products` for the mocked reader/mapping tests, or
`npm test` for the full suite with isolated Neon/Redis integration. Shopify responses
are mocked in the integration tests; generic operations are separately schema-validated.

Edit History shows the oldest 100 unresolved failures and exposes Retry and
Repair from Shopify. Both schedule an authoritative Shopify read; neither accepts
arbitrary product JSON or marks a row clean. Retry state commits before queueing,
so recovery also works during a Redis outage. Retrying requires the current
revision and is rate-controlled to one manual retry per product per minute.

Authenticated API endpoints derive the shop exclusively from the verified session:

- `GET /api/reconciliation/dead-letters`
- `POST /api/reconciliation/retry` or `/repair`, body `{ "productId": "gid://shopify/Product/123", "revision": "1" }`
- `GET /api/reconciliation/privacy-requests`

## Retention and uninstall

An hourly bounded cleanup runs in each worker process. It removes receipts older
than 30 days only after their revision was applied and no relevant recovery is
pending. It removes completed/failed/cancelled snapshots older than seven days
only when inactive and free of dirty changes; shops with pending catalog recovery
are protected. Snapshot cleanup holds the Shop publication barrier before checking
active snapshots. Terminal lifecycle receipts, containing hashes and outcomes
rather than customer payloads, expire after 90 days. Receipt deduplication is
therefore guaranteed within the retention window, not forever.

Uninstall serializes with publication and reconciliation, rotates the installation
generation, deletes the shop's sessions/catalog/receipts/snapshots, and leaves an
inactive tenant marker until shop redaction. Queued jobs become no-ops, and
in-flight results are fenced. Already-started remote reads cannot be recalled;
they cannot repopulate the deleted tenant. A newly installed generation is protected
from stale uninstall events and the previous installation's delayed redaction.
Redaction preserves an active installation only when its last verified OAuth
occurred after the start of Shopify's 48-hour uninstall/redaction window. An old
active marker does not prevent cleanup if uninstall delivery was missed.

The current app collects product fields only. Customer privacy webhooks durably
record that no customer data is stored; they do not retain incoming customer
identities or contact information. If customer records, uploads, or external exports
are introduced later, add their deletion/export handlers before collecting that data.
R2 is configured but this pipeline does not write snapshot objects to it.

## Verification

### Inventory observations and writes

`domains/inventory/inventory.service.js` provides `fetchInventoryItem(shop,
itemId, context)` and `writeInventoryItemSnapshot(tx, shop, snapshotId, itemId,
current)`. The reader follows the independent inventory-level connection,
including inactive levels, checks item metadata before returning, and confirms
deletion with a second explicit null response. Its 100-page limit and three-minute
deadline bound each observation. Every request uses the shared GraphQL budget,
installation generation, and cancellation signal. Incomplete quantity sets,
duplicate levels or locations, malformed pages, and pagination cycles fail closed.

The writer requires an existing Prisma transaction; its caller must hold the Shop
publication boundary and verify the inventory revision, lease, and generation in
that same transaction. It replaces levels and named quantities together, preserves
opaque Shopify level GIDs, and keeps fresher shared location metadata. Deleting an
item cascades its levels and quantities while retaining shared locations.
Deleting a snapshot or shop also cascades its inventory rows. Variant inventory
references are indexed per snapshot, maintained with canonical product JSON, and
do not require the inventory dataset to have loaded first.

Inventory has a separate `InventoryChange` ledger, keyed by shop and inventory
item. Raw webhooks at `/api/webhooks/inventory` deduplicate through the common
receipt table and update this ledger under the Shop SHARE barrier. They capture
changes into `SnapshotInventoryChange` while an import is active. Neither receipt
handling nor reconciliation requires a product or variant row. Level events must
contain both inventory item and location identities; item events use item identity.
Delivery receipt collisions do not consume another revision. New revisions reset
attempts and dead-letter state while preserving an existing worker lease.

The standard worker runtime starts a dedicated `inventory-reconcile` BullMQ worker
and a bounded, rotating inventory scanner. Jobs are signals only, use one BullMQ
attempt, and are removed after terminal outcomes. Each execution atomically claims
the current due Neon revision, observes the active snapshot before its fetch, and
checks the same installation, lease token, revision, and snapshot pointer before
writing and acknowledging in one transaction. Pointer changes discard the fetched
observation and leave fresh work due. Superseded failures cannot consume a newer
revision's retry budget. Eight failures enter dead letter; authenticated endpoints
`GET /api/reconciliation/inventory/dead-letters` and `POST .../retry` (or `/repair`)
use `{ "inventoryItemId": "gid://shopify/InventoryItem/123", "revision": "8" }`.
Retries are revision-checked, rate-limited, and always re-read Shopify.

Inventory subscriptions enable the full inventory dataset contract. The trusted
full-catalog importer must call `stageSnapshotInventoryItem` for the complete
baseline and `sealSnapshotInventory` with exact export-manifest counts for
`inventory_items`, `inventory_locations`, `inventory_levels`, and
`inventory_quantities`, before sealing catalog ingestion. An event stream alone
does not satisfy this contract. Staged inventory changes drain under the same
renewed snapshot lease as products. Publication takes the exclusive Shop barrier,
checks both ledgers and baseline coverage, and acknowledges both ledgers together
with the snapshot pointer switch. Missing coverage blocks publication, including
unsupported datasets, rather than replacing a complete mirror with partial data.
An import already sealed before inventory was enabled must be restarted with its
complete inventory baseline. The current product-only bulk importer must be
extended with this baseline before deploying the inventory subscriptions.

An item metadata timestamp does not fence changes to every quantity during a
paginated read. Inventory-specific revisions protect known events and stale worker
writes; periodic inventory verification remains necessary for missed or absent
webhooks. Inventory receipts and obsolete snapshots are retained while recovery
is pending. Uninstall deletes inventory snapshots and both ledgers, rotates the
installation generation, and makes queued or in-flight old work harmless.

Configure `web/.env.integration` with a disposable Neon branch's `DATABASE_URL`
and local `REDIS_URL`. It must differ from the normal app database. Migrate that
branch before running `npm test`. Tests create uniquely named shops and Redis
namespaces, then remove only their own fixtures. They cover acceptance responses,
duplicate races, rollback, stale revisions, durable scanner recovery, distributed
budgets, dead letters, retention, privacy, and uninstall/reinstall fencing.

To verify automatic copying through the actual Redis queue and BullMQ worker,
start Docker Desktop and run `docker compose up -d redis`, then:

```sh
npm --prefix web test -- tests/automatic-import.test.js tests/install-dispatch.test.js tests/installation.test.js
```

The installation queue test saves an offline session using the production dispatch
path, consumes its job with a real worker, and checks durable product, variant,
inventory, snapshot publication, and `READY` catalogue reads in the disposable
database. Shopify exports are simulated; this does not verify a live merchant's
OAuth grant or make requests to their store. Only the fixture's continuation
polling delays are advanced to keep the test fast.

Catalogue ingestion batches complete, validated product and inventory envelopes
instead of opening a transaction per root. Buffers flush at 100 roots, 500 source
records, or 2 MiB of envelope data; a larger individual envelope is written alone.
Product JSON, variant projections, and imported-product progress commit together.
Inventory items, levels, quantities, and timestamp-fenced shared locations also
commit together under the current snapshot lease. Stream interruption can retain
already validated groups, but no dataset seals until its durable counts match
the complete export manifest. Retrying the same export preserves unique counts.

`tests/batched-staging.test.js` exercises 100-root transactions, replay,
cross-product variant conflicts, malformed inventory, rollback after writes,
newer shared location metadata, and expired ingestion leases. The streaming
batch bounds and commit-before-completion contract are covered by
`tests/bulk-importer.test.js`.

Monitor scanner errors, dead-letter counts, oldest due dirty timestamps, database
latency, and lifecycle failures. Neither a successful enqueue nor a webhook `200`
means the product mirror has already been synchronized.
