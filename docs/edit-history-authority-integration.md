# Resource-aware migration and transactional authority integration

`history-repository.server.js` now invokes Execution Authority V2 inside the same
SERIALIZABLE transaction as operation/envelope/change/BEFORE snapshot persistence.
It composes trusted adapters in `repository-authority.server.js`, preserving
the existing engine schema, real approval, pinned target, item payload and
snapshot-lineage checks. Protecting command/item locks are retained until COMMIT.
The authority's ownership producer rechecks the actual engine claim using the
verified `assertExecutionClaim` SELECT FOR UPDATE query on that connection.

Admission metadata alone grants no dispatch permission. The existing independent
dispatch check, separately committed journal, single-use token and consumption
boundary remain required. No Shopify sender, worker or route is enabled here.

## Corrected migrations

Applied V1/V2 files are unchanged. The pending active lineage after V2 is:

1. `20261030125000_edit_history_multi_resource_integrity`: replaces both attempt
   uniqueness constraints with resource/field-aware keys. The supplied draft was
   ordered before V2 and lacked a transaction wrapper. It now runs after V2,
   locks operations/changes before metadata/data audits, rejects ambiguous or
   unexpected old keys, and preserves both supported prior naming schemes.
2. `20261030130000_history_request_envelopes`: retains the tested journal's
   complete-request/shared-attempt and single-use token protocol. It refuses
   populated V2 without trusted admission provenance backfill.
3. `20261030140000_history_resource_members`: extends envelopes with immutable
   explicit resource/field/family members. Deferred guards require exact complete
   members, reject duplicate pairs and mixed item/attempt/fence/claim/plan tuples,
   and preserve valid existing single-resource envelopes without inventing grants.

The peer-consistency trigger updates the protecting history-operation row as well
as acquiring its lock. This forces stale Repeatable Read/Serializable writers to
abort and retry with a fresh snapshot. Merely waiting on FOR UPDATE would not
refresh a Repeatable Read peer scan.

The supplied alternate `20261030130000_edit_history_mutation_requests` draft
describes a different envelope/state-machine API. Its content is preserved under
`web/prisma-proposals/`, outside the active chain; applying it alongside the
current envelope migration would create the same table with incompatible columns.
Promoting it requires an explicit protocol migration and consumer review.

## Resource identity and compatibility

Journal lookups, ownership cache keys, prior attempts, replay, metadata reads and
outcome evidence now use collision-free resource/field pairs. Every target and
item/resource association is verified individually. The same field on another
resource cannot borrow a cached ownership result. Single-resource fingerprints
retain their previous domain and serialization. Multi-resource fingerprints bind
resource IDs and deterministic pair ordering; multi-resource outcome evidence
requires explicit resource IDs.

The existing engine's supported product SET instructions and exact item/resource
ownership remain authoritative. A structurally valid multi-resource set still
fails admission if that engine cannot own/authorize it. This change introduces
no new field mappings, variant mutation support or browser-selected SQL.

## PostgreSQL regressions

The suites test populated legacy-envelope preservation, acceptance of the same
field on two resources, rejection of duplicate/missing/misbound members, both
unique-key definitions, malformed migration preconditions, alternate prior names,
and a stale Repeatable Read writer followed by a valid fresh retry.

Integrated repository tests pause authority verification and prove another
connection cannot advance the execution fence while no journal is externally
visible. Authority callbacks, protecting SQL and snapshot inserts share one
transaction ID. After commit the complete journal is visible and the fence can
advance. An injected second-snapshot failure after successful authority checks
rolls back the operation, envelope, every change/snapshot and dispatch eligibility.
Existing concurrency, lease expiry, revocation, lost-COMMIT and independent
dispatch-consumption tests run against this integrated path.

All PostgreSQL runs use explicitly isolated localhost fixtures. No pending
migration is applied to the live database. Production durable authority/evidence
providers and actual sender wiring remain rollout requirements.

| Validation | Result |
| --- | --- |
| History unit tests | 47 passed |
| Fresh PostgreSQL integration | 65 passed |
| V1-to-V2 upgrade integration | 66 passed |
| Full migration-chain/schema regression | 144 passed |
| Backend regression | 1,018 passed, one pre-existing TODO |
