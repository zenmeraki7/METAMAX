# Approved bulk and undo dispatch

CAT-009 through CAT-012 are enforced at the service and worker boundaries.

`createSelectionService` and `createJobDispatchService` require a trusted
`resolveShop(authContext)` dependency. Every selection mode and both dispatch
methods require an authentication context and reject a caller's `shopId`.
HTTP consumers must pass the opaque context issued after Shopify request
verification; browser shop identifiers are not part of these request contracts.
The current app has no public bulk-dispatch controller to update.

Dispatch additionally requires `approvalService.getApprovedContract` and
`authorizeWrite`. There is no unchecked contract lookup fallback. The latter
is a backend capability that must revalidate current installation, scopes,
operation/field permissions, registry/definition versions and approved target
authority; it must explicitly return true. Field metadata and normalization do
not grant permission. The worker requires the same contract and authorization
capabilities and rechecks them immediately before mutation. Missing dependencies
fail initialization. Schedules require a trusted context provider per occurrence.

## Durable identity and transaction

The command identity is SHA-256 over authenticated shop, operation kind and
immutable approval contract ID. Caller idempotency keys cannot change it.
The database also enforces UNIQUE(shop_id,kind,contract_id), in addition to its
existing UNIQUE(shop_id,idempotency_key). Conflict handling covers both unique
constraints, then reads the committed winner. Replays return its receipt and
create no new targets, audit rows or outbox entries.

Apply migration `20261029000700_operation_dispatch_identity` before using the
updated dispatch service. Historical duplicate operations cause migration
failure for operator review; no rows are silently deleted. This change prepares
the migration in source and does not deploy it to a live database.

Owned transactions use READ COMMITTED so a concurrent loser can observe the
winner, with a two-second lock timeout and thirty-second statement timeout.
External transaction clients are backend-only and must provide transaction
ownership, timeouts and rollback/retry. A concurrent
winner invisible to an external repeatable-read snapshot causes a retryable
failure rather than another operation. Dispatch never calls the queue directly.
`createOperationOutboxDispatcher` reads only committed outbox rows and publishes
outside database transactions, using leased/fenced acknowledgments, bounded
backoff, eight attempts and a deterministic scheduling identity. Redis failures
cannot roll back or mutate the command. External owners commit command and
outbox together before the dispatcher can observe them.

## Instructions and targets

A bulk approval must explicitly contain `updates`, with product SET operations
supported by `operation-instructions.server.js`. That module resolves values
through canonical field write policies. It rejects arbitrary API properties,
dynamic fields, display metadata and unsupported operation shapes. Extra outer
approval metadata is never copied into mutation instructions. Dispatch checks
the approved snapshot membership count and materializes targets with one
parameterized INSERT ... SELECT scoped to shop, snapshot and exact generation.
Targets are not fetched into Node or inserted individually.

Undo requires a fresh approved contract with operation `undo`, an undo selection,
and payload `{sourceCommandId, fields}`. Values come only from confirmed,
successful immutable source snapshots for the selected resources. SQL projects
only approved keys from before-values and binds the restore snapshot; it does
not forward entire before-state documents. The worker verifies that source,
resource, after-hash and stored intended values agree with the approval before
applying the restoration.

The worker rejects any intended field or value absent from the immutable
contract. `targetTitle` is not a mutation field. Authoritative reads and a real
mutation adapter are required; synthetic before-state and local simulated
mutation fallbacks are removed.

Approval creation now follows the database's DRAFT-to-APPROVED transition and
cannot outlive its selection. Contract hashing canonicalizes JSON object order
so PostgreSQL JSONB ordering cannot invalidate an unchanged approval. New
approvals store `hash_version=canonical-v2` and the exact canonical text and
verify both against the stored JSONB payload. Unknown versions fail closed.
Legacy hashes are accepted only under their recorded legacy version and only
if recomputed from the actual stored contract.

## Verification

`npm test` covers explicit authentication, revoked grants, stable retries,
concurrent-conflict paths, rollback, constant-size set-based SQL for 100,000
targets, instruction tampering and worker field allowlists. This is a SQL-shape
test for that target count, not a 100,000-product load benchmark.

`npm --prefix web run test:operations` migrates a disposable PostgreSQL database
and tests real concurrent bulk and undo dispatch, uniqueness under changed keys,
metadata separation, multi-page snapshots, revocation and transactional rollback.
No application DATABASE_URL or live Shopify writes are used by these tests.
