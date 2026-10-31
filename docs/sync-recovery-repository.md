# Fenced sync recovery transactions

`web/mirror/sync-recovery-repository.server.js` supplies
`createSyncRecoveryRepository({database, syncRunRepository,
verifyRecoveryEvidence, inputHash, leaseSeconds})`.

The production catalog recovery service now delegates its persistence to this
repository. Its private read-only verifier and receipt cache remain outside the
repository; there is no permissive evidence validator or exported receipt issuer.
`inputHash` is the trusted catalog-query hash, never a browser-supplied contract.
The synchronous evidence validator must return literal true after checking the
private receipt against the exact locked claim and intent.

## Persistence contract

- `claimRecovery({runId})` returns a frozen claim or null. It consults repository
  scheduling eligibility, then rechecks live durable state while claiming.
- `finishRecovery({claim, verification})` returns RESUMED, REVIEW_REQUIRED or
  STALE_CLAIM. Caller flags alone cannot authorize resumption.
- `recordRecoveryFailure({claim, reason})` returns RECORDED with the durable review
  disposition, or STALE_CLAIM. Failure does not clear uncertainty.

The claim includes the exact shop, text execution ID, generation, phase, owner
token, bigint-string fence, positive recovery attempt and frozen intent snapshot.
The intent pins ID, kind, operation ID, input hash, state, dispatch fence and
installation version. Recovery attempts are independent of ordinary attempts;
claims increment only the recovery counter, bounded at eight. Fence overflow and
exhausted recovery budgets require durable review and release the old lease.

## Transaction guarantees

Every transaction uses the existing Serializable helper and preserves the
ACCESS EXCLUSIVE publication barrier before state reads. The fixed execution
mapping is deeply frozen, physically verified and revalidated inside each
transaction. Lock order is publication barrier, shop, execution/job/ingestion,
then durable external intent. The repository operates on the existing
`catalog_import_executions` extension and BIGINT ingestion linkage; it creates
no parallel execution authority or schema migration.

Mutations match shop, run, generation, phase, token, fence, recovery attempt,
recovery worker role and the database's current lease time. They also recheck
completion, uncertainty, cancellation, review, installation and generation source
contracts. Operation-ledger writes repeat the live parent ownership predicate.
A stale CAS throws through the transaction to force rollback before returning
STALE_CLAIM. A held row lock is never treated as proof that a lease remains live.

Finishing checks the newly locked durable intent against the claimed snapshot.
Changed intent releases verification without adopting its new operation ID;
uncertainty and a durable rescan delay remain. Unissued evidence, incompatible
input hashes, invalid phase/generation states, or a dispatched start without a
proven response ID require review. PREPARED non-dispatch may resume only after
verified safe-to-retry evidence; its immutable intent is preserved and its state
made REJECTED so the existing start service can safely dispatch once.

Uncertainty clearing, child ingestion binding, ledger confirmation, counter reset
and lease release commit atomically. If the lease expires between those steps,
the final SQL clock check rolls everything back. Known operation binding still
uses the existing ingestion service. No Shopify/HTTP calls occur in transactions.

Unknown COMMIT acknowledgments propagate without replay or compensating writes.
The durable scanner and a fresh state read decide what actually committed.
SQL/connection/schema failures are not mislabeled as stale ownership.

## Verification

- Backend: 805 passed; one existing TODO.
- Disposable PostgreSQL schema/integration suite: 82 passed.
- Focused repository input validation: 4 passed.

The direct PostgreSQL cases cover duplicate claims, exact scope/counter fencing,
expired and superseded owners, private receipt rejection, immutable input,
intent drift, prepared recovery, rollback after lease expiry, lost COMMIT replies,
schema drift, cancellation and reinstallation. Existing production orchestrator
tests continue through the extracted implementation.

Evidence is saved in `.audit/sync-recovery-repository-backend.txt`,
`.audit/sync-recovery-repository-schema.txt` and
`.audit/sync-recovery-repository-focused.txt`. Tests simulate remote responses;
no live database writes or merchant imports are required for this change.
