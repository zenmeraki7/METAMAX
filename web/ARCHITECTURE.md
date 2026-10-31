# Backend architecture

This is an Express Shopify app foundation. OAuth and authenticated requests use
`@shopify/shopify-app-express`; signed webhooks run before JSON parsing. The
frontend is served after Shopify's installation guard and CSP middleware.

Session storage uses Shopify's official memory adapter for local development.
The Prisma storage contract and its initial migration are documented in
`prisma/README.md`; neither has been deployed to Neon. There is no running catalog mirror, ingestion,
reconciliation, Redis queue, worker or mutation execution engine in this backend.
The remote database remains intact. Retained frontend screens do not make the
removed APIs available; unsupported API paths explicitly return JSON 404.

Replace memory sessions with a persistent official adapter for production.

Application database: Neon Postgres database newmeta_app, project newmeta,
development branch express-backend-20261027. db/postgres.js provides a shared
node-postgres pool using the pooled DATABASE_URL from ignored web/.env.
Startup checks connectivity; shutdown closes the pool. No application tables
have been deployed; `prisma/` contains the initial migration and isolated DDL
tests. Shopify sessions still use memory.

Local Redis runs through the root compose.yaml on 127.0.0.1:6380, with a named
volume and append-only persistence. db/redis.js manages the shared Node client;
development startup connects automatically, and production uses REDIS_URL when
configured. This connection does not add queues or change session storage.

Upstream: Shopify/shopify-app-template-node at
4e73e21a8dd424f1784d916e532103683291cde9 (backend only).
The template's authenticated GET /api/products/count and POST /api/products
sample endpoints are supported. Product creation uses ProductCreateInput for
API 2026-10 and checks userErrors before reporting success. No product creation
occurs at startup; the sample runs only on an authenticated POST request.

Write-domain validation lives in `fields/write-domain.js`. Future bulk-edit,
CSV import, scheduled and recurring edit adapters must use
`normalizeSupportedWrite(fieldId, finalValue, supportedFieldIds, operation)` before preparing
a mutation. Each adapter owns its server-side field allowlist; request bodies
must not supply descriptors, constraints, allowlists or contextual policy rules.
The shared `normalize.js` remains suitable for signed filter operands and reads.

Workers must load current state, compute arithmetic adjustments exactly and
validate the final value, then verify authorization, targeting and the approved
execution contract before writing. If configured by trusted server policy,
`validateVariantPriceState` checks the complete final price/compare-at state.
Authentication, field permissions, mirror readiness and post-write verification
remain separate requirements. No bulk-edit mutation pipeline exists yet, so
these helpers are not currently wired to a write endpoint or worker.

`fields/resolve.js` implements the pure v9 field-resolution contract. Fixed IDs
use canonical definitions; dynamic opaque IDs require injected shop-scoped
metadata resolvers and registered read/write adapters. All returned metadata is
validated before issuing immutable results. Structural capabilities do not
authorize access: authorized entry points require server-owned authorization
and coverage services, an actor and an execution context.

`fields/sources.js` now installs the reviewed canonical source and SQL binding
contract for the Prisma mirror: all 58 canonical descriptors and 27 supported
product/variant scalar mappings. Unsupported families and relation/list fields
have no SQL binding. Dataset registration does not establish availability;
the real catalog verifier rejects the current undeployed mirror tables. See
`../docs/source-registry.md` for the verified live status and deployment gates.
Run all field tests, including mocked source-contract tests,
with `node --experimental-test-module-mocks --test web/fields/*.test.js`.
No database-backed dynamic resolver, authorization service or coverage service
is implemented by this module.

`fields/metafield-adapter.js` validates repository metadata and returns a keyed
`Map<fieldId, resolvedRecord>`. `metafield-resolver-bridge.js` preserves this Map
for the resolver; it must not convert records to positional arrays. The
repository and clock are injected, so the Field Engine performs no queries or
network calls. The adapter checks verification expiry after repository retrieval.
Write workers must revalidate at execution time.

The future `findVerifiedDefinitions({ shopId, fieldIds })` repository must enforce
authenticated shop ownership in every lookup and mutation. Its database table
must enforce `UNIQUE(shopId, fieldId)`, `UNIQUE(shopId, shopifyDefinitionId)`,
`UNIQUE(shopId, locatorId)` and `UNIQUE(shopId, ownerEntity, namespace, key)`.
The adapter also rejects ambiguous bindings within each returned batch; this
does not replace database constraints across lookups. Rotate `definitionToken`
when type, constraints, owner, access, locator or write capability changes. Reconciliation
must verify current Shopify definitions, access restrictions and supported
values; a stored `definitionVerified: true` flag alone is insufficient.

`mirror/coverage.js` supplies shared `verifyCoverage` and `requireCoverage`
entry points for filters, exports, bulk-edit previews, imports and scheduled jobs.
The caller must pin `executionContext.generationId`. The injected
`getPublishedSnapshot({ shopId, generationId, datasets })` repository must read
publication and coverage from a transactionally consistent view after the
publication barrier commits. The service validates shop ownership, publication,
dataset completeness and exact generation membership. It never substitutes the
latest generation for the pinned generation. Unavailable or retired generations
must fail closed; pagination and jobs must retain their pinned generation.

A dataset enum or a verified definition is not evidence that mirror values are
ready. Operation-specific freshness requirements remain the backend's policy.
The mirror snapshot repository, metafield repository, database constraints and
application execution pipelines are not implemented. The coverage service is
ready to inject as the field resolver's `verifyCoverage` callback; tests exercise
that boundary with fixture source contracts, not a production database.

`fields/constraints.js` owns the v3 trusted constraint registry. Read
representation, filter operands and outgoing writes have separate policies;
write-only restrictions must not be applied to existing mirror values.
Canonical policies are validated and frozen at module initialization.

Future execution services must validate the incoming operand with
`normalizeWriteOperand`, compute the final value exactly, and call
`validateFinalWriteValue` before adapter-specific write-domain checks.
`getFieldClearResult` supplies the structural CLEAR result. Arithmetic operands
and multipliers have distinct precision contracts; a valid operand does not
prove the computed result is valid. Structural operations never grant mutation
permission or establish adapter support, authorization or approval.

`write-domain.js` v2 delegates operation and final-value validation to this
registry. It retains contextual price/compare-at checks and exact comparison;
currency interpretation belongs to the trusted Shopify mutation adapter.
`normalizeWriteValue(fieldId, finalValue, { operation })` defaults to SET.
Relative operations must supply their actual operation. Adapter field allowlists
remain mandatory and are independent of the shared field policies.

The metafield adapter v2 accepts optional server-owned `constraints` with
`read`, `filter` and `write` entries from verified repository metadata. It validates
these through `createDynamicFieldPolicy` and returns an immutable `policy`
bound to shop, field and `definitionToken`, plus `verification` containing the
definition GID and verification timestamps. The bridge preserves the complete
record and rejects ownership or binding changes.

Dynamic resolver records must now include this policy envelope. The resolver
revalidates it against the independently resolved definition and source token
before attaching it. Canonical policies come exclusively from the registry.
`getResolvedFieldPolicy(resolved, context, { shopId })` retrieves trusted metadata
only after provenance and ownership checks. Neither attachment nor lookup
grants authorization or proves published coverage. Separate server-owned
authorization and coverage callbacks remain mandatory.

An injected dynamic policy service can also use `resolveDynamicFieldPolicy`;
its returned envelope is revalidated rather than trusting `verified: true`
alone. Browser callbacks and policy metadata must never be forwarded as trusted
services or constraints. This adds no database-backed policy repository or
execution pipeline.

Execution consumers must use the server-configured `createFieldService({
adapter, resolveShop, authorizeAccess, verifyCoverage })` boundary. Configure
`verifyCoverage` with `mirrorCoverage.getVerifiedCoverage`, not its boolean
`verifyCoverage` method. Requests cannot override dependencies or provide shop
or actor identity. The backend supplies authenticated `authContext`, the
operation and the approved `executionContext`; the browser supplies field IDs
only through a validated controller request.

`requireFields({ authContext, fieldIds, access, operation, executionContext })`
and `requireField({ authContext, fieldId, access, operation, executionContext })`
return an immutable contract containing shop, operation ID, fields, datasets,
generation, coverage revision and dynamic definition tokens. Field batches are
nonempty, dense, deduplicated and bounded. Dependencies cannot be supplied per
call. All fields must pass authorization before coverage is checked or a
contract is returned. Low-level metadata and legacy `require*ForAccess` exports
remain available for internal compatibility; they are not the execution boundary.

Coverage receipts require a repository-owned `coverageRevision` in the same
committed snapshot used to verify publication and completeness. The repository
must maintain that revision when coverage metadata changes. Existing boolean
coverage checks remain supported. The service requires a pinned generation and
rejects a receipt for any other generation; an optional pinned coverage revision
must also match. These contracts do not replace execution-time authorization,
definition revalidation, or generation retention in the eventual worker.

Definition tokens are enforced, not merely returned. After fresh resolution,
the field service compares every dynamic field against the server-owned approved
preview's `executionContext.expectedDefinitionRevisions` array of
`{ fieldId, definitionToken }`. The identities must match the complete dynamic
field set exactly, without duplicates or extras; order does not matter. Missing
or changed tokens fail before authorization and coverage. This pin is mandatory
for dynamic writes and non-filter execution, including exports and scheduled
operations. When supplied for filtering, it is enforced there too.

Initial previews explicitly use `executionContext.phase: "preview"` and return
a preview contract. Execute calls default to `phase: "execute"` and must use
the revisions loaded from the stored approved preview, never freshly resolved
tokens or browser data. Both phases still require authentication, authorization
and coverage. Authorization must validate the phase and approved operation;
workers must accept only execute contracts and perform fresh resolution at
execution time. Canonical-only operations have no dynamic revision dependency.

Coverage must also be compatible with the approved targeting snapshot.
Execution contexts carry server-loaded `approvedTargetingSnapshot` metadata:
`{ snapshotId, shopId, generationId, coverageRevision }`. It is mandatory for
writes and non-filter execution, including canonical-only operations; initial
previews can obtain coverage without an approved target. Filtering checks any
supplied targeting pin as well. Neither generation nor revision may switch.

When a target is pinned, `getPublishedSnapshot` receives `targetingSnapshotId`
and must return its stored `targetingSnapshot` record in the same consistent
view as publication and dataset coverage. The record includes `id`, `shopId`,
`generationId`, `coverageRevision`, `status: "APPROVED"` and dataset dependencies.
The coverage service verifies ownership, approval, exact generation/revision,
and that the approved target covers every requested dataset, in addition to
published/complete coverage for those datasets. Missing, revoked or incompatible
targeting records fail closed. The receipt includes `targetingSnapshotId`, which
the field service checks and carries into the immutable execution contract.

The repository must load stored approval metadata, not manufacture it by echoing
the expected request values. Its transactional implementation and the actual
stored selection are still application dependencies. The field service's trusted
coverage callback must use this implementation or enforce equivalent checks;
an arbitrary function returning `ready: true` is not evidence of publication.

`filters/ast.js` provides structural parsing, immutable inspection and cached
serialization for v1 filter ASTs. It checks dense own-data input, JSON operands,
opaque field-ID syntax, tree limits and byte budgets, including empty-container
overhead and escaped JSON. Its private provenance establishes structural
validation only. The compiler must never treat a parsed AST as authority to
run a query; field/operator semantics, authorization and coverage belong to
later stages. `filters/validate.js` exports no standalone validation function.
Its server-only `createFilterService({ fieldService })`
accepts only a genuine authorized field service, checks operators and operands
after authorized resolution, and issues immutable filters using private
per-service provenance. No brand issuer is exposed. Each filter binds its shop,
operation and operation ID, generation, coverage revision, targeting snapshot
and trusted registry version. Copies and serialized filters lose provenance.

`compileFilter(validated, { authContext })` verifies private provenance and calls
`fieldService.revalidateResolution` before private SQL generation. It returns
`{ kind: "where", text, values, binding }`, a scoped PostgreSQL WHERE fragment,
not a complete executable query. `compile.js` now supplies a separately configured,
physically verified complete-query service with optional authenticated keysets.
No raw compiler or brand issuer is exported. `execute.js`
currently supplies a page-size validator only, not database query execution.
`npm run test:filters` runs the
filter tests, which are also included in the combined backend test command.

The field service fingerprints actual trusted canonical definitions, source
mappings, policies and contract version, plus the resolved field/source/policy
set, with SHA-256. Its `registryVersion` is not a browser-supplied version label.
Approvals can pin it using `executionContext.expectedRegistryVersion`.
Revalidation always pins the version from the original issued resolution along
with definition tokens, coverage revision, original operation and generation.
Locator or policy drift is rejected even without definition-token rotation.

`revalidateResolution` accepts only contracts issued by that exact field service.
It checks authenticated shop again, re-reads definitions, and re-runs authorization
and actual coverage checks. Retired, incomplete, replaced or revoked snapshots
prevent compilation. Future SQL/execution code must additionally retain the
checked generation through a repository transaction or retention lease; these
guards do not themselves create database locks or generation retention.

SQL compilation requires explicit canonical `FIELD_SOURCES[fieldId].sql`
metadata: `{ kind: "column", alias, column, storageType, shopColumn,
generationColumn }`. All identifiers must be ASCII identifiers of at most 63
characters; they are double-quoted individually. Arbitrary expressions, custom
casts and dynamic field SQL are unsupported. Storage types come from a fixed
canonical-type allowlist (`text`, `boolean`, `bigint`, `numeric`, `date`,
`timestamptz`, `text[]`, `jsonb`). Scope columns must identify text shop and
generation IDs; each alias is guarded outside all user AND/OR/NOT expressions.
Conflicting scope definitions for the same alias are rejected.

Every operand, shop ID and generation ID is a separate typed positional
parameter. Operator strings are fixed compiler tokens. Text matching uses
case-insensitive ILIKE with escaped literal percent, underscore and backslash
characters; pattern data stays in parameters. Operator compatibility and operand
normalization are repeated at compilation. SQL is bounded to 500 parameters
and 131,072 UTF-8 bytes. Parameterized output and quoted identifiers do not
replace the future executor's trusted FROM/JOIN plan and generation lease.
Production SQL mappings remain unimplemented and are never inferred from IDs;
compiler tests use explicit source-registry fixtures, not a live database.

NULL semantics are versioned in `filters/semantics.js`. Negative operators
(`neq`, `not_in`, `not_contains`, `list_not_contains`) exclude NULL by preserving
PostgreSQL UNKNOWN. Logical NOT of UNKNOWN stays UNKNOWN. Do not add `OR column
IS NULL`, null-safe inequality or coalesce a leaf to false; the latter would
make NOT include null values. Explicit `is_null`/`is_not_null` handle nullness;
empty strings and empty lists are separate values. Null operands and null set
members are rejected. A row can still match an OR group through another true
branch. Array membership retains native PostgreSQL ANY semantics, including
UNKNOWN for a null array or null elements without a matching value.

Authorization is re-run for every semantic validation and compilation; AST and
fingerprint caches must never cache permission grants. Validated filters and
compiled bindings retain their original operation and shop. Callers cannot
override those bindings while compiling; another operation requires fresh
authorized validation. The future executor must enforce the compiled operation
binding rather than repurposing a query for another operation.

`filters/serialization.js` defines versioned canonical object-key ordering after
structural parsing. Group children and operand arrays keep their order; exact
decimal strings and missing/null distinctions are preserved. It does not claim
logical equivalence. `serializeFilterAst` remains the legacy structural serializer.
`filters/fingerprint.js` applies domain-separated SHA-256 to canonical data.
`fingerprintFilter` identifies structure only; `fingerprintBoundFilter` also
includes shop, operation and operation ID, generation, coverage revision,
targeting snapshot, registry fingerprint and NULL-semantics version. Configured
validation emits the bound `fingerprint`, which is copied into compiled bindings.
Neither function mints private validation provenance or authorization.

Structural and execution budgets are independent. AST parsing retains 1,000
nodes and depth 32 for saved views and programmatic workflows. It rejects
unpaired Unicode surrogates in string values, object keys and identifiers, and
rejects numeric negative zero (including nested values) rather than rewriting it.
Exact serialized JSON byte accounting and existing structural caches remain.
The shared `isSupportedFieldId` keeps the legacy canonical syntax/length behavior
and the central dynamic pattern; the separate general `isValidFieldId` API still
supports structural IDs up to 160 bytes. Neither checks field existence.

`FILTER_EXECUTION_LIMITS` in `validate.js` limits executable conditions to 100,
depth to 12, and total OR fan-out to 32. Fan-out is the sum of child counts over
every OR group, including nested groups. These checks run before authorized
resolution and again before SQL generation. The compiler counts actual emitted
parameters, including shop/generation, and caps them at 500. Its returned plan
reports parameters, correlated subqueries and estimated binding cost. Product
columns use the parent row; variant conjunctions share one correlated EXISTS.
The compiler enforces the 16-subquery cap as it emits scopes. `normalizePageSize`
defaults to 50 and accepts positive integers up to 100 at the execution boundary.

`filters/bindings.js` is the sole allowlist for compiler-enabled fields. Its
constructor is private, provenance uses a private WeakSet, and exact lookup
uses a Map. `getFilterBindingRegistry()` accepts no arguments and reads trusted
`FILTER_BINDING_DEFINITIONS` and `FILTER_SQL_SCHEMA` exports from the source
module. Bootstrap initializes it once after verified source configuration.
Neither registry lookup nor `requireBinding` exposes raw compiler functions.
Only built-in `product_column_v1` and `variant_exists_v1` handler IDs are accepted.

Definitions declare field ID, entity, source kind, ordered datasets, correlation,
handler ID, operator IDs, fixed cost, mirror schema version and source contract
version. Source kind must be column. Malformed arrays, accessors, functions,
duplicates and unsupported capabilities fail closed. Dataset order must exactly
match the canonical source dependencies. Variant dependencies cover both products
and variants. Dynamic metafield SQL remains disabled.

The schema contract declares both compatibility versions, a product scope
(`alias`, `shopColumn`, `generationColumn`, `idColumn`) and variant scope
(`schema`, `table`, `alias`, `shopColumn`, `generationColumn`, `productIdColumn`).
Coverage receipts carry actual published `mirrorSchemaVersion` and
`sourceContractVersion`. Compilation rejects absent or incompatible versions,
and revalidation rejects version drift. These bootstrap definitions also
participate in the trusted mapping fingerprint.

Positive conjunctions are flattened before combining all variant requirements
under one EXISTS with shop, generation and product-ID correlation. Variant SKU
and price cannot match different rows. Variant-only AND/OR subtrees share that
scope. Mixed product/variant OR and variant NOT require explicit future scope
or quantifier contracts and currently fail closed. Registry provenance is not
SQL verification: production bindings/version manifests must be tested against
the real mirror schema before installation. This change installs no production
binding definitions.

Fingerprint format v2 separates `fingerprintFilterAst` from
`fingerprintFilterExecution`. AST fingerprints use canonical object-key
serialization after normalization while preserving logical/array order. Execution
identity adds the authorized operation and optional operation ID, shop (including
dotted shop domains), generation, coverage revision, concrete registry fingerprint,
targeting ID, mirror/source versions and validation/AST/canonical/operator/binding
contract versions. The AST version must equal the parsed AST's actual version.

Execution revisions must match exactly the AST's distinct supported dynamic
field IDs. Revision arrays are bounded to 1,000 and reject holes, accessors,
custom properties, duplicate IDs and extra entry keys. Field IDs use the shared
dynamic validator. Revisions and resolved mappings use ordinal ASCII ordering,
not locale-dependent comparison. These checks do not prove tokens are current:
the authorized resolution and live revalidation supply that guarantee.

Configured validation constructs execution identity explicitly from issued
server resolution and module contract constants, never request-supplied shop,
version or revision fields. The hashing helper itself is pure format validation
and cannot authenticate metadata. Compatibility names `fingerprintFilter` and
`fingerprintBoundFilter` now produce v2 identities; regenerate stored v1 hashes.
Signed client pagination state requires a separate HMAC service binding execution
fingerprint, cursor position and expiry. SHA-256 content identity alone does not
protect client-carried state, and no signed cursor endpoint is implemented yet.

Semantic validation contract v2 additionally asserts that each resolution was
issued by the configured Field Service instance, before normalization and after
live revalidation. The assertion cannot issue provenance or authorize access.
Resolved fields must retain private Field Engine provenance and canonical fields
must retain exact immutable registry identity. Dataset dependencies are compared
as exact sets with duplicate entries rejected; actual published completeness is
still verified by the coverage service. An explicitly null operation is invalid,
while an omitted operation defaults to read-only filtering. Validation contract
version changes invalidate previously computed execution fingerprints.

The validator keeps a separate frozen compiler snapshot with independently owned
field records, field/dataset arrays and definition revision entries. The original
issued resolution is retained only for fresh authorization and coverage checks;
compilation reads its verified snapshot after those checks succeed. Sources,
canonical definitions and policies referenced by the snapshot are deeply frozen
by the genuine Field Service. No request-supplied service can supply these records.

Identity contracts have different purposes:
- AST fingerprints identify normalized expression content for structural caches.
- Execution fingerprints identify shop, operation, operation ID, approved targeting
  snapshot, exact generation/coverage and registry/definition contracts for plan
  correlation and approved-preview comparison. They are not actor authorization
  identities. Privileges are checked against the current authenticated context on
  every validation and compilation, even when two actors produce the same hash.
- A bulk-edit executor must bind its approved action payload, selection and actor
  policy to its own immutable execution contract and reauthorize before execution.
  The filter fingerprint covers targeting, not the full write payload. That
  executor and its approval/actor identity contract are not implemented here.

The private predicate compiler enforces emitted SQL parameters incrementally and
at completion, including shop/generation predicates, and counts actual correlated
subqueries. Handler operator allowlists are checked independently of field type
compatibility. Predicate compilation remains private inside `validate.js`;
`compile.js` wraps a configured service with physical verification rather than
exporting a raw AST compiler. A future
full-query executor must include its additional pagination/query parameters in
the same budget. Definition tokens use the shared 16–256 character contract in
the adapter, resolver and execution fingerprint helper.

Integration tests exercise authorization callbacks and real published-coverage
validation against fixture repositories. They do not prove production Shopify
scope enforcement: the actual authenticated authorization service, transactional
mirror repository and bulk execution service still need application wiring.
Infrastructure exceptions propagate separately from malformed-filter FieldError
failures; HTTP consumers must map those failures to their distinct response
contracts without exposing internal details.

Semantic validation contract v3 runs the private SQL compiler as a preflight
after authorized field resolution and operand normalization, before issuing
validated provenance. This executes no SQL. Missing bindings, unsupported handler
operators, incompatible schemas/mappings, ambiguous correlations and emitted SQL
budgets now fail validation itself. Compilation repeats these checks after live
revalidation; it never treats the preflight as a lasting authorization grant.
Without installed production bindings, configured validation fails closed.
Dynamic fields likewise remain unavailable to the SQL Filter Engine until their
verified bindings and handlers exist, even when the Field Engine resolves them.

Correlation grouping uses verified binding correlation metadata, never a field
identifier prefix. Operator normalization explicitly handles NONE, SCALAR,
ELEMENT, SET and PAIR and rejects unknown shapes; exact decimal operands remain
strings in scalar/set/range forms. Privately issued Field Service resolutions
have frozen validated arrays; sparse/accessor-backed replacement contracts fail
provenance checks before their elements are read. Execution fingerprint revision
entries already require exact own data-property keys, rejecting getters and
additional metadata. AST node reuse is deferred until profiling warrants it;
all semantic checks continue to run for each condition.

Resolution contract v10 / adapter v3 now distinguish stable Shopify definition
identity (`definitionId`) from repository-controlled revision
(`definitionRevision`). Approved revision comparison and fingerprints use the
latter; metadata fingerprints also bind source/policy contents. Repository
ingestion must rotate revisions when relevant metadata or capabilities change.
The legacy `definitionToken` name remains only on revision entries/policy and
verification records, never as the stable source identity.

Fingerprint v3 / semantic validation v4 include explicit normalization and
constraints versions and phase/approval identities. Mutable execution requires
the server bootstrap's `verifyExecutionContext` callback to read persisted
operation approval and return an exact bound receipt, with immutable execution
contract ID and approval revision. Missing callbacks fail closed; revalidation
re-reads approval and rejects changed/revoked contracts. The pure engine does not
implement this repository or a bulk job executor. See the integration guide for
the receipt and operation-specific preview/execute requirements.

Private validated state captures a field-ID Map once for constant-time compiler
lookups. `filters/errors.js` distinguishes malformed input, permissions, missing
coverage, internal contracts and known transient infrastructure failures using
stable safe response codes without exposing error messages/causes. It is a pure
classification helper; HTTP consumers must call it at their response boundary.

Adversarial regressions additionally exercise forged service implementations
with inconsistent fields, sparse/accessor-backed response arrays and replaced
methods; private service provenance rejects them before invocation. Bulk targeting
tests revoke persisted approval, rotate approval revisions, revoke operation
rights and attempt operation switching after validation. Definition revision and
published compiler schema drift are also rejected after contract issuance.
Missing compiler bootstrap configuration is an internal contract failure,
distinct from a merchant choosing an unsupported field/operator combination.

The stable server-only Filter Engine entry point is now `filters/index.js`.
It exports structural parsing helpers, `createFilterService`, fingerprints,
contract constants and safe failure classification, without binding internals
or compiler/brand accessors. `services/filter-engine.server.js` supplies an
optional server-bootstrap facade around a genuine Field Service and an injected
authenticated session service. Both validation and compilation authenticate
afresh and match the independent session shop to the resolution/plan's shop.
The facade accepts no binding definitions, SQL handlers or request dependencies.
Production authentication and registry installation remain application work.

`filters/mirror-schema.js` provides the requested server-only structural schema
contract via explicit internal imports. It snapshots exact own-data table/column
mappings, rejects accessor/symbol/extra keys and identity-column collisions,
checks allowlisted identifiers against a 63-byte UTF-8 budget, freezes records
and asserts private factory provenance. Optional explicit `schema` mappings and
`quoteQualifiedTable` support independently quoted PostgreSQL namespaces.

This factory is not exported from `filters/index.js` and does not install or
enable compiler bindings. Structural callers retain the supplied unqualified
mapping shape; production table references must provide a verified namespace.
No database verification is implied by its WeakSet. Complete query compilation
requires the separate catalog capability below. Existing compiler publication/
version guards remain mandatory; no production SQL mappings are fabricated.

`services/mirror-schema.server.js` issues a separate private capability only after
parameterized PostgreSQL catalog reads in a repeatable-read, read-only transaction.
It requires explicit namespaces, real base/partitioned tables, compatible nonnull
identity types/collations, a valid immediate scoped unique product index and a
valid scoped variant correlation B-tree index. It reads the database identifier
limit and captures OIDs/column types/typmods/index metadata in a fingerprint.
Catalog evidence is re-read before complete query compilation to reject drift.
Catalog checks use PostgreSQL's documented [attribute metadata](https://www.postgresql.org/docs/current/catalog-pg-attribute.html)
and [index validity/key metadata](https://www.postgresql.org/docs/current/catalog-pg-index.html).

`compile.js` exposes `createFilterCompiler({ fieldService, physicalSchema })`
through explicit server imports. Each instance owns its validation provenance.
`compileFilter` accepts only its own issued contracts and authenticated context,
with an optional bounded `pageSize`. It revalidates physical schema, field
authorization, approved operation state and published generation; checks each
used field column against the correct verified table/type; then emits a fully
qualified, bounded SELECT of product IDs. Text IDs use explicit C
ordering; bigint/UUID IDs use native ordering. Shop and generation come solely
from the authorized resolution, never `expectedShopId` caller overrides.

All emitted operands must be normalized supported scalar primitives, including
the final LIMIT parameter. Objects, nested arrays, null operands, Dates, driver
serialization hooks and unsupported casts fail closed. IN/range operands expand
to separate typed scalar placeholders. Predicate and complete-query parameter
budgets are both enforced on final emitted values.

This is still compilation, not production query execution. Cursor input requires
the configured HMAC service and ordering/snapshot binding described below.
`execute.js` provides `createFilterExecutor` through explicit server-owned
dependencies: a PostgreSQL pool, an authenticated shop resolver, the compiler
that owns the query, and a transaction-aware publication service. It accepts
only compiler-issued queries bound to the authenticated shop, starts a read-only
repeatable-read transaction, applies transaction-local statement and lock
timeouts, checks publication, executes the bounded product-ID query, and returns
immutable IDs with an optional signed cursor. Failures roll back and release the
client; infrastructure errors retain their server-side cause.

`mirror/publication-service.server.js` implements protection with a configured
existing barrier relation: readers take ACCESS SHARE before their first SELECT,
and every publisher, coverage/mirror writer and reclaimer must take ACCESS
EXCLUSIVE through `lockForWrite` before reading or changing protected state.
Both locks last through transaction completion. The barrier is coarse across
tenants. Timeout setup uses SET LOCAL so it does not freeze an earlier snapshot.
The service checks tenant, generation, revision and complete coverage on the
executor's client using the transaction-aware snapshot repository. No production
barrier relation, physical source mappings or publication repository is invented.

`controllers/filters.controller.js` provides the injected `createFiltersController`
HTTP adapter. It authenticates before planning, accepts only `filter`, `pageSize`
and an optional opaque `cursor`, bounds serialized body size, and sends private,
non-cacheable responses with sanitized failures. The new server-owned
`resolveDatasets({ authContext, filter })` adapter resolves the execution context
from authenticated server state. It provides no coverage authority. Compilation
stores an immutable dependency plan derived from validated bindings in the issuing
compiler's private query map. Execution checks exact compiler ownership before
connecting and obtains coverage only from that private plan, bound to the exact
shop, generation and revision. `createFilterHttpRuntime` in
`services/filter-engine.server.js` implements the context adapter. It also
initializes the compiler, executor, session authentication and publication service
after physical schema verification. Pass the result as `filterRuntime` to
`createApp`. `/api/filters/search` is registered after Shopify authentication;
without a configured runtime it returns 503. Production configuration still
requires real source mappings, repositories, an authorized field service factory,
a coordinated writer barrier and a persistent cursor secret. Actual production
publication writers are absent; their participation in the reader/writer protocol
is a release blocker. Unreferenced zero-byte filter scaffolding has been removed;
no API was inferred from a placeholder filename. See
`../docs/filter-executor.md` for the full integration contract.

Scoped shop/generation columns initially require physical text
storage, identities support text/bigint/UUID, and constrained numeric typmods
fail closed pending explicit precision/scale compatibility. Tests cover catalog
fixtures and disposable PostgreSQL; the application's Neon schema is not inspected
or mutated by these tests.

Compiler v2 requires explicit canonical field approvals during catalog bootstrap:
`fieldMappings: [{ fieldId, entity, column, type }]`. The verifier checks the
canonical type/entity and actual physical column, and snapshots approvals with
the catalog table OID/attribute numbers in the physical schema fingerprint.
The complete-query factory matches installed trusted source mappings against
these exact approvals. Compilation consumes/checks that approved mapping rather
than accepting an arbitrary safe identifier or any same-typed existing column.
Only approved field IDs can receive this compiler instance's contracts.

`pagination.js` supplies the server-configured HMAC-SHA256 cursor service with
a captured minimum 32-byte secret, constant-time signature checking, bounded
token size/lifetime and strict own-data payloads. The compiler issues cursors
only for its own query objects and verifies opaque tokens internally, binding
execution fingerprint, shop, generation, schema fingerprint, ID type, ordering,
position and expiry. Caller-supplied decoded positions and execution identities
remain prohibited. Cursor creation is a backend operation using actual result
IDs, never a merchant-facing signature oracle.

Text keyset comparison and ordering both use schema-qualified `pg_catalog.C`,
with a matching verified scoped B-tree index. UUID and bigint keysets use native
types; bigint positions are canonical signed-64-bit strings, preserving exact
values. The complete parameter budget includes cursor and LIMIT values and
permits only validated scalar representations. No cursor grants authorization,
extends a publication lease, or enables production query execution by itself.
