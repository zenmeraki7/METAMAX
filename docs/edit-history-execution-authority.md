# Execution authority V2 with History Contract V3

`web/edit-history/execution-authority.server.js` implements the supplied
`createHistoryExecutionAuthority` / `authorizeAdmission` contract. It is an
explicit admission boundary using six privileged backend adapters. It contains
no Mirror SQL, transaction control, Shopify calls, lease issuance or default
authority provider.

```js
const authority = createHistoryExecutionAuthority({
  resolveTenant,
  verifyInstallation,
  loadApprovedExecutionPlan,
  verifyExecutionOwnership,
  verifyFieldAuthorization,
  verifyObservationProvenance,
});
const admission = await authority.authorizeAdmission({
  client, // Existing active PostgreSQL write transaction, owned by the caller.
  authContext,
  executionJobId,
  mutationId,
  claim: { fenceEpoch, executionClaimId, leaseToken },
  entries,
});
```

## Enforced checks

Requests and dependency records reject unknown keys, accessors, hidden properties,
symbols and non-data prototypes. Field arrays reject holes, decorations and
accessor elements, and contain 1–64 entries. Job/item IDs and fences require
canonical positive signed-64-bit **decimal strings**, matching V3; numbers and
JavaScript bigint values are rejected. Approved attempt timestamps and record
budgets are validated before ownership or field authorization callbacks.

Every snapshot, intent and attempt is reconstructed through V3 normalizers and
compared with its submitted version/content fingerprints. The complete approved
resource/field set, tenant/installation, job/item/mutation, resource family,
attempt ID/number/fence/claim/start time, intended value presence/content, mutation
plan and execution/filter/field-resolution bindings must match. VALUE null and
ABSENT remain distinct. Keys use JSON-encoded resource/field pairs.

Callbacks receive expiring SELECT/row-lock capabilities on the exact supplied
connection and an AbortSignal. Shared deadlines are five seconds per callback
and fifteen seconds aggregate. Before returning, the authority resolves tenant
identity again and repeats installation, field authorization and execution
ownership verification. Grants are not cached across calls or operations. The
result is frozen admission metadata without the private lease token; it is not
a dispatch capability or a reusable authorization grant.

## Trusted producer obligations

The caller must establish an active write transaction and follow the existing
engine's publication/shop/command lock order. The authority does not BEGIN,
COMMIT, ROLLBACK, release clients or certify transaction state from a `query`
method. `verifyExecutionOwnership` must use the actual engine integration to
protect the command, item and private lease with a transaction-held lock, and
revalidate database-time expiry/cancellation. Its required `lockScope` is
`AUTHORITATIVE_EXECUTION_JOB_UNTIL_TRANSACTION_END`. A string assertion cannot
itself prove that a producer holds a PostgreSQL lock.

The plan loader must use immutable, tenant-scoped admission storage, including
the historical installation binding. It must never derive authority from the
submitted entries or relabel an old command with the current installation.
Field authorization must revalidate actual approval, field definitions/registry,
permissions, targeting, coverage and physical mappings using trusted engine
services. Observation verification must independently authenticate durable
receipt content and provenance. Proof fields are binding checks on trusted
producers, not browser attestations. Nullable aggregate/contract metadata does
not waive the engine's approval policy for bulk edits.

## Journal compatibility and rollout

The journal now composes this module through `repository-authority.server.js`
within its own SERIALIZABLE write transaction. The repository's richer source
plan retains operation, selection, approval, item-payload and optional Mirror
lineage checks before projection into the authority contract. Actual engine
`lockAuthority`/`verifyTarget`/`verifyFieldOwnership` checks acquire protecting
locks; the authority rechecks the private claim using `assertExecutionClaim`
and its real SELECT FOR UPDATE query. All callbacks and writes use the same
connection. Replay reconstructs and authenticates persisted BEFORE receipts.
No authority object or proof is accepted from request JSON, and no detached
admission result authorizes a later transaction.

The schema and journal now identify members by resource/field pairs, allowing
the same field on distinct resources structurally. Per-member family coordinates
and shared attempt/item/fence metadata are enforced at COMMIT. Ownership caches,
replay, history reads and outcome evidence use resource/field keys. Multi-resource
evidence requires an explicit `resourceGid` per field. Existing single-resource
receipt shapes and fingerprints remain compatible. The actual engine currently
admits product SET instructions with exact item/resource ownership; those
verified queries remain unchanged and reject unsupported groupings. No variant
mapping or cross-resource write permission is fabricated.

Production durable providers, the pending migrations and independent
dispatch permission/token consumption remain the rollout gates in the
[QA report](edit-history-production-qa.md). This change activates no worker,
routes, production database writes or external mutations.

## Validation

Fourteen new unit tests cover malformed/caller-controlled inputs, exact bigint
IDs, proof scope, complete fields, intended values, receipt authentication,
mid-call revocation and callback lifetime. Three PostgreSQL checks compose the
authority with the real execution adapter and explicit fixture-only durable
stores: another connection cannot advance the command fence until the caller
transaction ends; missing receipts/corrupt approval reads fail; and lease expiry
during receipt verification rejects admission. Real approval immutability guards
remain enabled throughout the tests.

The authority tests run through both `npm run test:history` and `npm test`.
PostgreSQL tests run through the existing fresh and V1-to-V2 upgrade suites.

See the [journal integration report](edit-history-authority-integration.md) for
the corrected migration lineage and transaction-lock/durability test results.
