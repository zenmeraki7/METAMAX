# Initial-sync stall: recovery and ingestion changes

The first merchant sync stalled in STARTING while the Products page reported a
generic loading failure. Database inspection found repeated publication-barrier
lock timeouts and an uncertain execution, initially without any external intent.
The existing recovery flow subsequently confirmed the saved Shopify operation;
no manual phase advancement, uncertainty clearing, checkpoint deletion or second
export request was used to repair this run.

## Changes

- Physical domain verification reads columns, constraints and indexes for all
  locked relations in three catalog queries, instead of three queries per table.
  Every claim still revalidates physical mappings within its protected transaction.
  Schema fingerprints, indexes, tenant relations and trigger checks remain enforced.
- Idle dispatcher and maintenance timers use advisory discovery before taking
  the global write barrier. Positive discoveries still pass the original
  transactional predicates. A negative hint delays work until the next scan;
  it grants no execution or recovery authority.
- When both queue consumers are configured, the direct database polling fallback
  no longer competes for the same phase/recovery claims. Cancellation and expiry
  maintenance remain scheduled, with fresh claims routed through the dispatcher.
  Database polling remains available when queue consumers are absent.
- Multi-product catalog batches use fixed parameterized SQL bindings to upsert
  products and bounded variant batches, reject cross-product variant ownership
  changes, and delete removed variants. The checkpoint and mirror writes still
  commit together. Single-product reconciliation retains its existing path.
- Ingestion reads immutable checkpoint metadata in pages of at most 1,000 rows.
  Previously committed chunks are validated by checksum and exact line count
  without repeating all database writes and lease renewals. New writes and EOF
  still require fresh run/execution authority.
- Phase ingestion uses at most 100 products per new chunk and five new chunks
  per step. Replay preserves the exact old checkpoint boundaries even when the
  earlier worker used smaller chunks. Memory and JSONL byte limits remain bounded.
- Nested services share only a transaction-scoped proof that the publication
  lock is already held. A fresh facade per transaction prevents proof reuse after
  commit or pool release; queries through a completed facade are rejected.
- Production phase persistence waits up to five seconds for a lock, with a
  twenty-second transaction deadline, below its execution lease. The worker's
  heartbeat is every forty-five seconds within a 120-second lease. Fresh fenced
  predicates remain mandatory after lock acquisition.
- An unpublished catalog now shows an initial-sync notice and retries reads every
  five seconds. It does not fabricate products, counts, coverage or a publication.

## Verification

- Backend: 846 passed, one preexisting TODO.
- PostgreSQL schema/integration: 129 passed.
- Products frontend: 38 passed.
- UI: 17 passed; frontend build passed.
- Database regressions cover the three-query schema check, drift rejection,
  concurrent claims, lease expiry, commit uncertainty, batch/single-row parity,
  stale variant removal, cross-product reassignment rollback, interrupted ingestion,
  durable chunk budgets and recovery after constructing another runtime.

Evidence: `.audit/sync-stall-*-tests.txt` and `.audit/sync-stall-build.txt`.
Live read-only monitoring writes `.audit/sync-live-latest.json`; successful
publication will additionally be recorded in `.audit/sync-live-completion.json`.
The final catalog controller check is `.audit/verify-published-catalog.mjs` and
must pass before claiming end-to-end completion. These checks do not constitute
general production-scale fairness or failover approval.

## Live completion verified

On 29 October 2026 at 19:27 IST, the existing development-store run
`2f90d041-03c7-449a-808f-b7cec6bf2ebe` completed and published generation
`76a20aa0-55d6-4578-a746-bf016fbff7a1`. All 30,021 expected export records
matched committed ingestion counts across 168 immutable checkpoints. EOF was
verified, writes were finished, the job was SUCCEEDED and the current generation
was PUBLISHED. No final uncertainty, review flag or saved error remained.

The final server catalog-controller check reloaded the actual persisted offline
Shopify session and returned READY, 25 real products on the first page, 14,987
total products, 10,169 active products and 15,034 variants. The sync-progress
service returned 100% with `estimated:false`. The verifier used its own ephemeral
cursor key; it did not change the app's key or produce reusable browser credentials.

Evidence: `.audit/sync-live-completion.json` and
`.audit/sync-live-catalog-verification.json`. The source operation identity stayed
the same throughout recovery. Transient database/transport failures occurred
during the run and were recovered from durable checkpoints; this verifies this
development-store catalog sync, not a blanket approval of production failover,
large-scale scheduling, or datasets outside the product/variant source contract.
