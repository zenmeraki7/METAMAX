# Durable external operation intents

`web/mirror/sync-external-operations.server.js` owns the normal catalog worker's
ledger writes using the existing `mirror.sync_external_operations` table. The
catalog sync steps call it around the remote bulk start; the existing recovery
repository continues to consume and reconcile the same durable rows. No schema
migration is needed.

- `prepare` commits an immutable, scoped `BULK_START` intent as `PREPARED` before
  dispatch. Repeated preparation returns that intent. A confirmed intent whose
  exact operation ID is already bound returns `alreadyBound`.
- `beginDispatch` conditionally changes only `PREPARED` or explicitly `REJECTED`
  intents to `DISPATCHING`, with the current dispatch fence. Only after its
  transaction commits may the worker issue the remote request.
- `recordResponse` persists the exact remote operation ID, including after lease
  loss. It matches tenant, execution, generation, input hash, intent ID, and
  dispatch fence. Repeating the same response is safe; a different response or
  an older dispatch cannot overwrite it. This method grants no execution rights.
- `reject` permits another dispatch only after the caller has observed an
  explicit remote rejection with no operation created. Transport errors and
  ambiguous responses leave the intent `DISPATCHING` for authoritative recovery.
- `confirm` acknowledges the operation and binds the ingestion run in one
  transaction. A failed binding rolls back confirmation, preserving separately
  committed response evidence.
- `recordCompleted` persists the validated remote count and ingestion run's
  expected count atomically. It accepts only a confirmed, bound operation during
  `WAITING`; repeating completion cannot change an existing completed count.

All normal mutations recheck live execution ownership before and after their
database work, rolling back on expiry, cancellation, installation changes, or
supersession. The response-evidence write deliberately does not require a live
lease. Database transactions contain no remote calls. Missing conditional-update
receipts and ambiguous commits require recovery rather than implicit redispatch.
The existing transaction runner retries aborted serialization/deadlock conflicts
and never automatically replays an uncertain commit.

An unbound `DISPATCHING` intent cannot prove whether the request reached Shopify.
Recovery therefore requires review if it cannot establish the exact operation
identity. This is conservative crash recovery, not a claim of remote exactly-once
execution.

Verification: `npm test` and `npm --prefix web run test:schema` (the latter requires
a disposable local PostgreSQL runtime). Direct ledger cases live in
`web/mirror/integration/catalog-phases.js` and exercise concurrent dispatch,
late evidence, dispatch fencing, scope/hash mismatches, rollback, and immutable
completion counts.
