# Edit history: verified execution database bindings

Verified against the checked-in Prisma models, SQL migrations, runtime SQL and
the live PostgreSQL catalogs on 2026-10-30. Live target: `newmeta_app`, application
branch `br-frosty-darkness-aod5t1wf` in project `bitter-dream-29677040`.
History V1 and the empty-V1-to-V2 upgrade are deployed; see the
[deployment report](edit-history-v2-deployment-20261030.md). No speculative
cross-schema history foreign keys have been introduced.

Production QA adds runtime catalog verification in
`web/services/history-execution-adapter.server.js` and a separate additive
history uniqueness, envelope and resource-member migrations. These are tested
against disposable PostgreSQL and not deployed live; see the
[integration report](edit-history-authority-integration.md). Current installation metadata remains
distinct from immutable historical admission identity.

| Execution concept | Physical database target | Identifier type | Tenant-scoped reference |
| --- | --- | --- | --- |
| Durable command / execution job | `mirror.job_commands` | `id BIGINT` (BIGSERIAL default) | `(shop_id TEXT, id BIGINT)` |
| Bulk edit aggregate | `mirror.edit_operations` | `id BIGINT` (BIGSERIAL default) | `(shop_id, id)` or unique `(shop_id, command_id BIGINT)` |
| Execution item | `mirror.job_items` | `id BIGINT` (BIGSERIAL default) | `(shop_id, id)`; `command_id BIGINT` links to its command |
| Existing before snapshot | `mirror.product_snapshots` | `id BIGINT` (BIGSERIAL default) | `(shop_id, id)`; unique `(shop_id, edit_item_id BIGINT)` |
| Approved execution contract | `mirror.execution_contracts` | `id TEXT` (Prisma UUID default, not SQL UUID type) | primary key `(shop_id TEXT, id TEXT)` |
| Approved selection | `mirror.selection_snapshots` | `id TEXT` | primary key `(shop_id TEXT, id TEXT)` |
| Authenticated tenant | `mirror.shops` | `id TEXT` (myshopify domain) | primary key `id` |
| Current installation identity | `mirror.shops.installation_version` | `TEXT` | mutable current-installation value; not an immutable historical installation table |

## Existing execution relationships

- `job_commands(shop_id, contract_id)` references `execution_contracts(shop_id, id)`.
- `edit_operations(shop_id, command_id)` references `job_commands(shop_id, id)`.
- `edit_operations(shop_id, preview_id)` references `execution_contracts(shop_id, id)`.
- `job_items(shop_id, command_id)` references both `job_commands(shop_id, id)`
  and `edit_operations(shop_id, command_id)`.
- `product_snapshots(shop_id, edit_item_id)` references `job_items(shop_id, id)`.

The tenant-scoped unique indexes backing these relationships exist in migrations.
An item FK and a command FK independently do not prove that the item belongs to
that command. The history repository must verify their relationship in its
transaction, or a future migration must introduce a suitable composite key.

## Exact live command tenant and fencing columns

Inspected `pg_attribute`, `pg_attrdef`, `pg_constraint` and `pg_indexes` on the
actual application branch. The same shape is asserted by the disposable
PostgreSQL history suites.

| Column | PostgreSQL type | Nullable | Default / meaning |
| --- | --- | --- | --- |
| `id` | `BIGINT` | no | sequence-backed execution job key |
| `shop_id` | `TEXT` | no | tenant scope; required on every lookup |
| `contract_id` | `TEXT` | no | approved execution-contract reference |
| `status` | `mirror."WorkStatus"` | no | defaults to `PENDING`; an active claim requires `RUNNING` |
| `fence` | `BIGINT` | no | defaults to `0`; a valid history attempt requires a positive exact epoch |
| `lease_token` | `TEXT` | yes | execution worker ownership token; keep private |
| `lease_until` | `TIMESTAMPTZ(3)` | yes | must be strictly later than database `clock_timestamp()` |
| `cancel_requested_at` | `TIMESTAMPTZ(3)` | yes | must be NULL before admitting dispatch |
| `attempts` | `INTEGER` | no | defaults to `0`; command claim counter |
| `max_attempts` | `INTEGER` | no | defaults to `8`; command retry ceiling |

The primary key is `(id)`. The live tenant candidate key is the unique index
`job_commands_shop_id_id_key` on `(shop_id, id)`. The live contract FK is
`(shop_id, contract_id) → mirror.execution_contracts(shop_id, id)`.
`command_retry_bounds` enforces nonnegative attempts/fence, a maximum attempt
budget from 1 through 100, attempts not exceeding that budget, and non-NULL
token/deadline for RUNNING. That CHECK alone does not prove lease freshness.

There is **no** `installation_id`, `installation_version`, `execution_claim_id`,
`attempt_id` or `mutation_id` column on `mirror.job_commands`. Do not invent a
column mapping for those V3 coordinates. Installation must be checked against
current `mirror.shops` and a separate immutable admission-time binding. V3
`executionClaimId` is a durable engine-issued reference, not an FK to a command
column and not a public encoding of the private lease token.

Current ownership is established transactionally by exact `shop_id`, `id`,
positive `fence`, private `lease_token`, RUNNING state, an unexpired deadline and
no cancellation. History coordination fences do not replace this command claim.

The local model also declares `job_commands_approved_operation_key` on
`(shop_id, kind, contract_id)`. That index is **not installed on this live
branch**: its operation-dispatch migration remains pending. Source model
metadata must not be reported as verified live uniqueness.

## Contract integration decisions still required

- History `executionJobId` should resolve to `job_commands.id`; it must not be
  confused with `edit_operations.id` or a selection's logical `operation_id`.
- History `executionItemId` resolves to `job_items.id`. The V3 identity
  normalizer and repository now enforce positive signed-64-bit decimal strings
  for both execution job/item IDs. Preserve exact digits; never coerce them
  through JS Number. Opaque IDs such as `job1`/`item1` are rejected.
- The current worker claim lives on `job_commands`: `fence BIGINT`,
  `lease_token TEXT`, `lease_until TIMESTAMPTZ(3)`, and `status WorkStatus`.
  Claiming increments `fence` and `attempts INTEGER`. There is no dedicated
  bulk-edit execution-claim or mutation-attempt table in the inspected models.
  Do not invent FKs for `executionClaimId`, `attemptId` or `mutationId`.
- Checking the current claim requires transactional verification of command,
  tenant, fence, lease token, running status and unexpired lease. An FK to a
  command or an old fencing epoch does not prove live ownership.
- Bulk-edit commands/items/snapshots currently have no installation identity
  column. `installationId` cannot be proven from those rows alone. An immutable
  admission-time installation binding is needed before history is enabled.
- Do not bind historical rows by FK to mutable
  `shops(id, installation_version)` without designing installation retention.
  The existing export installation-history migration explicitly removed that
  relationship so reinstall does not fail. Current installation authorization
  still requires a transactional check of version and uninstall status.
- `mirror.mutation_journal` is the catalog reconciliation journal, keyed by
  product/revision/source. It is not a bulk-edit mutation-intent ledger.
- Existing `product_snapshots` store resource-level `before_values` JSON and
  optional hashes. They are not automatically V3 per-field snapshots or trusted
  V3 observation receipts; conversion and evidence binding require validation.

## Runtime findings

`services/job-dispatch.server.js` creates the command, edit operation, intended
item values and outbox event in a transaction. It returns command and operation
IDs as strings, matching the underlying BIGINT keys.

`workers/operation.worker.js` reads current Shopify state and inserts/reuses a
`product_snapshots` row before calling `applyMutation`. For undo it independently
reads Shopify and compares its hash with the source snapshot's `after_hash`.
These existing behaviors correct the earlier chat statements that the worker
and undo reread path were absent. They do not establish compliance with the new
V3 history evidence, installation and transactional claim requirements.

## Source references

- `web/prisma/operations.prisma`: `JobCommand`.
- `web/prisma/bulk-editing.prisma`: `EditItem`, `EditOperation`, `PreviewContract`.
- `web/prisma/execution.prisma`: `SelectionSnapshot`.
- `web/prisma/undo.prisma`: `ProductSnapshot`, `UndoOperation`.
- `web/prisma/tenant.prisma`: `Shop`.
- `web/prisma/migrations/20261028000000_metamax_foundation/migration.sql`.
- `web/prisma/migrations/20261028000300_execution_reliability/migration.sql`.
- `web/prisma/migrations/20261030000300_export_installation_history/migration.sql`.
- `web/services/job-dispatch.server.js`.
- `web/workers/operation.worker.js`.
