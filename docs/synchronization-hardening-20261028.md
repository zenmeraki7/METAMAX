# Synchronization hardening — 2026-10-28

## Guarantees implemented

- Each ingestion chunk commits catalog rows, a deterministic checksum checkpoint,
  and its durable processed-line count in the same transaction. Exact replay is a
  no-op; changed replay, skipped ordinals, malformed rows and duplicate products
  fail. Completion requires explicit EOF, a completed owned Shopify operation,
  its exact object count, and a contiguous checkpoint ledger. Reading a line alone
  never advances the durable count.
- Ingestion leases carry fencing tokens. Resume retains the original bulk operation
  and replays its stream from the beginning; the checkpoint ledger skips committed
  chunks. Cancellation invalidates outstanding tokens. Only one active staging
  generation is admitted per shop.
- Workers claim the latest database revision, skip clean rows before remote calls,
  and conditionally acknowledge the observed revision, owner and live fence.
  Acknowledgment, authoritative catalog replacement and journal application share
  one transaction. A failed write rolls back all three. Duplicate webhook source
  keys do not advance revisions; mismatched reuse is rejected.
- Reconciliation replaces the complete variant set and clears obsolete option,
  collection and typed custom-value projections. Those additional datasets are not
  certified by this importer. Product deletion removes searchable product and
  variant rows while retaining the durable deletion intent and mutation journal.
- Starting a replacement generation requeues all known change rows, including
  previously clean acknowledgments. A failed generation therefore cannot consume
  reconciliation work needed by its successor. This deliberately favors correctness
  over the cost of replaying all known changes.
- Verification counts stored nondeleted products and variants and rejects dirty
  change rows. Publication checks the expected current pointer, generation order,
  versions and dirty rows again. Database triggers backstop retention, immutable
  ingestion receipts and checkpoints, and transitions to VERIFIED/PUBLISHED.
- Published generations remain immutable and retained for at least 25 hours.
  Opening a read context extends that window. Signed cursors route subsequent
  pages to their original retained generation and still undergo normal filter and
  authorization validation. Server callers can extend retention up to seven days
  per request. Selection snapshots and their job/contract references prevent
  reclamation through the existing foreign-key chain.
- Reconciliation failures persist attempts, bounded exponential backoff and a
  dead-letter state (default eight attempts, configurable maximum twenty).
  Ingestion resume is bounded to twenty claims. Transactions retry bounded database
  conflicts. Abort signals stop ingestion durably; explicit cancellation persists
  locally before requesting cancellation of the owned Shopify operation.

## Service contracts and operational limits

The supported publication contract is exactly `products` and `variants`.
The variants receipt certifies the same complete source stream as products;
its line count is a source-object count, not a variant-table row count.
Coverage counts are independently computed from stored rows. Other mirror
datasets must not be advertised as complete until their own ingestion exists.

`startIngestionRun` requires an explicit worker identity. All chunk and completion
writes require the current run fence. `publishGeneration` requires
`expectedGenerationId`, including explicit null for the first publication.
`reconcileLatestProduct` requires a trusted reader returning
`{ complete: true, product }`, where `product: null` is authoritative deletion.
That adapter must finish every variant page and reject partial responses.

Publication, ingestion and revision writes use a short database publication-lock
barrier acquired before state reads. Network requests happen outside it. The
barrier currently serializes these transactions across shops; this is conservative
and may limit throughput. Lock and statement timeouts and bounded retries prevent
unbounded waits.

These are service-layer guarantees. This change does not activate a production
webhook subscription, queue scanner, HTTP synchronization route or Shopify reader
adapter. A host must supply authenticated shop identities, persist/schedule dirty
work and use these service entry points. A bare queue message is never authority
to acknowledge a revision. Long-running jobs must retain their selection snapshot
or explicitly extend generation retention before it expires. Readiness alone
does not authorize a bulk-edit operation.

## Database and recovery

Applied only to isolated Neon branch `database-baseline-20261028`
(`br-gentle-feather-ao3qwrpo`), database `newmeta_app`.
Production and the source branch were not modified.

Pre-change recovery branch: `sync-hardening-recovery-20261028`
(`br-solitary-dew-aoitvkx6`), parent LSN `0/B69D858`, created
`2026-10-28T14:22:26Z`. Recover by creating a fresh writable branch from this
point, checking its endpoint and explicitly choosing its credentials; do not
reset production or rewrite historical migrations.

Migration `20261028000400_sync_hardening` adds database guards without removing
tables or indexes. Two existing Prisma declarations, `GenerationReadLease` and
`GenerationProductRevision`, had no matching physical tables. Additive migration
`20261028000500_generation_contract_models` preserves those declarations and aligns
the physical schema. The services currently use the existing generation retention,
selection references and revision replay mechanism; they do not rely on these two
additional tables being populated.

## Verification

- Backend unit suite: 551 passing, zero failing, one existing TODO.
- Filter PostgreSQL suite: 20 passing.
- Schema/migration PostgreSQL suite: 21 passing, including thirteen synchronization
  cases covering interrupted imports, checksum replay, concurrent webhook writes,
  competing workers, transaction rollback, deletion, retry limits, failed staging,
  publication races, retained cursors and cancellation.
- Shopify bulk query, status, start and cancellation operations validated against
  the configured Admin GraphQL API version 2026-10 using the Shopify AI Toolkit.
- Prisma validation and isolated-branch migration status/drift are checked after
  applying the additive migrations. Logs remain under `.audit/`.

No live merchant import was executed. PostgreSQL tests use disposable local
clusters and never read the application DATABASE_URL.
