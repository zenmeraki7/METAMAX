# Edit History V2 PostgreSQL validation

Validated on 2026-10-30 using a disposable local PostgreSQL 18.6 cluster.
The initial disposable tests did not modify the application database. The runner never
reads the application DATABASE_URL.
The subsequent authorized deployment is recorded in
[the deployment report](edit-history-v2-deployment-20261030.md).

Latest results: `npm run test:history:postgres` passed all 35 checks (34 subtests plus
the parent test); the existing `npm run test:schema` suite passed all 144 checks.

The fresh-install candidate is
`web/prisma-fresh/20261030110000_edit_history_v2/migration.sql`.
It intentionally lives outside Prisma's active migrations directory. V1 remains
unchanged: both fresh files create the same tables, so stacking them fails.
The active lineage now includes `20261030120000_edit_history_v2_upgrade`: it
upgrades an empty V1 using ALTER TABLE and replacement guards, without dropping
tables. It rejects populated V1 history rather than inventing missing snapshot
provenance or undo handoff keys. Never drop history to make the fresh file fit.

`npm run test:history:upgrade` passes 36 checks, including physical equivalence
with fresh V2, populated-V1 rollback, and all repository checks. The full active
migration schema suite still passes all 144 checks.

## Reproduce

From `web/`, run `npm run test:history:postgres`. Docker must be running, or set
`FILTER_POSTGRES_BIN` to a complete local PostgreSQL binary directory. The runner
creates its own database, binds only localhost, runs the suite, then stops and
removes its temporary cluster/container. CI runs the same command separately
from the existing V1 schema suite.
CI also runs `npm run test:history:upgrade` through the active upgrade path.

The suite applies all checked-in Mirror migrations preceding V1, then applies
V2 in one transaction. A forced DDL error verifies complete rollback. All changes
and BEFORE snapshots are inserted with explicit transactions; the missing or
mismatched BEFORE tests assert failure at COMMIT and absence of partial writes.

Verified behavior includes tenant/installation and operation composite foreign
keys; exact bigint round trips; JSON null versus SQL NULL versus ABSENT;
encrypted snapshot shape; pinned binding requirements; snapshot immutability;
one BEFORE snapshot per change; outcome evidence checks; legal transitions and
terminal protections; concurrent same-attempt deduplication; distinct retries;
undo request/handoff/job uniqueness and approved-plan immutability; recovery
target ancestry, claim shape and retry bounds; and direct deletion guards.

## Corrections to the supplied candidate

The supplied SQL installed, but two regression tests demonstrated evidence
bypasses. PostgreSQL accepts CHECK results of NULL, and PL/pgSQL does not enter
an IF branch whose condition is NULL. See the
[PostgreSQL constraint documentation](https://www.postgresql.org/docs/18/ddl-constraints.html).

- The outcome CHECK now requires its expression to be TRUE, rejecting terminal
  outcomes with NULL evidence.
- Transition evidence comparisons use IS DISTINCT FROM so NULL is rejected.
- An additional CHECK enforces matching evidence for OUTCOME_UNKNOWN and
  ACKNOWLEDGED on INSERT and same-state UPDATE, preventing evidence removal.

The candidate's path comment reflects its staging location. Other changes from
the attachment are limited to these evidence checks.

## Repository integration boundaries

Passing this suite establishes the tested fresh-schema behavior, not runtime
authorization or live deployment readiness. The repository must still verify
authoritative Mirror command/item/contract ownership, immutable installation
binding, current execution fence/lease, and authenticated observation receipts.
History fence values are coordination metadata, not Shopify mutation authority.
Commit BEFORE evidence and journal intent before any external mutation.

Before admitting a journal write, the repository must compare each BEFORE
snapshot's execution fingerprint with both its persisted operation and the
authoritative execution plan. Its filter fingerprint and field-resolution
fingerprint must match the plan's trusted engine coordinates, loaded server-side
inside the transaction. A browser-supplied hash or equality between two supplied
records proves neither provenance nor authorization.

For every field written by one execution request, verify a shared mutation ID,
attempt ID/number, execution fence/claim and mutation-plan fingerprint, together
with authoritative job/item associations and complete approved field membership.
Include existing rows when validating retries. Serialize admission against
execution ownership so concurrent per-field inserts cannot introduce conflicting
attempt identities. The current SQL's per-field unique keys do not establish
this cross-field invariant. The implemented journal repository now enforces
these comparisons and serializes complete request admission. See
[the repository integration contract](edit-history-journal-repository.md) for
its mandatory trusted authority/receipt adapters and execution boundary.

Cross-schema FKs, runtime role grants/RLS, executor handoff idempotency and a
legacy reader/upgrade remain explicit integration work. History SQL does not
enforce a complete undo/recovery state machine, maximum retry exhaustion, lease
expiry, or compare-and-swap fencing; those require conditional repository writes
and transactions. Deterministic queue IDs cannot substitute for database
idempotency. Journal preparation and dispatch are implemented and tested;
outcome reconciliation, undo/recovery/retention repositories and production
worker composition remain separate integrations.
