# Bulk Execution and Edit History fixes

Implemented 2026-10-31. The five findings in the earlier verification are fixed
in the worker and its server composition. No live migration or Shopify dispatch
activation was performed by this work.

## Execution boundary

`web/services/bulk-execution-runtime.server.js` composes the existing Bulk Edit
dispatcher/worker with the issued history repository, history executor, undo
repository and undo service. It requires separate engine/history connections
and trusted backend providers. Construction does not start a writer. The
operation supervisor accepts only an issued journaled worker, calls processOne,
does not poll when unconfigured, and awaits its current transaction on shutdown.

The worker has no legacy applyMutation path. The issued executor:

1. Loads a durable V3 request and checks the exact shop, installation, command,
   item, resource, fields, fence and private lease against the engine claim.
2. Prepares history with authenticated BEFORE evidence and normalized intent.
3. Reads the current exact product identity/values and commits the engine BEFORE
   snapshot under current ownership. That snapshot remains unconfirmed.
4. Admits dispatch under serializable resource-family coordination, checks
   competing unresolved requests, and rereads current values after admission.
5. Consumes a private single-use dispatch token under current authorization,
   approval and claim checks. A lost consumption COMMIT never triggers a send.
6. Invokes the existing transport once, persists an authenticated acknowledgement,
   rereads Shopify, and records VERIFIED only from authenticated observations
   matching the intended values for the exact resource/field set.
7. Completes the engine item and confirms its snapshot in one fenced transaction,
   then finalizes the operation only after durable terminal engine/journal state.

An arbitrary changed value after a timeout is no longer evidence of success.
Missing/wrong resource identities, mismatched values, transport exceptions and
post-send persistence errors retain uncertainty and schedule evidence-only
recovery. Expired claims do not authorize another attempt. The worker excludes
unresolved requests from automatic claims; local completion recovery inspects
VERIFIED history without resending the mutation.

Family coordination covers competing commands and previous installations of the
same shop. Short transaction advisory locks serialize admission; unresolved
journal records preserve the barrier after the transaction ends or a worker
dies. Serializable conflict handling and the durable predicate are tested on
real PostgreSQL. No database lock is held across the Shopify request.

Claims, item selection and budget/cancellation sweeps are bounded. Item retry
deadlines are enforced, exhausted claims enter durable review state, and
cancellation/completion audit events contain no values or lease tokens.

## Undo

The formerly empty undo modules now implement source eligibility, conflict
comparison, durable review/approval, stable engine handoff and recovery.

Only retained verified source changes with intact BEFORE/AFTER snapshots are
eligible. Source reads require independent undo, history-read and sensitive-value
permissions. Current observations must be authenticated; current inverse Field
Engine write policies must pass at preflight and again before approval. The
worker repeats current write/claim checks and compares both pre-send reads with
the expected post-edit values. An intervening value observed by either read
prevents the inverse write.

ABORT_ON_CONFLICT aborts the inverse set. SKIP_CONFLICTED excludes the complete
conflicted resource rather than partially restoring its fields. Requests and
resource scopes are immutable. Preflight reads at most 64 fields; resource-scoped
requests allow bounded undo of individual resources from larger operations.
Oversized unscoped preflights fail closed; this service does not load an entire
catalogue or implement a bulk-wide undo scheduler.

The approved inverse execution contract must contain the normal source command
and field instructions, plus this hash-bound metadata:

```js
historyUndo: {
  requestId,
  preflightFingerprint,
  inversePlanFingerprint,
  handoffKey,
}
```

The service accepts only the issued existing Bulk Edit dispatcher. It never
imports a Shopify write client. Lost handoff responses reuse the same approved
contract and command; they cannot create an independent writer. Handoff retries
use database time, exponential backoff capped at 900 seconds and an eight-attempt
budget. Exhaustion reports REVIEW_REQUIRED while retaining uncertainty.
Reconciliation can discover an already committed command without submitting
another. Inverse execution receives its own UNDO history and reconciles to a
durable completion/partial/failure state from authoritative engine and journal
records.

Ordinary retention now preserves source history while its inverse approval is
valid or its inverse handoff/execution is unresolved. Source-operation locks
coordinate approval with cleanup. Uninstall/privacy policies and legal holds
continue through the existing restricted maintenance path.

## Provider and migration requirements

The server composition requires the existing authenticated tenant, Field/Filter
authorization, durable plan, observation and outcome providers; fingerprints are
not grants. No provider or database can be selected by an HTTP body.

- `loadExecutionRequest` returns the genuine durable V3 request for the claimed
  item. Its finalize phase resolves the same committed references, not a new
  mutation attempt.
- `persistEvidence` durably records authenticated, complete attempt-bound
  receipts and returns an opaque ID. No-write evidence must prove no contact or
  otherwise establish authoritative no-write; an unchanged reread is insufficient.
- The existing transport must return the exact product id and requested fields,
  honor AbortSignal/deadlines, and disable hidden SDK/transport write retries.
  The executor supplies a stable application handoff key; it does not assume
  every Shopify mutation supports server-side idempotency.
- Undo providers authenticate current observations, revalidate current inverse
  write policies and create a new approved inverse contract/selection from the
  server-generated inverse plan. Approval creation must use the supplied stable
  handoff key and bind the historyUndo metadata above.
- Lifecycle permission checks include the separate complete_execution action;
  undo actions include request/read/preflight/approve/submit/execute/reconcile.

Apply the reviewed pending migrations through
`20261030160000_history_undo_execution`. The new migration adds immutable
installation pinning to Mirror commands, narrow undo privileges/resource scope,
supporting indexes, and Shopify AFTER provenance with pinned execution coordinates.
BEFORE provenance remains strict. Legacy commands are backfilled only when
durable history proves one installation; unproven commands remain unclaimable.
The pending security/retention migration also protects live inverse dependencies.
Applied V1/V2 migration files were not changed.

History snapshots remain encrypted and merchant receipts remain redacted. Mirror
compatibility snapshots and other execution stores retain their existing access
policies; this work does not claim whole-application encryption or backup erasure.
Current-value verification and application fencing do not create an atomic
compare-and-write primitive inside Shopify or control third-party writers.

## Verification

| Suite | Result |
| --- | --- |
| Backend `npm test` | 1,034 passed, no failures, one existing TODO |
| Fresh PostgreSQL history/worker/undo | 92 passed |
| V1/V2 upgrade history/worker/undo | 93 passed |
| Complete migration/schema chain | 144 passed |
| Existing bulk/undo dispatch | 18 passed |

Tests exercise
the actual worker, real dispatcher, restricted history LOGINs and durable fixture
receipt stores; Shopify transport is simulated and no live shop is mutated.
Coverage includes concurrent family writers, reinstall conflicts, wrong resource
responses, unrelated changed values, timeouts, revocation, lost consume/item/
handoff COMMITs, retry deadlines/exhaustion, cancellation, current inverse policy
revocation, undo's second-read conflict, inverse history and source retention.

The historical in-memory unsafe-behavior probe predates these fixes; it cannot
construct the current worker without the mandatory journal capability.

Shopify retry/idempotency requirements were checked using the installed
[Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) and official
[idempotency documentation](https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency).
