# Sync recovery orchestrator

`web/mirror/sync-recovery.server.js` exports
`createSyncRecoveryOrchestrator({recoveryRepository, externalVerifier,
verificationTimeoutMs, repositoryTimeoutMs})`. The existing
`createSyncRecoveryService` name is an alias for the same factory. The production
catalog recovery service now constructs the explicit orchestrator.
Its fenced persistence is implemented in `sync-recovery-repository.server.js`;
see `sync-recovery-repository.md` for SQL ownership and rollback guarantees.

The repository supplies `claimRecovery`, `finishRecovery` and
`recordRecoveryFailure`; the verifier supplies read-only `verify`. Repository
methods remain authoritative for eligibility, shop isolation, fencing, leases,
durable intent, retry budgets and final SQL evidence validation. The orchestrator
does not issue Shopify mutations, adopt an unbound operation, clear database
flags directly or create a second dispatcher.

## Workflow

1. Claim durable eligible recovery work. A null result returns NOT_CLAIMED.
2. Validate and freeze the exact shop/run/generation/phase/lease/fence/intent.
3. Verify externally, outside database transactions, with the exact scoped intent.
4. Submit CONFIRMED, SAFE_TO_RETRY or UNRESOLVED to the fenced repository.
5. Return only a validated acknowledgment. UNRESOLVED cannot yield RESUMED.

CONFIRMED/SAFE_TO_RETRY require explicit authoritative, nonempty evidence.
Neither that flag nor the evidence object grants permission to retry an external
effect. The production repository verifies its private receipt against the
current locked intent before resuming. Supplied scope fields in verification,
evidence and acknowledgments must match the claim. Malformed, cross-scoped,
accessor-backed, cyclic, sparse or excessive data fails closed.

Verification failures persist a fenced reason: VERIFICATION_INVALID,
VERIFICATION_TIMEOUT, VERIFICATION_FAILED or VERIFICATION_ABORTED. A durable
STALE_CLAIM is respected. A failure acknowledgment requiring review returns
REVIEW_REQUIRED; otherwise the outcome is RECOVERY_DEFERRED. A failure receipt
cannot claim that uncertainty was cleared.

## Deadlines and cancellation

Verification defaults to 30 seconds, configurable from 1 ms through 90 seconds.
Every repository stage defaults to a separate 15-second wait, configurable from
1 ms through 30 seconds. A deadline ends the orchestrator's wait; it does not
prove that a database transaction rolled back. Repository errors, timeouts and
unverifiable acknowledgments surface as OUTCOME_UNKNOWN without automatic replay
or a compensating failure write. Late results never start another workflow stage.
The production repository still enforces its own SQL deadlines and fenced writes.

`recoverRun(runId, {signal})` accepts an optional AbortSignal. Cancellation before
claiming returns RECOVERY_CANCELLED without repository or verifier work. After a
claim, cancellation persists a recoverable verification failure. During external
verification it aborts the supplied signal and prevents a late result from
reaching finishRecovery. Once final persistence starts, the orchestrator awaits
its bounded acknowledgment; cancellation cannot turn a possible commit into a
false rollback report.

The application runtime passes its shutdown signal into recovery. Production
database tests exercise shutdown, actual final-attempt exhaustion, lost binding
recovery and concurrent runtimes. The database lease, not an in-memory job ID or
deduplication cache, prevents duplicate verification and budget consumption.

## Verification

- Backend: 805 passed; one existing TODO.
- Disposable PostgreSQL schema/integration suite: 82 passed.
- Focused orchestrator unit suite: 32 passed.

Evidence: `.audit/sync-recovery-orchestrator-backend.txt`,
`.audit/sync-recovery-orchestrator-schema.txt` and
`.audit/sync-recovery-orchestrator-focused.txt`.
This implementation requires no schema migration or live database mutation.
