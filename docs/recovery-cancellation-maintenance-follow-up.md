# Recovery, cancellation and maintenance follow-up — 2026-11-01

## Recovery evidence lifetime and process boundaries

Removed the shared recovery-proof Map, including its all-entry clear at 32 tickets. Each `recoverRun()` invocation now owns one private, expiring proof through AsyncLocalStorage. Concurrent invocations cannot evict each other's proof. Evidence remains bound to the exact run, shop, generation, phase, recovery fence, durable intent and bound remote operation. It expires after 45 seconds and is discarded on return/error; late verification cannot issue evidence after its invocation closes. Repository initialization and mapping verification remain shared rather than being deferred or repeated for each recovery.

The same-process requirement is enforced by the interface shape: `createCatalogSyncRecovery()` exposes only `recoverRun()`. That call claims durable work, invokes its private read-only verifier, and submits the result to its private repository in one asynchronous call chain. No ticket-issuer or ticket-consumer API is exported, and tickets are not queue payloads. A different process claims/re-verifies durable recovery work through its own invocation; it does not consume another process's ticket. Restart discards transient evidence while durable lease/fence/intent records govern later recovery. A future split of verification and consumption across services would require a durable or otherwise authenticated evidence protocol; this implementation does not support that handoff.

The orchestrator supplies an AbortSignal, but the internal verifier now also tolerates an omitted signal and forwards a supplied signal to the remote read. Tests cover 64 concurrent recoveries, exact-scope rejection, proof disposal, expiry, fresh verification in another instance and omitted signal.

## Accepted cancellation versus terminal cleanup

The legacy bulk adapter now returns separate states:

| Adapter state | Meaning |
| --- | --- |
| `CANCELLATION_REQUESTED` | Local generation is fenced; exact terminal remote cleanup has not been established. `outcomeUncertain` remains true for missing/malformed responses, failed requests or unbound operations. |
| `CANCELLING` | The exact bound remote operation reports Shopify `CANCELING`; cleanup remains pending. |
| `CANCELLED` | The local cancellation is fenced and the exact bound remote operation is terminal. `remoteStatus` preserves whether Shopify ended as CANCELLED, COMPLETED, FAILED or EXPIRED; local cancellation does not mean Shopify necessarily ended with CANCELLED. |

`cancelled:true` is reserved for terminal cleanup. Pending cancellation is a normal result, not an exception. Local database/fencing failures still fail the operation. This follows Shopify's [asynchronous cancellation contract](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationCancel).

The production phase runtime already persists cancellation intent, uncertainty and retry eligibility separately and polls the exact bound operation. The legacy import scanner is now updated to honor the adapter's nonterminal result: it retains `cancel_requested`, stores `REMOTE_CANCEL_PENDING` or `REMOTE_CANCEL_OUTCOME_UNKNOWN`, releases its lease and schedules another bounded attempt. On recovery it observes the exact operation before resending; `CANCELING` does not trigger another mutation. Terminal acknowledgment requires one live shop/job/fence/lease update. Public import metadata exposes `cancelPending` and `cancellationState` without adding database enum states.

Generation reclamation now explicitly blocks cancellation-requested jobs that have not reached CANCELLED or SUCCEEDED, including old FAILED legacy rows. This protects pending cleanup when the cancellation scanner is temporarily stopped longer than normal history retention. A missing remote binding cannot be resolved by adopting `currentBulkOperation`; it stays uncertain and needs exact-identity evidence/manual review. No historical unproven cleanup is retroactively certified.

## Maintenance diagnostics and throughput

Every failed `runOnce()` records a redacted event with the retention/encryption stage, failure count and a category such as DATABASE, KEY_UNAVAILABLE, HISTORY_CONTRACT or EXECUTION. Only a closed set of known error codes is retained; arbitrary messages, stack traces, pool configuration, snapshot values and key material are not logged. Runtime status retains the last sanitized failure. The one-shot scheduler command emits the same safe failure information and exits nonzero.

Throughput can be tuned with server environment settings:

| Setting | Default | Allowed range |
| --- | --- | --- |
| `HISTORY_PURGE_BATCHES_PER_PASS` | 5 | 1–20 |
| `HISTORY_PURGE_BATCH_SIZE` | 250 | 1–500 |
| `HISTORY_ENCRYPTION_BATCHES_PER_PASS` | 1 | 1–10 |
| `HISTORY_ENCRYPTION_BATCH_SIZE` | 10 | 1–25 |
| `HISTORY_MAINTENANCE_PASS_BUDGET_MS` | 60000 | 1000–300000 |

No new batch starts after the pass budget expires; an already active repository transaction retains its own deadline and rollback semantics. A completed pass reports counts, review state and `budgetExhausted:true` when applicable. This is not a guarantee of empty backlog or a hard cancellation of an already sent transaction. Tune scheduler frequency and batch settings using backlog age, batch duration and review counts; reserve enough budget for both purge and encryption work. External scheduling/monitoring and production-volume verification remain deployment responsibilities.

## History cursor signing-key rotation

History cursors intentionally use one private HMAC signing key, copied at service creation. There is no overlapping verification keyring. Rotating that key invalidates old cursors with `HISTORY_INVALID_INPUT`; restart pagination from the first page to obtain a new cursor. This affects pagination continuity, not stored history or encryption keys. All replicas must use the same signing key: coordinate cutover/draining rather than leaving old/new keys mixed behind a load balancer. If seamless rolling rotation is required, a separately versioned multi-key cursor protocol is needed.

A regression proves old cursors work under the old key, fail under the new key, and that restarting pagination creates a cursor accepted by the new deployment. Tenant/installation/action binding and current read authorization remain unchanged.

## Validation and limits

- **1,310 backend tests passed**, zero failures/skips.
- Import audit: **489 files, 1,379 relative references, 161 package references**, no failures.
- Regression coverage includes concurrent/expired evidence, uncertain/accepted/terminal cancellation, durable cleanup retry and fenced acknowledgments, pending-cleanup retention, redacted diagnostics, configurable batch limits, pass-budget exhaustion and signing-key rotation.
- PostgreSQL schema/concurrency checks were attempted again but could not reach Docker's `dockerDesktopLinuxEngine`. Real database fencing, retention and distributed crash/restart behavior remain unverified here; the new unit cases do not certify them. No live Shopify request, migration or production scheduler change was performed.
