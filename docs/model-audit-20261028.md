# Step 1.4 — Existing model audit

Audit date: 28 October 2026. Scope: every Prisma domain file, constraints.sql,
all four migration SQL files, current backend SQL consumers, and the installed
catalog on isolated Neon branch `database-baseline-20261028`
(`br-gentle-feather-ao3qwrpo`, project `bitter-dream-29677040`, database
`newmeta_app`). No model, migration, table, index or database row was modified.

## Outcome and Phase 1 gate

Phase 1's stated baseline criteria are satisfied. This is permission to proceed
with reviewed development on the isolated branch, not a production-readiness claim.

| Criterion | Evidence |
| --- | --- |
| Clean schema validation | Prisma 7.10.1 `validate` passed again during this audit |
| Passing database integration tests | Fresh disposable PostgreSQL 18.6: 20 filter tests and 8 schema/migration tests passed; no skips/failures |
| Verified migration history | Four finished entries, no rollback; all live ledger SHA-256 checksums match local files |
| Isolated database available | Development branch retained; source/main not targeted by this audit |
| Schema reflects database | Baseline Prisma diff found no difference; this audit reread installed columns, constraints, indexes and triggers |
| Backend regression | Current source: 524 passed, zero failed, one pre-existing TODO |

The earlier baseline run had 509 passing backend tests. The current working tree
also contains sync/reconciliation/ingestion/bulk runner modules and their tests;
the current 524 count includes them. Those factories are exported, but no server
bootstrap invocation was found. Their presence is not evidence of live workers.

See `database-baseline-20261028.md` for connection names, branch lineage,
recovery point and migration checksums. Secrets remain in the ignored private
environment file; application connection architecture is unchanged.

## Live catalog inventory

- 36 application tables, 99 indexes, 47 foreign keys.
- 28 CHECK constraints and 26 non-internal triggers.
- 102 nullable physical columns.
- No invalid/not-ready indexes or unvalidated foreign keys found.
- No FK column pair has a different PostgreSQL type/typmod.
- No structurally identical duplicate indexes found, comparing table, method,
  key/include attributes, uniqueness, NULL uniqueness, opclasses, collation,
  ordering options, expression and partial predicate.
- All 99 indexes currently show zero recorded scans. Every application table
  has an estimated zero live rows. Statistics do not establish useful workload
  history. No index is removable on this evidence.

Raw reproducible evidence: `../.audit/inspect-models.mjs` and
`../.audit/model-audit-catalog.json`. The audit script is hard-bound to the
development endpoint and runs a read-only repeatable-read transaction. EXPLAIN
uses parameters and does not run ANALYZE or force planner settings.

## Findings requiring follow-up

### MA-01 — Generation retention can be shortened or cleared

Priority: high before implementing automatic cleanup. Confirmed from installed
trigger definition and `web/prisma/constraints.sql:105` (also embedded in initial
migration), not exercised with destructive SQL during this audit.

`MirrorGeneration.retainUntil` is nullable. `guard_generation_status` rejects
deletion only when `OLD.retain_until > now()`. NULL therefore does not prevent
deletion of an otherwise eligible FAILED/RETIRED generation. Updates explicitly
exclude retain_until from immutable metadata comparison, and no monotonicity
check prevents shortening/clearing it. Publication and selection FKs still
protect their referenced generations; this does not bypass those restrictions.

Recommendation: define NULL retention semantics, reject decreasing established
retention unless an explicit administrative release protocol allows it, and make
cleanup verify reader leases, references and publication protection. Add a new
migration plus destructive-cleanup/concurrency tests on an isolated database;
do not edit the applied initial migration. Do not blanket-make this column
NOT NULL while ingesting/failed lifecycle semantics are unresolved.

### MA-02 — Command cascades lack a complete retention boundary

Priority: high before enabling dispatch/export and cleanup. Confirmed schema
path; no active production deletion endpoint was found.

`OutboxEvent.command` and `JobArtifact.command` cascade from JobCommand in
reliability.prisma and operations.prisma. There is no JobCommand DELETE trigger
requiring terminal status, expired retention and completed dispatch/artifact
cleanup. For a command without an EditOperation or IdempotencyRecord restrictive
reference, deletion can cascade to pending outbox rows and artifact metadata.
Object storage bytes are not deleted by a PostgreSQL cascade.

EditItem also cascades from JobCommand, but EditOperation's RESTRICT reference
to the command and ProductSnapshot's RESTRICT reference to an item provide
additional protection. Do not describe the edit/undo graph as an unrestricted
command-to-snapshot cascade.

Recommendation: explicit command retention/deletion policy and an authorized
cleanup service; consider RESTRICT or a command delete guard in a reviewed
migration. Preserve retry/dispatch evidence until work is terminal and retained
external artifacts are safely accounted for. Test commands with and without
edit/idempotency references, not just the most-protected path.

### MA-03 — Dirty-row scanner ordering needs an extra Sort

Priority: medium; confirmed EXPLAIN, performance impact unmeasured.

`reconciliation-service.server.js:scanDueDirtyProducts` uses
`ORDER BY next_attempt_at ASC NULLS FIRST, product_id ASC`.
`catalog_changes_due` is `(shop_id,next_attempt_at,product_id)` with default
ascending NULLS LAST. The exact query plan uses that partial index for tenant
filtering, then Sort for NULLS FIRST. The otherwise equivalent NULLS LAST probe
does not require the same ordering adjustment.

Retain the index. At realistic dirty-row cardinality, benchmark a replacement
index using explicit NULLS FIRST versus a two-part due scan. The latter must
preserve fairness, bounds and retry semantics. No new duplicate index is justified
by empty-table cost estimates alone.

### MA-04 — Several FK/cleanup lookups have incomplete leading-key support

Priority: medium, workload-dependent. All FKs are valid; this is not broken
referential integrity. PostgreSQL does not automatically index child FK columns.

Priority candidates for measured cleanup/lookup tests:

| Child table | FK lookup columns after shop_id | Supporting workflow |
| --- | --- | --- |
| outbox_events | command_id | Command cleanup/dispatch inspection |
| job_commands | contract_id | Preview retention/deletion checks |
| execution_contracts | snapshot_id | Selection retention/deletion checks |
| selection_items | generation_id, product_id | Referenced-product retention checks |
| inventory_levels | generation_id, location_id | Location removal and inventory lookup |
| variants | generation_id, inventory_item_id | Inventory-item reconciliation/removal |
| mutation_journal | sync_run_id | Run retention/deletion checks |
| metafield_values | definition_id, owner_entity | Definition retention checks across generations |
| edit_operations | preview_id | Preview reference checks |
| job_items | restore_snapshot_id | Restoration snapshot retention |
| undo_operations | source_operation_id | Original-operation retention |
| idempotency_records | command_id | Command retention |

Existing indexes often still limit these scans to a tenant or generation; missing
the complete FK prefix does not mean no usable index exists. The raw audit also
flags publications, selection_snapshots and the selection_items-to-snapshot FK.
The publications primary key bounds a tenant to one row, and existing selection
indexes bound a snapshot; these are not automatic requests for wider indexes.

Add only indexes that materially improve measured cardinalities/plans. Consider
partial indexes on nullable child IDs only when the intended predicate and FK
enforcement plan can use them. Preserve shop-first scope and estimate write cost.

### MA-05 — Two logically subsumed unique-key candidates, neither removed

Priority: low; source/catalog observation, no removal recommendation yet.

- `subscriptions_shop_id_installation_version_key`: shop_id alone is the PK,
  so the wider unique key adds no uniqueness. No current FK targets subscriptions.
- `job_schedules_shop_id_id_key`: id alone is the PK; no current FK targets schedules.

These are not exact duplicate indexes: key shapes differ and query/API contracts
may depend on scoped keys. Trace future repositories/generated Prisma selectors,
compare plans and document intended tenant identity before considering removal.

In contrast, products/variants and other `(shop_id,...,id)` unique indexes are
referenced by composite FKs and/or support tenant-generation keyset queries.
The generation versioned unique key binds publication/selection revisions. Keep
them even where an ID is already globally unique. `shops(id,installation_version)`
binds subscription installation identity and is also intentional.

## Nullable-column review

No column was proven unnecessary merely because it permits NULL.

| Group | Decision |
| --- | --- |
| SyncRun expectedLines/bulkOperationId/completion fields | Keep nullable before remote startup/EOF; SUCCEEDED requires durable counts, EOF and writes_finished_at |
| Generation verification/publication/retirement timestamps | Keep state-dependent nullability; lifecycle checks require verified/published timestamps |
| Coverage verification fields | Keep nullable until COMPLETE; COMPLETE check requires evidence |
| Selection frozenAt/selectionHash; preview approvedAt/approvedBy | Keep nullable for DRAFT; approval checks require values |
| leaseToken/leaseUntil, retry/error/dead-letter metadata | NULL represents unclaimed/no retry/error state; do not manufacture defaults |
| MetafieldValue owner and typed-value columns | Keep nullable with exactly-one-owner/type checks; do not make both product and variant owners mandatory |
| Catalog optional SEO, comparison price, inventory-item link, publication fields | Keep; absent/unsupported data is distinct from zero/empty values |
| Undo beforeHash/afterHash/confirmation | Legacy migration intentionally preserves unconfirmed historical rows; new captures are guarded. A global NOT NULL change needs verified backfill |
| Generation retainUntil | Keep model unchanged now; strengthen lifecycle semantics under MA-01 |

Lease-pair checks are not uniform: JobCommand and IdempotencyRecord constrain
RUNNING leases, whereas SyncRun, CatalogChange, OutboxEvent and JobSchedule lack
equivalent full pair/ownership/expiry rules. This is a hardening candidate, not a
reason to make lease columns unconditionally NOT NULL. Validate legal states and
expiry-aware CAS in repositories, then add consistent checks where appropriate.

## Cascade review

23 ON DELETE CASCADE FKs were inspected. All inspected child-parent FK pairs
include shop identity. No cross-shop cascading relationship was found.

- Generation-owned catalog, inventory, collection, coverage and ingestion rows:
  intentional aggregate cleanup. Parent generation state/retention guard and
  publication/selection restrictive references matter; MA-01 remains relevant.
- Products to variants/options/memberships/metafields: intentional child cleanup
  inside a generation; immutable generation guards constrain direct writes.
- IngestionRun to checkpoints: intentional, but journal RESTRICT references may
  require journal retention cleanup before an old run/generation can be removed.
- SelectionSnapshot to SelectionItem: intended membership cleanup; approval
  trigger blocks deleting live approvals; parent deletion permits child cascade.
- Shop to webhook receipts/saved filters/subscription: plausible tenant cleanup;
  other RESTRICT references mean whole-shop purge requires ordered orchestration.
- JobCommand descendants: review MA-02 before enabling automated deletion.
- Undo/snapshot graph: restrictive references preserve evidence, but require
  explicit cleanup order and confirmation/approval expiry checks.

## Models and current use

No Prisma Client is instantiated; the running application uses pg SQL. Absence of
generated model-name imports therefore does not establish an unused table.

| Group | Current source evidence | Decision |
| --- | --- | --- |
| Shop, MirrorGeneration, SyncRun, SyncCheckpoint, MirrorCoverage | Read/written by current sync service/ingestion source, tests | Retain; factories are not server-wired |
| CatalogChange, MutationJournal, SnapshotProduct, SnapshotVariant | Reconciliation/ingestion source, compiler and tests | Retain; production wiring and behavioral validation remain separate |
| MirrorPublication | Publication repository, service and sync publisher | Retain |
| InventoryItem/Level/Location, collections/membership/options/category | Storage relationships; scalar projection support is narrower than these datasets | Retain as planned datasets; no active production handlers established |
| FieldMapping, MetafieldDefinition/Value | Schema guards/adapter contracts; dynamic SQL family not installed | Retain; stored mappings never replace trusted code mappings |
| SelectionSnapshot/Item, PreviewContract, EditOperation/Item | Constraints and integration fixtures; operational approval/executor services not found | Retain; not redundant catalog copies |
| JobCommand/Schedule/Artifact, OutboxEvent, IdempotencyRecord | Schema/future operation contracts and tests | Retain; operational dispatch/schedule/export services not found |
| ProductSnapshot, UndoOperation | Touched-field before-values/undo guards | Retain; distinct from catalog snapshot models |
| SavedFilter, AuditEvent, WebhookReceipt, Subscription | Planned lifecycle/storage contracts; no active application writes established | Retain; specify enablement/retention before use |

## Important query plans

These are natural planner choices on the empty development baseline, not load
benchmarks. No ANALYZE, merchant data scans, DDL or forced index settings were used.

| Query | Observed index/plan |
| --- | --- |
| Product keyset page | products_shop_id_generation_id_id_key |
| Same-variant SKU + price | Product scoped identity and variants_shop_id_generation_id_sku_product_id_idx |
| Due dirty products, actual NULLS FIRST | catalog_changes_due plus Sort; MA-03 |
| Due commands | job_commands_due |
| Due outbox | outbox_events_due |
| Publication/coverage lookup | publications_pkey, generation versioned unique key, coverage_pkey |
| Enabled due schedules | Seq Scan plus Sort on empty table; retain job_schedules_due and benchmark at representative scale |

The non-production scheduler/outbox/command probes reflect the schema's intended
scan contracts, not evidence that those consumers currently run. The product and
variant probes reflect actual compiler predicate/keyset shapes.

## Follow-up order

1. Specify and test generation retention and command/artifact deletion policies.
2. Reconcile new runtime services with these storage invariants before wiring them.
3. Use representative isolated fixtures for dirty-queue ordering and FK cleanup.
4. Propose narrowly supported indexes/constraints in new migrations only.
5. Preserve all existing tables/indexes until their replacements and dependents
   are verified. No drop migration is produced by this audit.

References: PostgreSQL 18 [multicolumn indexes](https://www.postgresql.org/docs/18/indexes-multicolumn.html),
[index ordering](https://www.postgresql.org/docs/18/indexes-ordering.html),
[constraints](https://www.postgresql.org/docs/18/ddl-constraints.html), and
[statistics](https://www.postgresql.org/docs/18/monitoring-stats.html).
