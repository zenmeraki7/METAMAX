# METAMAX storage contract

Current schema reconciliation: 1 November 2026. Canonical models preserve the
existing domain files and physical table mappings, including the full migrated
Edit History contract and database coordination columns. The ordered SQL
migrations remain authoritative for custom checks, functions, triggers, RLS
policies and privileges. Prisma validation is not a role/concurrency certificate.
Run npm run test:roles:postgres and the database integration suites below.

`schema.prisma` contains the generator and datasource. The adjacent domain files
define the shared PostgreSQL catalog and execution state using Prisma ORM 7.10.1.
`prisma.config.mjs` loads the entire `prisma/` directory, so commands must use the
config default or `--schema prisma`, rather than loading `schema.prisma` alone.
The initial migration includes the generated tables, foreign
keys and indexes plus the mandatory checks, partial indexes and triggers from
`constraints.sql`. That file is the reviewed source of the custom initial DDL;
do not apply it again after deploying the initial migration.

The four existing migrations were verified and applied only to the isolated
`database-baseline-20261028` Neon branch on 28 October 2026; see
`../../docs/database-baseline-20261028.md` for identities, recovery and results.
The configured source branch, main and application sessions were not changed.
`web/db/postgres.js` remains the runtime connection layer;
this change does not install or initialize Prisma Client or replace Shopify's
session adapter.

## Domain files

| Domain | File | Models and responsibility |
| --- | --- | --- |
| Tenant | `tenant.prisma` | `Shop`, `Subscription`: installation identity and verified billing observations |
| Catalog | `catalog.prisma` | `SnapshotProduct`, `SnapshotVariant`, product options and categories: shared generation-scoped product queries |
| Inventory | `inventory.prisma` | `InventoryItem`, `InventoryLevel`, `Location`: quantities per inventory item and location |
| Collections | `collections.prisma` | `SnapshotCollection`, `CollectionMembership`: generation-scoped collection membership for filtering |
| Publication | `publication.prisma` | `MirrorGeneration`, `MirrorCoverage`, `MirrorPublication`, `GenerationReadLease`: snapshot consistency and durable generation leases |
| Synchronization | `synchronization.prisma` | `SyncRun`, `SyncCheckpoint`, `CatalogChange`, `MutationJournal`, `GenerationProductRevision`, and webhook receipts |
| Dynamic fields | `fields.prisma` | `MetafieldDefinition`, `MetafieldValue` and trusted mapping metadata: typed values with verified owner/type/token checks |
| Filter system | `filters.prisma` | `SavedFilter`: reusable normalized ASTs, freshly validated and authorized on every use |
| Selection | `execution.prisma` | Frozen selections and materialized membership |
| Bulk editing | `bulk-editing.prisma` | `PreviewContract`, `EditOperation`, `EditItem`: approval and execution bindings |
| Undo | `undo.prisma` | `ProductSnapshot`, `UndoOperation`: compact before-values and separately approved restoration |
| Reliability | `reliability.prisma` | `OutboxEvent`, `IdempotencyRecord`: dispatch, deduplication and recovery |
| Operations | `operations.prisma` | Generic durable commands, schedules, artifacts and audit |

These are source-code domains in one database schema, with cross-file relations.
They do not introduce duplicate catalog tables. `SnapshotProduct` still maps to
`mirror.products`, and `SnapshotVariant` still maps to `mirror.variants`; existing
parameterized SQL and catalog verification use the same physical columns/indexes.
`SnapshotCollection` and `CollectionMembership` likewise retain the physical
`collections` and `product_collections` names. Inventory levels retain their
tenant/generation/item/location unique identity and foreign keys.

The renamed Prisma models retain their existing tables: `MirrorCoverage` maps
to `coverage`, `SyncRun` to `ingestion_runs`, `SyncCheckpoint` to
`ingestion_chunks`, `PreviewContract` to `execution_contracts`, and `EditItem`
to `job_items`. This keeps the existing SQL publication and approval guards.
`SyncRun` represents one dataset ingestion/reconciliation unit; a generation
groups the dataset runs. `SyncCheckpoint` records committed chunks/checksums,
not merely a last-read JSONL offset.

`Subscription` is a current-observation cache for Shopify App Pricing, which is
configured through Shopify's supported pricing flow. It does not create charges.
See [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing).
Only server-verified observations should populate it. Request authorization must
check the authenticated shop, matching installation version, fresh verification
expiry and verified plan entitlement; a cached status alone is insufficient.
The composite installation foreign key prevents reusing an old installation's
subscription after reinstall: remove its cache row before rotating the shop's
installation version. Refreshers must claim a monotonic verification revision
before fetching state, then use compare-and-swap on the previous revision so
late responses cannot overwrite newer observations. The trigger is a backstop,
not an implementation of that synchronization protocol.

## Storage and identity

- A shop's key is its authenticated `myshopify.com` domain, matching `resolveShop`.
  No table reference alone proves request authorization.
- High-volume catalog, membership, job, receipt and audit rows use internal
  `BigInt` keys. Shopify identifiers remain separate `shopify_id` text columns.
  Serialize internal IDs as strings; JavaScript numbers cannot safely hold them.
- Catalog relationships include shop and generation in their foreign keys.
  Every application lookup still needs an authenticated shop predicate, including
  lookups by a globally unique internal ID. Composite keys do not supply RLS.
- Products, variants, inventory, collections, options and categories share the
  same generation. No feature-specific duplicate product mirror is introduced.
- Frequently filtered canonical scalar values are typed columns. JSONB is used
  for structured attributes, saved ASTs, definition policies and execution
  payloads; none of those documents is executable SQL or an authorization grant.
- `@db.Decimal` without arguments produces unconstrained PostgreSQL NUMERIC.
  This preserves exact values and satisfies the current physical verifier's
  no-typmod contract. Normalize precision/scale in the Field Engine.
- Only known access paths are indexed: tenant/generation identities and keysets,
  parent variants, status and SKU, memberships, due work and audit history.
  Add more indexes using measured query plans rather than every field.

The compiler's physical product ID is the internal bigint `products.id`, and
its correlated variant key is bigint `variants.product_id`. Canonical Shopify
IDs must resolve to their separate Shopify identity columns or reviewed join
adapters. Do not interpret an internal bigint as a Shopify GID. Names such as
`SnapshotVariant.productId` in this Prisma contract refer to internal relations.

## Publication and ingestion

Generation states follow `INGESTING → RECONCILING → VERIFIED → PUBLISHED → RETIRED`.
Ingestion and reconciliation can also fail. Counts represent validated durable
writes, not JSONL reads. Stream JSONL into bounded COPY batches in unpublished
generation rows; commit rows, the chunk checksum/checkpoint and durable counts
in the same transaction. The importer must independently verify EOF and expected
counts before marking its run successful. An equality check alone cannot verify
an export's completeness. Retries use the unique run/chunk identity.

The database rejects successful runs without durable-completion metadata and
rejects reconciliation before every required dataset's run succeeds. Verification
requires complete coverage rows with verification metadata. The backend must
also perform count/hash validation and drain the required reconciliation cutoff;
a stored hash or status does not establish that validation happened.

All catalog and coverage mutations are allowed only while staging. Publication
freezes those rows and their source/mapping versions. A successful incremental
change therefore builds a successor generation; never mutate published rows in
place. `CatalogChange` tracks the latest shop/product revision and retry state.
`MutationJournal` adds durable immutable event intent, deduplicated by shop/source
key and shop/product/revision. Record it with the revision increment and outbox
work in the same transaction. Its applied timestamp may be recorded only after
the durable applied revision covers that event. A journal row can be retained
after queue removal; it is not a second product payload or a readiness grant.
Applied records may be purged after their explicit retention deadline.
Workers must conditionally acknowledge the observed revision and apply staging
mirror writes in one transaction, with the CAS and P2002/P2034 retry handling
required by AGENTS.md. The schema cannot replace that worker transaction.

`mirror.publications` stores one current pointer per shop and is the relation
passed to `createMirrorPublicationService` as its shared barrier. Publishers,
coverage writers, mirror writers and cleanup workers must take `lockForWrite`
before their first protected read, using the same transaction client throughout.
Readers retain ACCESS SHARE through eligibility checks and execution. Database
triggers enforce state and immutability, but do not make an uncoordinated external
writer participate in this lock protocol.

Publish atomically: under the barrier, set the verified generation to PUBLISHED
with its publication timestamp, then replace the shop pointer with matching
generation/coverage/mapping revisions. Move/remove the pointer before retirement.
The pointer identifies the latest generation; a pinned older generation can
remain PUBLISHED for ongoing pages and jobs. A coverage repository must read the
exact pinned generation and its coverage, not silently switch to the pointer.
Retire and reclaim only after retention and selection/contract pins permit it.
Product/variant tombstones are recorded during staging and freeze at publication.

## Fields, selection and execution

Metafield definitions enforce the four required shop-scoped unique keys.
`MetafieldValue` uses exactly one of two tenant/generation-scoped owner foreign
keys: product or variant. A discriminator selects one typed representation:
text, boolean, bigint, unconstrained numeric, date, timestamp, text array or JSONB.
An absent field has no row; `isNull` records an explicit null. An empty text list
and JSON literal null remain values, distinct from an explicit null or missing
row. Microseconds are preserved for dynamic timestamps. Initial partial indexes
support text equality and decimal ranges without indexing every value type.

The database rejects mixed representations, mismatched owner/definition/type,
stale tokens, expired definitions and nulls for nonnullable definitions. The
trusted resolver must still verify the live definition token, normalization
policy, authorization and exact published coverage immediately before filtering.
Definition checks alone do not grant access.

The third migration copies the two legacy JSONB value tables into typed storage
before dropping them, inside one publication-protected transaction. Invalid or
stale legacy values abort the migration; reconcile them before retrying. Current
definitions must agree with the pinned legacy tokens. No data is silently
discarded. The original migration and `constraints.sql` describe the old tables
at the initial version; the third migration replaces those tables and installs
the equivalent generation guards on `metafield_values`.

This change defines storage for typed dynamic filtering. The production compiler
still needs trusted dynamic-metafield and collection query adapters; these model
changes do not enable unsupported filters or authorize generic SQL/JSON paths.
Validate saved filters through `createFilterService` or `createFilterCompiler`
before saving, and repeat fresh semantic validation on every use. A saved
fingerprint or previous successful validation is never a permission grant.

`FieldMapping` stores reviewed metadata tied to a generation's mapping version.
It is not an authority to accept arbitrary columns from browser requests.
`FIELD_SOURCES`, `FILTER_BINDING_DEFINITIONS`, and `FILTER_SQL_SCHEMA` are now
installed for 27 reviewed product/variant scalar fields. The corresponding
tables are absent on the live branch, so catalog verification currently fails.
See `../../docs/source-registry.md` and run `npm run db:verify:filters` after
deployment; source installation alone never enables queries.

Resolve all-matching selections and exclusions server-side, materialize the final
members in `SelectionItem`, verify count/hash, then approve/freeze the snapshot.
The snapshot pins shop, operation, generation, coverage, mappings, registry and
definition revisions. Its generation foreign key prevents premature reclamation.
Approved snapshots, members and execution payloads cannot be edited. Revocation
and expiry change eligibility; expired/revoked records can be cleaned up after
dependent commands and retention pins have been removed.

`PreviewContract` holds the normalized write allowlist and operation payload.
Workers reauthorize current access, field definitions and exact targeting at
execution. Neither a compiled query's WeakMap membership nor a stored APPROVED
status supplies a live permission grant. Saved filters and schedules always
start fresh validation; scheduled runs create new selections/contracts.

`EditOperation` binds one durable command to its exact approved preview. The
command owns status, leases, retries and cancellation, so those fields are not
duplicated on the edit aggregate. `EditItem` stores immutable target identity and
intended values; successful items cannot be reopened as pending work.

`ProductSnapshot` stores the touched before-values once, linked to an edit item,
including variant resources when applicable. It is distinct from the shared
`SnapshotProduct` catalog row. Capture it with a normalized field hash before
sending mutations. Record the verified after-hash/revision and confirmation in
the same transaction as the successful item acknowledgement. Captured values
and confirmed receipts are immutable. The fourth migration moves legacy
`job_items.before_values` into this table before removing that column; those
legacy snapshots remain unconfirmed and do not imply safe undo eligibility.

`UndoOperation` binds an original edit to a newly approved restoration edit.
Restoration items reference confirmed snapshots of the same original resource.
Before restoring, the worker must freshly authorize access and definitions,
verify the new approval, and compare current touched values with the recorded
after-hash. Any mismatch is a conflict, not permission to overwrite intervening
merchant edits. Snapshot hashes do not implement atomic compare-and-swap in
Shopify; external mutation/concurrency control and post-write verification remain
the restoration worker's responsibilities. No undo worker is implemented here.
Snapshots remain retained until command completion, approval expiry and all
restoration references permit cleanup.

`JobCommand` and its `OutboxEvent` are committed together. Dispatchers enqueue a
command identity into BullMQ after commit, with durable retries and a dispatch
lease. Database idempotency survives queue-job removal. Workers use fencing/CAS
on claims, check cancellation, bound retries, preserve checkpoints and recover
expired leases. `IdempotencyRecord` scopes a request hash/key to authenticated
shop and operation, optionally binding it to a durable command. Reject key reuse
with a different hash; never treat a cached response as an authorization grant.
Reserve/claim with compare-and-swap on the fence, then commit the record,
command/outbox and acknowledgement together. Prefix command idempotency keys
with their operation as well. Completed results are immutable until their
retention expires; abandoned requests must be recovered before cleanup.
After an uncertain external mutation result, reconcile the remote state before
resending. Database deduplication alone does not guarantee exactly-once effects
on an external service.
Large import/export files live in object storage; `JobArtifact` stores their
integrity and retention metadata. Job and outbox dispatchers are not implemented
by this schema.

## Verification and deployment

Run from `web/`:

```powershell
npm exec --yes --package=prisma@7.10.1 -- prisma validate
npm run test:schema
```

The schema test creates a disposable local PostgreSQL database, applies all
migrations in order, checks isolation/state/approval/idempotency and subscription
installation/verification, migration backfill, undo and journal/idempotency
constraints, and
runs the real physical verifier and bigint cursor-index check. It never reads
the application's DATABASE_URL. Docker must be available.

`prisma.config.mjs` reads only an explicitly supplied `DIRECT_DATABASE_URL`.
Its fallback URL points to an unused localhost port, so schema-only commands work
without credentials and migration commands cannot fall back to the app database.
For deployment, install a pinned Prisma CLI in the deployment environment, supply
the intended branch's direct URL and use `prisma migrate deploy`. Verify on an
isolated Neon branch before deploying. Never use `db push` as a substitute for
the custom migration; Prisma's model cannot express all these checks/triggers.
Later migrations must preserve them and review any generated drops or changes.

Schema validation and DDL tests do not activate `/api/filters/search`. Production
repositories, authentication/authorization, mapping installation and writer
coordination remain required.
