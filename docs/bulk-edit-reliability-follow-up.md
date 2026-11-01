# Bulk-edit reliability and verification — 2026-11-01

## Partial completion across persistence and presentation

Terminal mixed outcomes now persist `mirror.job_commands.status = PARTIAL`. Full success remains SUCCEEDED; a fully failed operation remains FAILED. Unfinished batches return `IN_PROGRESS` with `terminal:false`, rather than using the terminal-looking PARTIAL tag. Counts preserve succeeded, failed, pending, uncertain, cancelled and total resources across all claims.

Command finalization discovery, History/Undo terminal handling and schedule outcome polling recognize PARTIAL. Dispatch receipts return the persisted status and result; the shared history presentation maps PARTIAL to Partial, separately from Failed. Embedded history badges, filters, statistics and CSV preserve the distinction. Command result counts now declare `countUnit: resources`; history metadata declares `countUnit: fields`, and the UI labels field counts explicitly. These counts describe different units and are not interchangeable.

Two migrations are prepared, **not applied**:

1. `20261101000600_command_partial_status` adds PARTIAL to the shared PostgreSQL WorkStatus enum. Catalog/ingestion state machines retain their own explicit status subsets.
2. `20261101000700_backfill_partial_commands` reclassifies legacy FAILED bulk/edit/import/Undo commands only when their v1 terminal result already proves a mixed outcome with no pending/uncertain resources. It preserves counts, timestamps, fences and evidence. A check constraint rejects PARTIAL without the required terminal mixed-result shape.

The enum addition commits separately before the second migration uses the value. Coordinate migration and code rollout while workers are paused; current physical-schema verification expects the expanded enum. This work did not alter a live database. Added disposable PostgreSQL coverage verifies enum persistence, idempotent backfill and rejection of uncertain terminal partial results, but it could not execute here.

## Outbox admission and duplicate delivery

Both due-event selection and retry-exhaustion discovery now join the exact shop/command and active installation, require PENDING or RETRY, and reject `cancel_requested_at`. Delivery rechecks current eligibility immediately before queue admission. If cancellation or terminal completion occurred after the event claim, the dispatcher releases its fenced lease and returns SKIPPED without a queue call. Claim/exhaustion updates match both shop and event ID. The supplied schema already declares a globally unique outbox event primary key; tenant crossover from merely shop-scoped event IDs was not established for this schema.

Queue identity remains a deterministic hash of shop plus command. New fault tests deliberately accept **two** scheduling tokens with the same identity, without relying on queue deduplication: the first queue response or database acknowledgment is lost, delivery retries, then both copies are processed. The production worker executes one effective mutation and returns EMPTY for the completed duplicate. Database command ownership and single-use journal handoffs are the execution authority; BullMQ job retention is not the idempotency guarantee.

There is no distributed database/Redis transaction. Cancellation can race after the final eligibility read, so a redundant scheduling token can still exist; the worker independently fences cancellation, installation, command ownership and dispatch. A scheduling acknowledgment never proves a Shopify mutation completed.

## App resource serialization and Undo limits

`security/resource-family-admission.server.js` already serializes admission by shop and canonical parent Product GID inside the history repository's SERIALIZABLE transaction. Product and variant operations in the same family coordinate conservatively. Sorted, transaction-scoped advisory admission locks prevent simultaneous admission; durable DISPATCHING, ACKNOWLEDGED and OUTCOME_UNKNOWN records prevent another command from proceeding after the short lock releases or a worker crashes. The existing real-PostgreSQL suite includes competing commands and release-after-no-write cases.

This covers app-originated bulk edits, approved row imports and scheduled edits that use the installed journal path. A future enabled Undo writer must use that same path. Shopify Admin and other apps do not participate in these locks, so their edits can occur between the final read and mutation. A fresh read, updated timestamp, application lock or successful AFTER observation does not turn an unconditional mutation into compare-and-set.

The current ProductUpdateInput and ProductVariantsBulkInput used by the installed writers expose no expected-value/version predicate for the supported ordinary fields. This is an inference from the documented input contracts: [ProductUpdateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductUpdateInput), [ProductVariantsBulkInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput). No unsupported GraphQL precondition or lock was fabricated.

**Undo remains blocked for new writes** until an installed conditional mutation adapter exists. Current approval, dispatcher and executor checks return `UNDO_ATOMICITY_UNAVAILABLE`. The executor can persist verified no-write evidence without consuming a dispatch or contacting Shopify. Already verified Undo work can finish locally; historical observations, inverse planning and independent evidence reconciliation remain available. A future conditional adapter must declare an actual conditional write method and accept the expected values at mutation time. Merely setting a capability flag is insufficient.

Changing the installed capability metadata changes its bound fingerprint. Existing approvals may require revalidation/reapproval before new execution; do not weaken fingerprint checks to keep stale contracts running. The isolated pasted verified-writer factory was not exposed to routes or substituted for History Execution.

## Accepted writes with uncertain outcomes

New unit cases simulate Shopify accepting the mutation and then losing:

- the response;
- acknowledgment evidence persistence;
- outcome persistence;
- both outcome and recovery-scheduling persistence.

The send count remains one. Reentering the executor with a consumed, unresolved handoff does not grant another send. A read-only recovery path observes the simulated remote resource, verifies every intended field, persists observation evidence and allows local completion. If an external edit changed the observed value, recovery keeps the outcome unresolved and does not replace it with another write. A matching observation verifies the target state; it is not a proof that no other actor ever wrote the same value.

The disposable PostgreSQL worker tests now use explicit simulated remote state rather than making reads change solely based on read count. They read that state and create authenticated observation evidence through the existing recovery repository, covering response loss, evidence loss and a lost acknowledgment COMMIT. Those database tests are **prepared but unexecuted**. These tests do not provision a production recovery consumer: deployment must supply the trusted recovery authentication, remote observer/evidence providers and task consumer. The independent durable scanner schedules interrupted journal work without relying on the original worker's recovery write.

## Lease expiration during execution

A new worker test accepts a request, expires ownership while its response is pending, and then lets the response return. The old worker returns STALE_CLAIM, performs no second send, leaves items unconfirmed and creates no terminal finalization task. Existing tests also cover renewal refusal, failure, timeout, abort propagation, stale recovery probes and lost completion acknowledgments.

An additional PostgreSQL case expires the real command lease after simulated remote acceptance and checks that the old worker cannot confirm snapshots/finalize, and that the replacement worker does not replay an unresolved handoff. It remains pending database execution. Fencing prevents further work after ownership loss is detected; it cannot retract a request already accepted by Shopify. Abort requests are not evidence of remote rollback.

## Checks run

| Check | Result |
| --- | --- |
| Full backend suite | **1,317 passed**, no failures/skips |
| Frontend UI / product suites | **35 / 48 passed** |
| Frontend production build | Passed using a placeholder public API key |
| Prisma schema validation | Passed |
| Combined import/dependency audit | **490 files, 1,381 relative references, 161 package references**, no failures |
| Disposable operation/PostgreSQL suite | Blocked: Docker's `dockerDesktopLinuxEngine` pipe is unavailable |

No production migrations, credentials, scheduler or Shopify mutations were applied. Real PostgreSQL migration execution, role permissions and concurrent crash/restart behavior remain release checks; local mocks and Prisma validation do not certify them.
