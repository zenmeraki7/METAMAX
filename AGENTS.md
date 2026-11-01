# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Backend Interface Contracts

Every new or changed backend interface must declare its input schema, output schema, authority requirements, lifecycle preconditions and durable side effects. Interfaces that participate in Shopify mutations must also declare retry and uncertain-outcome behavior, including what happens when a database commit response or remote response is lost.

Keep the declaration beside its owning interface or link it to a method-specific record in [the backend contract standard](docs/backend-interface-contracts.md). Document where each requirement is enforced; metadata, forwarded coordinates and queue messages are not authority grants. Include transaction ownership, fencing, terminal-state meaning and sensitive outputs when relevant.

Preserve module ownership and existing names unless a behavioral change requires otherwise. Contract consistency does not require centralizing helpers. When a contract changes, update its consumers and relevant adversarial tests together. Prioritize lifecycle semantics, finalization scope, authority and publication fencing over cosmetic consistency. Report unavailable database/concurrency checks explicitly; unit tests do not certify them.

## Ingestion & Reconciliation Invariants

One necessary prerequisite remains: the importer must have finished its database writes before the run transitions to RECONCILING. `processedLines === expectedLines` is only a valid completeness check if those counts represent durable, validated ingestion—not merely lines read from JSONL.

### Revision-Safe Worker Completion

A worker must never clear `dirty` just because its Shopify request succeeded. For example, if it starts reconciling revision 10 and another webhook creates revision 11, the first worker must not acknowledge revision 11.

The worker should apply its mirror writes and acknowledge its observed revision inside one database transaction, using a conditional update:
- Match `where: { shop, productId, revision, appliedRevision: { lt: revision } }`.
- Set `data: { appliedRevision: revision, dirty: false, nextAttemptAt: null, lastError: null }`.
- If `applied.count !== 1`, a newer webhook or another successful worker superseded this result; do not write the mirror.
- Persist the reconciled mirror state (including handling deleted products) using the same transaction so any failure rolls back the acknowledgment.
- Handle retryable database conflicts such as Prisma P2002 and P2034.

### Reconciliation Worker Invariants

The reconciliation worker must enforce four invariants:
1. **Read the latest revision from Neon**: A queued revision is a scheduling token, not authoritative product state.
2. **Do not process clean rows**: A redundant queued job should return quickly without making external requests.
3. **Fence concurrent writes**: A worker processing an older revision must not overwrite a newer reconciliation or bulk snapshot.
4. **Persist failure and retry eligibility**: The scanner should enqueue only due dirty rows, with bounded retry/backoff behavior.

*Idempotency requirement*: Deterministic job IDs prevent duplicate scheduling only while the job exists. Once completed or failed jobs are removed, another enqueue can create the same ID again. Therefore, the database and workers must provide idempotency, not BullMQ alone.

## Filtering, Selection & Long-Running Job Invariants

1. Never accept raw SQL, database column names, or arbitrary field paths from the browser.
2. Resolve every field through the trusted field registry.
3. Check operators against the resolved field type.
4. Enforce shop isolation in every database query.
5. Require coverage verification before filtering against mirror datasets.
6. Use parameterized SQL and bounded query complexity.
7. Resolve all-matching product selections server-side, with exclusions.
8. Freeze the selection and execution contract for bulk edits, exports, and scheduled operations as appropriate.
9. Preserve a consistent published mirror generation during pagination and job execution.
10. Support cancellation, durable retries, and recovery for long-running jobs.
11. The compiler must never accept a structurally parsed AST as sufficient authority to run a query.
12. Do not export a validated-filter brand issuer. Enable branding only after every semantic validation stage succeeds; keep compilation private behind validation or use a restricted internal compiler capability.
13. Bind validated filters to the authenticated shop, operation, pinned generation and coverage revision, approved targeting snapshot, and trusted field-mapping registry version.
14. Immediately before compilation, revalidate authorization, live published coverage, definition revisions and mapping versions; never rely solely on a previously returned readiness flag.
15. Never cache or reuse an authorization grant across shops or operations. Filter fingerprints and structural/provenance caches are not permission grants.
16. Preserve SQL three-valued NULL logic for negative predicates and logical NOT; canonical serialization and fingerprinting are separate contracts from AST parsing.
17. No filter query may execute against an unverified tenant scope, unverified physical schema, or unpublished mirror generation.
18. The most important guarantee for METAMAX is that a query which selects products for a bulk edit must be evaluated against the same authorized shop, verified field mappings, and consistent target snapshot used to approve the operation.

## Field Engine Architecture

The Field Engine is a pure module. It must not perform Prisma queries, Shopify API calls, SQL execution, or HTTP handling.

- `fields/` owns field identities, types, source definitions, value normalization, and field-level constraints.
- Fixed fields always resolve from the canonical registry; browser-provided definitions cannot override them.
- Dynamic fields require a trusted, shop-scoped resolver supplied by the application backend.
- Dynamic metafield metadata is not automatically trusted merely because a resolver returned it.
- Read/write capability metadata is not treated as actual authorization.
- Normalization constraints are not a complete authorization mechanism. The bulk-edit execution service must still require a trusted resolved field, an approved write operation, an immutable execution contract, and current authorization.
- No fabricated source mapping is created for dynamic fields.

The dynamic-field interface is a proposed backend contract. The current backend does not yet implement the database-backed resolver.

## Critical Security Rules

1. Never construct SQL identifiers from browser input. Column names, table names, operators, and joins must come from trusted server-owned registries.
2. Resolve dynamic metafields using authenticated shopId and an opaque field ID.
3. Reject fields without verified physical SQL bindings or complete mirror dataset coverage.
4. Compile only structurally and semantically validated ASTs.
5. Use SQL parameters for values, never string interpolation.
6. Bind every query to the authenticated shop and exact mirror generation.
7. Ensure the executor accepts only compiler-issued queries, with no raw SQL execution path.
8. Fail closed when registry versions, physical schemas, publication revisions, or required scopes are incompatible.
