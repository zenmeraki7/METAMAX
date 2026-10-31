# Durable scheduling and approval serialization

CAT-013 through CAT-018 are implemented in source. Apply
`20261029000800_schedule_occurrences_contract_hash` before using the updated
approval/scheduling services. No live migration was performed.

## Discovery and execution

`triggerDueSchedules` locks at most ten due schedule rows in a short transaction.
It copies each template into an immutable occurrence with a unique
(shop, schedule, scheduled time) identity, advances the schedule from its prior
due time, and commits. It performs no product selection, approval or dispatch.
Recurrences currently support UTC HOURLY, DAILY and WEEKLY intervals; unsupported
timezones and operations are explicitly rejected.

`processNextOccurrence` claims one due occurrence and processes exactly one
phase per call: SELECT, APPROVE or DISPATCH. Claims have lease tokens, monotonic
fences, a bounded 5–600 second lease (default 300 seconds), eight attempts per
phase and persisted exponential backoff. An expired final attempt becomes FAILED.
Cancellation is tenant-scoped and fences any in-flight checkpoint. A scanner can
resume expired claims after restart without relying on Redis job retention.

SELECT invokes `selectionService.withSelectionTransaction`, which opens the
catalog executor's protected repeatable-read transaction. All semantic filter
validation, field authorization, generation/coverage pins, paging, membership
writes and the occurrence's snapshot checkpoint use that transaction. The
scheduler never passes an arbitrary transaction client to all-matching selection.
It takes no schedule-row lock during materialization. A lost lease or cancelled
occurrence rolls back the entire draft and membership, including its checkpoint.
Frozen-at-creation schedules also save the schedule row through this interface.

APPROVE and DISPATCH use separate bounded transactions, locking only the current
occurrence. Approval and its contract checkpoint commit together; dispatch,
command, outbox and DONE checkpoint commit together. Lost COMMIT responses are
resolved through persisted phase/identities rather than creating another
approval or command. Intermediate failures retry their phase; an incomplete
SELECT phase restarts its atomic snapshot instead of exposing partial targets.

Scheduled selection is capped at 10,000 candidate products per occurrence.
Oversized selections fail closed rather than silently truncating. Ad hoc
all-matching selection supports up to one million through database-owned
membership; explicit and exclusion input lists are capped at 10,000. Expired
frozen snapshots require a fresh selection and approval, not an extended grant.

## Authentication and runtime integration

Schedule creation/listing/cancellation derive the tenant from `authContext` and
the trusted `resolveShop` dependency. The background `getScheduleAuthContext`
provider must freshly verify the schedule's shop and authorization grant for
each phase. A saved shop ID or template never issues permission. Existing
dispatch/worker write authorization remains mandatory.

The host worker should call discovery periodically, process eligible occurrences
one phase per task/poll, and independently run
`createOperationOutboxDispatcher({database,queue}).dispatchNext()`. These are
backend integration capabilities, not newly exposed HTTP endpoints. The current
app does not automatically bootstrap the bulk-edit scheduling runtime.

The outbox dispatcher leases committed events, publishes outside transactions,
then conditionally acknowledges its exact fence and token. An uncommitted or
rolled-back command is invisible to it. Uncertain queue responses preserve the
command and retry the same deterministic queue ID, with bounded eligibility.
Exhausted outbox delivery attempts remain inspectable for operator recovery.

## Canonical approvals and bounded selection results

New approval records store an explicit `canonical-v2` hash version, the exact
canonical UTF-8 JSON text and its SHA-256 hash. The versioned representation binds
shop, snapshot, operation, normalized contract, selection hash and approving
actor. JSON object keys are recursively canonicalized; array order is preserved.
Verification requires the recorded text, payload and hash to agree exactly.
Unknown versions and representation tampering fail closed. Existing records
retain `legacy-v1` verification without rewriting immutable approvals.

The isolated PostgreSQL suite verifies that `execution_contracts.contract` is
JSONB and tests nested-object round trips with different key order. This is not
an observation of the live production schema or a claimed production incident.

Selection creation returns only an opaque snapshot ID, metadata and count.
Membership is inserted in bounded batches; IDs are not accumulated for the
response. Hashing streams bounded database pages in numeric BigInt order.
Authenticated membership reads use keyset paging, default 100 and maximum 1,000
IDs. Existing stored selection hashes remain unchanged.

## Verification

`npm test` covers normalization, hash version/representation rejection, numeric
selection ordering, bounded responses and protected callback rollback.
`npm --prefix web run test:operations` uses a disposable PostgreSQL database to
exercise real all-matching schedules, frozen creation, lock release, retries,
expired leases, cancellation, exhaustion, lost commits, immutable checkpoints,
foreign-shop rejection and outbox visibility before/after commit and rollback.
