# METAMAX V7 target architecture

The five engine boundaries and the adjusted project layout are the target
architecture. Most scaffold files are placeholders, not implemented APIs or
evidence of production readiness. The shared environment, configuration-error,
database and Redis entry points now load and validate existing environment
settings; the database entry point reuses the established Prisma client.
Existing runtime modules remain in use until
their replacements are implemented, tested, and integrated.

## Shared engines

- `fields/` owns canonical fields, types, normalization, validation, sources,
  capabilities, resolution, and supported operations.
  The versioned field library is implemented for 47 currently mirrored fields;
  see `fields/README.md` for its API, supported operations and caller obligations.
  Its source catalogue includes logical dataset dependencies and readiness
  checks. Shop-scoped dynamic metafield registries resolve verified definition
  metadata only; dynamic value access and execution remain unavailable.
  Dynamic coverage accepts trusted resolved descriptors and checks per-definition
  identity/version and published shop/generation/snapshot bindings. The Mirror
  Engine must still produce durable per-definition completeness evidence.
  Declared capabilities are separate from runtime authorization, scopes, coverage,
  adapter and undo-journal readiness. The initial operation surface is limited
  to `set`, `add_tags` and `remove_tags`; no mutation execution is implemented here.
- `mirror/` owns datasets, synchronization, ingestion, revisions, reconciliation,
  coverage, checkpoints, publication, and retention.
- `query/` owns the filter AST, normalization, validation, operators,
  relationships, predicates, compilation, pagination, and cost analysis.
- `selection/` owns product and variant targets, materialization, exclusions,
  selection snapshots, validation, and cleanup.
- `execution/` retains all 17 proposed modules, including `conflicts.js`,
  `unblock.js`, `outbox.js`, and `shopify-gateway.js`. It executes immutable plans
  shared by manual edits, imports, and scheduled or recurring edits.

`execution/validation.js` must call `fields/validate.js` and add execution-specific
checks. Field validation rules must not be duplicated. Validation occurs at edit
submission, job planning, and immediately before mutation execution for checks
whose inputs can become stale. Earlier validation does not establish continued
execution eligibility.

## Integration and feature boundaries

- `shopify.js` configures the Shopify SDK, authentication, and sessions.
- `shopify/` owns GraphQL integration: `client.js`, `throttle.js`, `queries/`,
  `mutations/`, and `bulk/{queries,mutations,results}.js`.
- `filters/catalog.js` and `filters/categories/` describe the filter catalog using
  the canonical field contract. They do not define independent field contracts
  or query operators. `filters/routes.js` exposes the catalog.
- `shared/tenancy.js` and `shared/authorization.js` establish verified shop context
  for authenticated feature requests. Merchant-supplied shop identifiers are not
  authoritative. Workers independently resolve persisted, shop-scoped jobs and
  credentials.
- `shared/db.js` coordinates Prisma and direct SQL access through compatible
  clients and transaction semantics. It must reuse the established database
  infrastructure rather than introduce competing clients or transactions.
- `webhooks/` separates routing, verification, durable receipt, handling, and
  asynchronous reconciliation. Authenticate deliveries, record them durably,
  and acknowledge promptly; fetch authoritative Shopify state asynchronously
  where needed. Preserve uninstall and mandatory privacy/compliance handling,
  with subscription changes handled where applicable.
- `schedules/` owns schedule definitions, recurrence rules, time zones, and
  next-run calculation. `workers/schedules.js` enqueues due work through the shared
  execution engine.
- `workers/index.js` is the target worker entry point, separate from Express.
  It remains a placeholder; the existing `workers/run.js` remains the runtime
  entry point until integration is complete.

## Durable execution delivery

1. Persist the job and its outbox record atomically in PostgreSQL.
2. Dispatch the outbox notification with a deduplication ID.
3. Use BullMQ to deliver work notifications and retries.
4. Claim a database lease before running bounded execution batches.
5. Persist outcomes, uncertainty, history, and progress in PostgreSQL.

`execution/outbox.js`, `workers/dispatch.js`, and `workers/recovery.js` must work
together to tolerate both duplicate deliveries and missing notifications.
Database leases and durable attempt records determine execution eligibility;
queue deduplication alone is insufficient.

## Integration requirements

Preserve the ingestion and reconciliation invariants in the root `AGENTS.md`,
including durable validated ingestion before reconciliation, installation and
revision fencing, transactional mirror writes and acknowledgments, bounded
retries, and database-backed idempotency.

Architecture approval does not certify runtime readiness. Execution recovery,
mutation reconciliation, Shopify adapters, and real PostgreSQL integration tests
must be implemented and verified before production use.


## Mirror/query foundation hardening

Keep the existing Prisma snapshot tables and publication pointer. The reviewed
migration, shared app/shop bulk-query coordinator, retention-pin API and bounded
parameterized product compiler are described in
[mirror foundation hardening](../docs/mirror-foundation-hardening.md).
Installation generation and snapshot ID remain distinct. The application database
has not been migrated by the validation workflow. Query adapters and dynamic
metafield permissions remain conservative; scaffolds are not production features.
