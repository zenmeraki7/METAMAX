# Phase 2, first file: history repository

[History security](edit-history-security.md) now implements restricted database
role verification, encrypted snapshot values and default redaction, controlled
legacy encryption, 30-day bounded retention and reinstall-safe privacy hooks.

[Execution Authority V2](edit-history-execution-authority.md) is integrated inside
the journal transaction through the verified engine ownership queries. Resource/
field pairs identify request members, while actual engine ownership and separate
dispatch permission remain mandatory. See the
[integration report](edit-history-authority-integration.md) for migration ordering,
Repeatable Read fencing, legacy replay and transaction-lock/durability tests.

Implemented `web/edit-history/history-repository.server.js` as the owner of
history persistence, Bulk Edit Engine approval verification, snapshot ownership
and authenticated reads. The old journal factory remains a compatibility alias.

The repository provides atomic request preparation, separately committed
single-winner dispatch, outcome/verification persistence, durable fenced recovery,
operation/request/snapshot reads and signed paginated metadata. It verifies
the actual approval through the existing approval service, compares the bulk
edit item payload with approved normalized instructions, and checks exact pinned
selection membership before recording any history. Existing V3 plan, field,
attempt, installation and live fence checks remain enforced.

Optional Mirror BEFORE references must match the trusted admitted plan and own
the exact shop/item/command/resource. Their lineage is written with the V3
snapshot and preserved exactly on retry, including IDs above 2^53. The receipt
adapter receives the independently owned Mirror row and must authenticate its
field value and receipt; no arbitrary field-to-source mapping is invented.

The [production QA report](edit-history-production-qa.md) maps all eight findings
to implementation and regression coverage. Mirror SQL now belongs to the trusted
Execution Engine adapter, which verifies actual catalog bindings. Shared approval
verification requires the explicit transaction. Replay authenticates persisted
BEFORE receipts. The new immutable request envelopes independently enforce the
complete field set and shared mutation attempt at COMMIT.

Dispatch requires independent permission and single-use token consumption at
the actual sender. Commit-before-send crashes and uncertain commits require
reconciliation, never automatic resubmission. Outcome evidence is loaded by opaque
ID from trusted durable storage, authenticated and persisted for the full request.
AFTER snapshots are immutable. Recovery supports discovery, fenced takeover,
renewal, bounded backoff, cancellation and review-required exhaustion.

Reads have separate current permissions for operation, request and snapshot
access. They enforce tenant/installation and full operation/change ancestry,
validate stored V3 snapshot content and observation linkage, return bounded
immutable results and redact execution lease authority. They remain suitable
for inspecting a lost COMMIT without authorizing a resend.

The factory still requires trusted tenant, durable execution-plan, live engine
authorization and receipt adapters. A read authorization adapter is required
only when a read method is called. None is inferred from a browser hash, a
structurally valid record or an earlier authorization response. See the
[full integration contract](edit-history-journal-repository.md).

## Validation

| Command | Result |
| --- | --- |
| `npm run test:history` | 61 passed across seven implemented test files |
| `npm run test:history:postgres` | 92 passed |
| `npm run test:history:upgrade` | 93 passed |
| `npm run test:schema` | 144 full migration-chain PostgreSQL checks passed |
| `npm test` | 1,034 passed; zero failures; one pre-existing unrelated TODO |

Coverage includes rollback, duplicate admission/dispatch, genuine approval hash
verification, exact approved targeting, rejection of foreign tenant/item
snapshots, bigint preservation, scoped reads, receipt/content corruption,
mid-transaction revocation/expiry, bounded retry and uncertain COMMIT handling.

The pending uniqueness, envelope, security/retention and undo-execution migrations are tested on
disposable PostgreSQL and not deployed live. Applied V1/V2 migrations are
unchanged. The worker send boundary, undo preflight/approval/handoff and recovery
are now composed and tested; see [execution fixes](bulk-execution-history-fixes.md).
Production durable providers, provenance backfill, permissions and SDK retry
configuration still require deployment review before activation. Passing tests
does not itself approve live Shopify dispatch.
