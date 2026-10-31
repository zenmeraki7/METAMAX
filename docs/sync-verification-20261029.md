# Bulk synchronization verification — 2026-10-29

Result: the service modules are implemented and tested, but this step is not
ready for production sign-off.

Update: the three source gaps below have subsequently been fixed. See
`catalog-import-20261029.md` for implementation, regression coverage and the
required queue migration. The remainder records the original audit findings.

| Component | Verified implementation |
| --- | --- |
| `web/mirror/bulk-sync.server.js` | Starts and binds exports to fenced runs, reads status by operation ID, polls, cancels locally before remote cancellation, and avoids adopting orphan operations. |
| `web/mirror/jsonl-ingestion.server.js` | Accepts streams and iterables, groups product/variant lines, awaits transactional batch writes, renews leases, checks EOF/counts and seals before reconciliation. |
| `web/mirror/ingestion-writer.server.js` | Validates records, checks live run ownership, writes catalog rows and checksum checkpoints in the same transaction, and rejects changed replay and duplicate products. |
| `web/mirror/catalog-writer.server.js` | Uses tenant/generation parameters, upserts complete products and variants, removes obsolete variants, and rejects reassignment of a variant to another product. |

The normal ingestion path awaits the last flush before sealing. Durable processed
counts come from committed chunk receipts, rather than merely incrementing the
parser's line counter. `completeIngestionRun` cross-checks those counts and the
contiguous ledger; the database gates RECONCILING on completed ingestion receipts.

## Gaps requiring follow-up

1. **Caller-supplied count bypass.** `getExpectedLines` returns a supplied
   `expectedLines` before checking the persisted operation's remote status and
   object count. This path can declare an empty stream complete without reading
   Shopify status at all. A service-level probe using mocked storage confirmed
   `succeeded: true`, completion and reconciliation callbacks invoked, and zero
   remote status reads despite a configured FAILED operation reader. This probe
   demonstrates the application control-flow bypass; it is not a live merchant
   import or an additional real-database exploit test. A provided count must be
   checked against the owned completed operation, or accepted only through an
   explicitly separate trusted source-receipt capability.
2. **Production orchestration is absent.** The runner is exported and exercised
   by tests, but is not instantiated by application startup, an HTTP sync route,
   or a production ingestion worker. No host flow currently starts/polls an
   export, fetches its result URL, streams that response into ingestion, then
   drives reconciliation, verification and publication. A caller still supplies
   the stream and the shop-bound Shopify client.
3. **Stream line limit is checked after buffering.** The Readable adapter uses
   `readline` and checks line bytes after a whole line has been assembled. Its
   one-megabyte limit therefore rejects oversized lines but does not bound memory
   while accumulating a single oversized or unterminated line. Enforce the limit
   during chunk decoding before treating this as a strict bounded-memory reader.

## Verification performed

- Focused bulk sync, runner, JSONL, ingestion writer, catalog writer, recovery,
  sync-run and hardening suites: **34 passed, zero failed**.
- Disposable PostgreSQL schema/integration suite: **29 passed, zero failed**.
  Existing integration cases exercise interruption, changed replay, durable count
  sealing, transaction rollback, authoritative replacement, revision races,
  cancellation, publication and retained generations.
- Shopify AI Toolkit documentation search used API version **2026-10**. A minimal
  public `bulkOperation` status query validated successfully. This was a schema
  probe, not a fresh remote validation of every private repository operation.
- No live merchant import, application database mutation or production source
  change was performed for this verification.

Evidence: `.audit/sync-verification-focused.txt`,
`.audit/sync-verification-schema.txt`, `.audit/sync-ingestion-probe.mjs`,
`.audit/sync-ingestion-probe.txt`, `.audit/sync-review-toolkit.txt`, and
`.audit/sync-review-api-validation.txt`.

Next development order: close the count override and streaming-limit gaps with
regressions, then connect a shop-authenticated import worker and prove a complete
import through publication against an isolated database before a live merchant run.
