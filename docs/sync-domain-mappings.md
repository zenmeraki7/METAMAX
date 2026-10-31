# Synchronization persistence mappings

The production adapter is `createCatalogSyncRunDbAdapter` in
`web/mirror/catalog-execution.server.js`. The phase runtime uses this factory
instead of assembling a generic mapping and validators at its call site.

The implementation follows these domain Prisma models:

| Model source | Model | Physical relation | Identity and authority |
| --- | --- | --- | --- |
| `tenant.prisma` | `Shop` | `mirror.shops` | Authenticated domain `id`, `installation_version`, nullable `uninstalled_at` |
| `synchronization.prisma` | `SyncRun` | `mirror.ingestion_runs` | Bigint `id`, `shop_id`, `generation_id`, `dataset`; subordinate `execution_id` / `execution_fence` |
| `synchronization.prisma` | `SyncCheckpoint` | `mirror.ingestion_chunks` | Bigint `run_id`; unique `(shop_id, run_id, ordinal)` |
| `catalog-import.prisma` | `CatalogImportExecution` | `mirror.catalog_import_executions` | Text phase-run `id`, phase, attempt, lease, fence, uncertainty and recovery counter |
| `catalog-import.prisma` | `CatalogImportJob` | `mirror.catalog_import_jobs` | Installation binding and bigint ingestion `run_id` |
| `catalog-import.prisma` | `SyncExternalOperation` | `mirror.sync_external_operations` | Text execution `run_id`, immutable input hash and exact remote identity |

`SyncRun` has ingestion status and durable counts; it has no phase or retry
counter. The existing `CatalogImportExecution` extension owns phase execution.
Its text ID must never be substituted for the bigint `SyncRun.id`. SQL joins
retain the exact job-to-ingestion association, tenant and generation; bigint
checkpoint identities and counts remain PostgreSQL bigint values.

`sync-domain-schema.server.js` holds the fixed production mapping and physical
domain contract. `verifySyncRunDbMapping` verifies and fingerprints that contract
for production mappings, and every adapter/recovery transaction revalidates it.
The checks cover consumed column types/nullability, WorkStatus labels, identity
indexes, tenant-bound foreign keys, and enabled checkpoint, completed-ingestion,
execution-propagation and external-intent guards. Relation locks preserve the
checked schema through the transaction. Generic fixture adapters remain supported.

Production run validation locks the exact job, product ingestion and generation
after locking shop/execution authority. A live ingestion must share the current
execution fence. Completed ingestion is an immutable receipt rather than a new
lease, so subsequent execution fences do not invalidate it.

`sync-checkpoints.server.js` is shared by phase-evidence validation and recovery.
It checks committed checksums, positive chunk sizes, contiguous ordinals, zero
invalid lines, and equality between checkpoint totals and durable processed
counts. Complete evidence also requires SUCCEEDED, verified EOF, finished writes
and equal expected/processed counts. Recovery after ingestion requires complete
evidence; partial ingestion may resume only from consistent durable checkpoints.
Invalid checkpoint evidence preserves uncertainty and requires review with
`RECOVERY_CHECKPOINTS_INVALID`.

The initial mapping alignment changed no models. The subsequent dispatch
repository adds a durable delivery revision and reservation models through
`20261029000200_sync_dispatch_reservations`. Migration
`20261029000300_sync_dispatch_ledger` evolves that same ledger into
`mirror.sync_dispatches`, including an explicit bigint SyncRun foreign key;
see `sync-dispatch-repository.md`.
Migration `20261029000400_sync_dispatch_lifecycle` extends that ledger's lifecycle
and reuses the fairness table as `mirror.sync_dispatch_schedule`, with automatic
shop lifecycle maintenance and tenant-bound scheduling eligibility.
Migration `20261029000500_dispatch_consumption_receipts` adds the exact consumed
execution fence/token and delivery-recovery fence. Ordinary and recovery claim
transactions now write their consumption receipt atomically; see `sync-dispatch-v3.md`.
PostgreSQL regression cases cover drift in shop
authority, ingestion and checkpoint columns; disabled checkpoint guards; gaps;
uncommitted counts; cancellation; reinstallations; fencing; and ambiguous commits.
