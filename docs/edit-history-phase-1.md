# Edit History Phase 1 — contract and PostgreSQL schema

Completed implementation review and verification on 30 October 2026.
This closes the V3 contract/schema phase; it does not assert that the production
execution adapters, mutation worker integration, undo or recovery phases are done.

## Deliverables

| Deliverable | Final source / evidence |
| --- | --- |
| Finalized V3 contract | `web/edit-history/history-contract.js` |
| Substantive contract tests | `web/edit-history/tests/history-contract.test.js` and `snapshot-service.test.js` |
| Tested fresh V2 schema reference | `web/prisma-fresh/20261030110000_edit_history_v2/migration.sql` |
| Tested/deployed active V2 migration | `web/prisma/migrations/20261030120000_edit_history_v2_upgrade/migration.sql`, after unchanged V1 |
| Exact live tenant/fence bindings | [Database bindings](edit-history-database-bindings.md) |
| Deployment and recovery evidence | [Deployment report](edit-history-v2-deployment-20261030.md) |

## Contract finalization

V3 fingerprints retain the existing scheme and serialization; a fixed golden
vector protects the wire format. Structural normalization is deliberately not a
provenance or authorization grant. The Field/Filter Engine bridge verifies issued
contexts; journal admission independently verifies durable plan/receipt authority.

Job/item identities now require canonical positive signed-64-bit decimal strings,
matching actual Mirror BIGINT keys. Tests previously used opaque job/item strings;
those fixtures are corrected without conflating a logical operation ID with an
execution job ID. Fencing epochs preserve exact bigint digits and reject unsafe
numbers, overflow, zero and noncanonical forms.

Snapshot/intent consistency now revalidates snapshot content, observation
fingerprints, observation linkage and intent fingerprints. Mutated evidence or
intended values with stale hashes fail. Transition options reject unsupported
properties and accessors; malformed states cannot invoke object coercion. Every
legal/illegal state pair and the five mandatory evidence classes are covered.
Other tests exercise canonical JSON limits, legacy/future versions, binding
coordinates, NULL versus ABSENT, receipt/source identity, corrections, undo
preflight restrictions and bounded pagination.

## Test-suite correction

The original `history-contract.test.js` was empty, as were seven other future
phase placeholders. Node's test runner reported each empty file as a pass.
`test:history` now discovers implemented test files and explicitly reports the
excluded empty placeholders. The V3 contract suite is substantive and is also
included in the normal backend/CI test command. Empty placeholders are retained
for later development, but are not evidence of completed functionality.

## Migration issues resolved

All five mutation evidence comparisons use `IS DISTINCT FROM`. The outcome
CHECK must evaluate to TRUE, and an additional CHECK protects NULL evidence on
INSERT and same-state UPDATE. Regression tests verify all five trigger branches.

The deferred BEFORE barrier verifies the exact operation/resource/field/revision
and snapshot fingerprint. The journal repository additionally checks execution,
filter and field-resolution fingerprints against authoritative server-loaded
execution data, plus shared mutation-attempt identity for the complete field set.
Those repository checks are exercised against real PostgreSQL; self-consistent
browser hashes are insufficient.

The fresh V2 file cannot follow V1 unchanged. The active upgrade uses ALTER TABLE,
adds six required columns and installs equivalent V2 constraints/indexes/triggers.
It aborts on populated V1, preserving all legacy rows rather than fabricating
provenance. Disposable tests compare fresh and upgraded catalog definitions and
verify rollback. Previously applied migrations were not rewritten in this phase.

## Verification results

| Command | Result |
| --- | --- |
| `npm run test:history` | 24 substantive tests passed; seven empty files excluded |
| `npm run test:history:postgres` | 27 checks passed on disposable PostgreSQL 18.6 |
| `npm run test:history:upgrade` | 28 checks passed on disposable PostgreSQL 18.6 |
| `npm test` | 995 passed, zero failures, one pre-existing unrelated TODO |

The two PostgreSQL suites include an assertion of the actual Mirror command
tenant/claim shape. Live verification used read-only catalog queries on
`newmeta_app` / `br-frosty-darkness-aod5t1wf`; it confirmed tenant `shop_id TEXT`,
`fence BIGINT`, `lease_token TEXT`, `lease_until TIMESTAMPTZ(3)`, RUNNING status
and cancellation coordinates. Installation/attempt/mutation columns are absent.
No new live DDL was necessary for this Phase 1 finalization.
