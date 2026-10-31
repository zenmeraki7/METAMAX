# Transactional history journal repository

Snapshot storage and reads additionally enforce the
[security and 30-day retention contract](edit-history-security.md): an issued
valueProtection/key provider is required for VALUE writes, and ordinary snapshot
read permission alone returns a redacted result. Values require a separate
authorizeHistoryValueRead grant. Runtime pools must pass per-connection
least-privilege verification; migration-owner credentials are rejected.

The [Execution Authority V2](edit-history-execution-authority.md) is integrated
through `repository-authority.server.js` inside the journal transaction, using
the verified engine ownership queries. Resource/field pairs identify members.
Live worker composition and independent dispatch permission remain unchanged.

`web/edit-history/history-repository.server.js` exports `createHistoryRepository`.
The implementation now lives in that file. `change-journal.server.js` preserves
the old factory name as a compatibility export. It provides transactional
`prepareRequest(input)` and `beginDispatch(input)`, plus `getOperation(input)`,
`getRequest(input)` and `getSnapshot(input)`. Outcome, verification, recovery,
dispatch-consumption and paginated read APIs are documented in the
[production QA report](edit-history-production-qa.md). None executes a
Shopify mutation. Construction fails unless all trusted backend dependencies
are supplied. This module is not an HTTP endpoint.

## Input and durable ordering

Each method takes `{ authContext, operationId, mutationId, claim, entries }`.
`operationId` is the history UUID, not the execution engine's logical operation
ID or bigint edit aggregate ID. `claim` contains exact decimal `fenceEpoch`, the
engine's `executionClaimId`, and the private `leaseToken`. Each entry contains an
issued `beforeSnapshot`, issued `intent`, normalized `attempt`, and the trusted
`resourceFamilyGid`, and optionally an explicit `mirrorBeforeSnapshotId`.
Additional top-level properties (including caller plans,
tenant IDs, fingerprints and SQL) are rejected. The complete request contains
one execution item and between one and 64 unique resource/field pairs. Each
resource must independently pass approved targeting and actual engine item
ownership. Structural support for multiple resources does not grant write access.

`prepareRequest` independently loads authority, verifies every entry, and commits
the operation, every per-field change, every BEFORE snapshot and counters in one
transaction. An exact replay returns the same IDs without incrementing counters.
Replay reconstructs persisted BEFORE snapshots and reauthenticates their durable
receipts. Existing records are compared with the authoritative request, including stored
snapshot values, receipt coordinates, engine fingerprints and attempt identity.
Partially recorded or conflicting requests fail closed.

Only after preparation returns successfully may the worker call `beginDispatch`.
That method repeats authorization/ownership/evidence checks and atomically moves
the complete request from PREPARED to DISPATCHING. Only one caller can succeed;
an already dispatched or uncertain request must be reconciled. Dispatching SQL
and PREPARED inserts are separate committed transactions, so the BEFORE barrier
cannot be satisfied by evidence that is still uncommitted when dispatch starts.
`beginDispatch` returns a private single-use dispatch token. The worker must
commit `consumeDispatch` under independent permission and current engine
ownership immediately before sending. A crash or uncertain consumption COMMIT
requires reconciliation and cannot authorize a resend.

## Bulk Edit Engine and snapshot ownership

Mirror SQL belongs to the trusted Execution Engine integration adapter in
`web/services/history-execution-adapter.server.js`. Every transaction verifies
actual column types/nullability, timestamp precision, validated composite joins
and referenced unique keys. It calls shared `getApprovedContractInTransaction`
with the explicit transaction client, without a fake database or fallback
connection. The service recomputes the approved contract
hash and verifies the canonical/legacy approval representation. Matching an
opaque hash in the plan and database is insufficient. For `bulk_edit`, the
repository also compares the entire immutable item payload against normalized
`bulkInstructions` from the real approved contract.

The exact resource family must exist in the approved selection's pinned Mirror
generation. A child variant must belong to that selected product in the same
generation and have complete variant coverage. Command/item ownership does not
substitute for this membership check. The complete approved field set and its
resource coordinates are still checked against the independently loaded plan.

An explicit `mirrorBeforeSnapshotId` must also appear in the trusted plan field.
The repository joins `mirror.product_snapshots` through `mirror.job_items` and
requires exact shop, item, command and resource ownership plus a captured hash.
It passes that owned source row to `verifyObservation`, which must verify the
field value and receipt using trusted field mappings. It does not derive a
physical snapshot ID from an opaque binding or browser field path.

The reference is stored as `edit_history.snapshots.mirror_before_snapshot_id` in
the same transaction as the change and V3 snapshot. Exact replay checks it too.
Bigint references are read as dedicated scalar columns, preserving digits above
JavaScript's safe integer range instead of routing them through JSONB numbers.

## Required trusted adapters

Adapters are installed by backend composition, never accepted from an HTTP body.
All receive the repository's transaction client; database reads must use that
client. Expiring callback clients accept a single parameterized SELECT and receive
an AbortSignal. Deadlines are five seconds per callback and fifteen seconds
aggregate; these are trusted functions, not a sandbox for untrusted SQL.
They must not execute external mutations, commit/rollback the repository
transaction, retain the client, cache authorization, or return readiness based
only on caller-provided hashes. Observation verification is against durable
authenticated evidence, not a fresh external write or an unbounded network call.

| Dependency | Required behavior |
| --- | --- |
| `database` | pg-compatible pool with `connect()` and transaction clients supporting parameterized `query()` and `release()`. |
| `resolveTenant({client, authContext})` | Resolve the authenticated `{shopId, installationId}`. Called again before commit. No browser tenant overrides. |
| `loadExecutionPlan({client, authContext, shopId, installationId, operationId, mutationId})` | Load the immutable, admitted execution request and its admission-time installation binding from trusted durable storage. Preserve that binding across reinstall; do not relabel an old command using the current installation. Return null when absent. Lock mutable dependencies and do not derive this plan from the submitted entries. |
| `authorizePlan({client, authContext, tenant, plan, contract})` | Return literal true only after current write authorization, authentic approved contract, issued Field/Filter Engine semantics, field membership, intended values, registry/definition versions, verified physical mappings and exact pinned coverage/targeting are revalidated. Called before validation and again immediately before the final lease check/commit. Field capability metadata or a previous readiness result is insufficient. |
| `verifyObservation({client, authContext, tenant, plan, snapshot, mirrorSnapshot})` | Independently load/authenticate the stored observation receipt, value, source coordinates and source freshness against the actual request. `mirrorSnapshot` is the independently owned Mirror row, or NULL when no lineage reference was admitted; verify its projected value using trusted field mappings when present. Return literal true only on an exact match. Receipt IDs/fingerprints supplied in the snapshot are references, not proof. |
| `authorizeHistoryRead({client, authContext, tenant, operation, operationRecord, request})` | Optional at construction, mandatory for reads. Require the exact current tenant, operation and action: `read_operation`, `read_request`, `read_snapshot`, `list_operations` or `list_changes`. Grants cannot be reused across actions. |
| `authorizeDispatch` | Independent current dispatch permission for the exact request and execution claim. Required for dispatch admission and token consumption. |
| `loadMutationEvidence`, `verifyMutationEvidence` | Load and independently authenticate a durable opaque evidence ID and its complete request, attempt and field coordinates. Required for outcome and verification methods. |
| `authorizeRecovery` | Separate action-specific permission for scheduling, discovery, claiming, renewing, retrying, cancelling and recording recovery evidence. Rechecked before commit. |
| `historyCursorSecret` | At least 32 bytes of server-owned secret for signed tenant/installation/capability-bound cursors. Required for list APIs. |

There is deliberately no default adapter that trusts request JSON. The existing
execution backend does not yet expose a durable V3 request/receipt authority;
applications must supply these adapters before integrating this repository with
the worker. The PostgreSQL tests use explicit fixture-only durable authority and
receipt tables, not an invented production schema or permissive runtime fallback.

## Authoritative plan contract

The plan is bounded canonical JSON with these required coordinates:

- `shopId`, immutable `installationId`, history `operationId`, `mutationId`;
- exact positive signed-64-bit decimal `executionJobId` and `editOperationId`;
- `executionContractId`, `operationKind`, `targetingSnapshotId`,
  `logicalOperationId`, `approvalRevision`;
- `executionFingerprint`, `filterFingerprint`, `fieldResolutionFingerprint`,
  `approvedContractFingerprint`, `mutationPlanFingerprint` (sha256-prefixed
  digests issued by the corresponding trusted source);
- `attemptId`, `attemptNumber`, exact decimal `fenceEpoch`, `executionClaimId`,
  canonical ISO `startedAt`, and immutable `itemIntendedValues`;
- `fields`: the complete approved request field set. Each field has `identity`,
  `binding`, `resourceFamilyGid`, `intendedValueKind` and, for VALUE,
  `intendedValue`, plus `mirrorBeforeSnapshotId` when linked to existing engine
  evidence. Identity/binding follow History Contract V3.

Each entry must match its plan field. Snapshot execution, filter and
field-resolution fingerprints must match the authoritative plan; execution and
filter fingerprints must also match the persisted history operation. All fields
share the plan's mutation ID, attempt ID/number, execution fence/claim/start time,
job/item/resource and mutation-plan fingerprint. Per-field definition revisions
remain field-specific. The immutable Mirror item payload is checked independently.

The repository itself verifies current installation/uninstall state, command
contract/status/fence/token/lease/cancellation, edit aggregate ownership, approved
contract hash/revision, approved selection/logical operation, published generation
and complete required coverage. For MIRROR_PINNED fields it checks the exact
generation/coverage coordinates against that selection. The engine adapter still
must establish physical mapping/version validity and fresh engine issuance;
database status columns are not sufficient authorization.

## Concurrency, retry and failure behavior

Write transactions take the shared publication barrier before tenant/command locks.
The command is locked before admitting its operation or changes, serializing
concurrent field sets for that execution. Transaction isolation is SERIALIZABLE.
Admission counters change only on new admission; outcome counters are recomputed
from durable fields. Ownership queries are deduplicated within a transaction.
Existing request history is bounded to
1,024 rows; larger histories fail rather than validating a truncated subset.
Previous attempts must have the complete matching field set, lower attempt
numbers, matching mutation identity, and FAILED_NO_WRITE on every field. Any
unknown, dispatched, successful or conflicting outcome prevents ordinary retry.

SQLSTATE 40001, 40P01, 23505 and adapter P2002/P2034 errors retry only rolled-back
database work, at most twice after the first attempt. Every retry reloads the
plan and reauthorizes. An uncertain COMMIT acknowledgment propagates without
replaying. In particular, a lost dispatch COMMIT does not grant permission to
send: reconcile the journal and authoritative executor before proceeding.

The final database-time lease check follows evidence/authorization checks and
the deferred snapshot barrier. It also checks approval and selection expiry
using database time. SQL/lock/idle transaction timeouts are bounded.
History-owned coordination fences never replace the execution command's lease.

## Authenticated durable reads

Read methods resolve the current authenticated tenant/installation and hold a
shared shop lock while reading one consistent REPEATABLE READ transaction.
They require separate read authorization before and after loading results,
re-resolve identity before commit, and never expose raw transaction clients or
execution lease tokens. Historical reads do not require a live worker lease and
do not grant permission to retry a mutation.

| Method | Input in addition to `authContext` | Result |
| --- | --- | --- |
| `getOperation` | History `operationId` UUID | Immutable metadata and string-encoded bigint IDs/counters; no worker claim secrets. |
| `getRequest` | `operationId`, `mutationId`, `attemptId` | At most 64 field receipts and persisted states, with shared attempt identity checked. Useful for inspecting an uncertain COMMIT. |
| `getSnapshot` | `operationId`, `changeId`, `snapshotId` UUIDs | An owned V3 snapshot reconstructed from persisted values, plus its explicit Mirror lineage reference. |
| `listOperations` | Optional `limit`, `cursor` | Separately authorized operation metadata page, limit 1–100. |
| `listChanges` | `operationId`, optional `limit`, `cursor` | Separately authorized change metadata page, without snapshot values or lease authority. |

Missing or foreign-scope records return NULL. Missing/denied read authority or
obsolete installations fail closed. Snapshot reads require exact tenant,
operation and change ancestry, recompute both value and observation linkage
fingerprints, and check their operation coordinates. Unsupported versions,
encrypted payloads without a versioned reader and corrupt stored evidence fail.
These are local integrity checks, not fresh authentication of a remote Shopify
observation. Original receipt authenticity is enforced at admission.

Reads intentionally retain access to admitted historical evidence when the
original worker lease has ended or its catalog generation has retired. They do
not invoke current write authorization or reinterpret an old snapshot as a new
execution grant. Cross-installation history browsing is not enabled implicitly.

## Verification and deployment

Run `npm run test:history:postgres` from `web/` with Docker or the portable
PostgreSQL binary directory configured. It tests the fresh V2 schema and the real
repository using a disposable localhost database. Tests cover engine-coordinate
spoofing, complete field/attempt binding, immutable item payloads, idempotent
replay, concurrent admission/dispatch, lease/installation/approval fencing,
observation failure, mid-validation revocation, rollback, retry conflicts and
lost COMMIT behavior. CI runs this command.
It also covers the real approval verifier, explicit Mirror snapshot ownership,
selection membership, authenticated reads and rejection of corrupt stored values.

The fresh V2 reference remains outside the active Prisma chain. The new repository
requires V1, `20261030120000_edit_history_v2_upgrade`,
`20261030125000_edit_history_multi_resource_integrity`,
`20261030130000_history_request_envelopes`, then
`20261030140000_history_resource_members`. These add resource-aware uniqueness,
complete-request/shared-attempt enforcement and explicit resource/family members.
Envelope creation refuses populated history without trusted backfill; the final
member migration preserves already valid legacy envelopes. The pending changes
are tested on disposable PostgreSQL and not deployed live.
The repository now persists outcomes and recovery work. External evidence
collection, worker wiring, HTTP routes, undo and retention remain integrations;
see the production QA report for rollout gates.
