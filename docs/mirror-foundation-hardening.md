# Existing mirror foundation hardening

The existing Prisma schema remains authoritative. The proposed concepts map to:

| Concept | Existing implementation |
| --- | --- |
| Installation generation | Shop.generation |
| Snapshot generation | SnapshotRun.id, owned by shop + installation generation |
| Publication pointer | Shop.activeSnapshotId |
| Product baseline | SnapshotProduct, owner derived through its SnapshotRun FK |
| Variant projection | Variant with composite shop/snapshot and product FKs |
| Dataset verification | SnapshotDataset and durable export manifests |
| Revision fences | CatalogChange, SnapshotChange, InventoryChange, SnapshotInventoryChange |
| Event receipts | WebhookEvent and lifecycle receipts |

Installation generation and snapshot ID are different identities. Product JSON
retains the existing exact decimal strings; converting it to NUMERIC(30,9) would
round existing higher-precision prices. No second mirror_* schema is introduced.

Migration 202610260001_mirror_foundation_hardening adds a composite publication FK
on shop/generation/snapshot, nonnegative durable count constraints, retention pins,
and durable bulk-query capacity claims. It is transactional and intentionally fails
if existing published pointers have incompatible ownership. Audit such rows before
an application deployment; do not guess or silently rewrite their generations.

BulkQueryClaim is one pool of five slots for each app/shop, across all consumers
and installation generations. Catalogue sync uses the shared coordinator. Future
export launchers must use createBulkQueryCoordinator with the same Shopify app ID;
exports are currently scaffolds. Local worker concurrency is not the Shopify bulk
operation limit. Any external/manual launcher bypassing this coordinator still
shares Shopify's authoritative limit; it must be brought through the coordinator.
Slots are reserved before requests and uncertain responses keep their capacity.
Exact query ownership can recover an accepted operation. Uncertain requests are
not blindly retried or freed by a lease/TTL. Only a definitive rejection or verified
terminal operation frees capacity. An unresolved operation needs outcome repair;
this intentionally favors avoiding duplicate catalogue exports over liveness.

Products and variants are ingested first, then inventory items/levels/quantities
and locations. Existing durable-count, dataset, lease, revision and reconciliation
checks still gate publication; pointer updates do not copy rows. Missing inventory
coverage cannot be declared ready. Metafield coverage producers remain unfinished.

SnapshotRetentionPin protects active SELECTION, EXPORT, EXECUTION and READ consumers
using a restricting FK. pinSnapshot is idempotent, releaseSnapshotPin releases the
exact owner, and pruneRetiredSnapshots deletes bounded completed snapshots only
when neither publication/staging pointers nor pins reference them. Future consumers
must acquire/release pins around their lifetime before automated pruning is enabled.
Uninstall cleanup fences workers and clears pins; privacy redaction clears claims.
No recurring retention deletion is enabled by this change.

Validation: run `node web/scripts/test-mirror-foundation.js` from the repo or
`npm --prefix web run test:mirror-foundation`. The runner refuses the app database,
applies migrations to the separately configured disposable integration database,
generates Prisma, then tests publication ownership, pin protection, shared capacity
and execution of parameterized SQL against actual PostgreSQL. It needs no Redis.


## Verification result

Validated on disposable branch `metamax-mirror-foundation-20261026`
(`br-long-pine-ao1mhv3z`, parent: the existing integration branch). It expires
2026-10-27 at 21:14:10 Asia/Calcutta. No application DATABASE_URL was changed and
the application database migration was not applied.

110 local tests pass. Six PostgreSQL integration checks pass, including migration
application, database publication/pin constraints, actual concurrent shared-slot
claims, execution of parameterized queries, the real empty-catalogue importer
through dataset verification/publication, and lost-response recovery. Shopify
responses in these importer tests are fixtures; this did not launch live merchant
exports. Bulk GraphQL operations passed Shopify 2026-10 schema validation.
Redis is unavailable locally, so Redis worker transport is not reverified here.

Until the disposable branch expires, repeat its checks with:
`node web/scripts/test-mirror-foundation.js --host ep-sweet-cake-aoitgixb.c-2.ap-southeast-1.aws.neon.tech`.
Default execution still uses .env.integration. The runner verifies the destination
is distinct from the application endpoint before applying anything.

A production deployment must apply the reviewed Prisma migration before starting
code that uses the new claims and retention tables. The shared export consumer,
metafield ingestion/coverage, general outbox delivery, detailed checkpointing and
automatic retention scheduling remain future integrations. The foundation does
not declare those datasets/features ready.
