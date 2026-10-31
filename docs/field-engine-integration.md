# Field Engine integration

Import supported interfaces from `web/fields/index.js`. Raw adapters, metadata
resolvers and source mappings require explicit server-only imports. Pure
normalizers require trusted descriptors and constraints; controllers must accept
field IDs and validated values rather than browser-defined field objects.

Create the field service once in the backend composition root. The following
dependencies must be supplied by the application; they are not implemented by
the Field Engine:

- `trustedMetafieldRepository` supplies verified, shop-scoped definitions.
- `fieldAuthorizationService` checks authentication, scopes, operation rights
  and approved execution contracts.
- `mirrorCoverageService` validates a committed snapshot and issues coverage
  receipts through `getVerifiedCoverage`.

```javascript
import { createFieldService, FIELD_ACCESS } from "./fields/index.js";
import { createMetafieldAdapter } from "./fields/metafield-adapter.js";

// Run once at server initialization with server-owned dependencies.
const metafieldAdapter = createMetafieldAdapter({
  repository: trustedMetafieldRepository,
});

export const fieldService = createFieldService({
  adapter: metafieldAdapter,
  // authContext is issued by verified session middleware, never the browser.
  resolveShop: async authContext => authContext.authenticatedShopId,
  authorizeAccess: context => fieldAuthorizationService.authorize(context),
  verifyCoverage: context => mirrorCoverageService.getVerifiedCoverage(context),
  verifyExecutionContext: context => executionApprovalRepository.verify(context),
});
```

Use this configured instance from the filtering service. The backend supplies
`verifiedAuthContext` and `approvedExecutionContext`; the latter must contain
an `operationId` and pinned `generationId`, and may also pin `coverageRevision`.

```javascript
const resolution = await fieldService.requireFields({
  authContext: verifiedAuthContext,
  fieldIds: ["product.vendor", "variant.price"],
  access: FIELD_ACCESS.READ,
  operation: "filter",
  executionContext: approvedExecutionContext,
});

const { fields, generationId, coverageRevision } = resolution;
// Pass the complete authorized resolution to the trusted filter compiler.
```

The coverage callback must return a verified receipt containing `ready: true`,
`generationId` and `coverageRevision`. The existing boolean coverage method
cannot supply that contract. Retain the pinned generation through pagination
and execution. The canonical source registry, production repositories,
authorization service and filter compiler still require application integration.

For an initial bulk-edit or export preview, set the server-owned execution
context's `phase` to `"preview"`. Store the returned `definitionRevisions` with
the approved preview. At apply time, load that stored revision array as
`executionContext.expectedDefinitionRevisions` and use `phase: "execute"`
(the default). The service resolves current definitions again and rejects a
missing, changed, duplicate, partial or extra expected revision before returning
an execution contract. Dynamic writes and non-filter execution require this
pin; filtering also checks it whenever supplied.

Do not copy the latest revision into the expected array at apply time. The
expected values belong to the approved preview. Preview contracts are marked
`phase: "preview"` and must not be accepted by mutation workers. The trusted
authorization service must validate the requested phase and approval context.

Apply contexts must also carry `approvedTargetingSnapshot` loaded from the
stored approval: `{ snapshotId, shopId, generationId, coverageRevision }`.
This applies to canonical-only writes and exports too. The coverage repository
receives `targetingSnapshotId` and must join its stored approved targeting record
with publication/coverage metadata in one consistent database view. The service
verifies approval, shop ownership, dataset dependencies and exact generation and
revision compatibility before issuing a receipt containing `targetingSnapshotId`.
Do not echo request metadata as proof of approval or return `ready: true` without
performing these checks. The returned targeting ID identifies the stored
selection that the eventual execution worker must use.

`executionApprovalRepository` is a required application dependency for mutable
execution (`bulk_edit`, `scheduled_edit`, `recurring_edit`, `import`, `undo`, or
any write access). Read its persisted operation/approval state on every call;
check actor privileges, approval status/expiry, operation kind, shop, operation ID,
generation and targeting snapshot. Return an own-data receipt with exactly:
`{ approved: true, shopId, operation, operationId, generationId,
targetingSnapshotId, executionContractId, approvalRevision }`. The last two values
identify the immutable approved action payload and its current revision. Never
echo request context as verification. Boolean receipts and mismatched bindings
fail closed. Missing verifier configuration blocks mutable execution. Preview
can run without an execution approval but cannot authorize a mutation.

Fresh compilation re-reads this approval and rejects revocation or a changed
contract/revision. A job executor must perform the same check immediately before
each authorized execution boundary, preserve idempotency, and reject preview
contracts; no bulk job executor or persisted approval repository is supplied here.

Adapter v3 and resolution contract v10 separate `source.definitionId` (stable
Shopify MetafieldDefinition GID) from `source.definitionRevision` (the verified
repository's `definitionToken`). The repository must rotate that server-owned
revision whenever relevant type, validation, storage or supported capability
metadata changes. `definitionRevisions[].definitionToken` retains its existing
wire name but now comes exclusively from `definitionRevision`. The bridge checks
both identity and revision against verification metadata. Regenerate older
source records; token-as-definition-ID records are rejected.

Fingerprint format v3 and semantic validation v4 include normalization and
constraint policy versions, phase, execution contract ID and approval revision.
Regenerate stored v2 execution fingerprints. HTTP consumers can use
`filters/errors.js` to obtain safe status/code/retryability metadata; log the
original cause separately. Wrap known transient adapter failures with
`FilterInfrastructureError`; unexpected errors remain internal failures, never
merchant input errors. HTTP filter endpoints remain application integration work.

## Server Filter Engine entry point

`filters/index.js` is the supported server-only entry point for structural AST
helpers, `createFilterService`, versioned fingerprint helpers and safe failure
classification. It exports no binding constructors/accessors, raw compiler or
validated-filter issuer. Examples based on `createFilterValidator`,
`FilterValidationError` and exported validated-binding accessors describe an
older contract and must be adapted to these supported interfaces.

Applications can create a session-checked facade once at server initialization:

```javascript
import { createFilterEngine } from "./services/filter-engine.server.js";

const filterEngine = createFilterEngine({
  fieldService,
  authenticatedSessionService, // requireAuthenticatedShop(authContext) -> { shopId }
});
const validated = await filterEngine.validateFilter(input, {
  authContext: verifiedAuthContext,
  operation: "filter",
  executionContext: approvedExecutionContext,
});
const predicate = await filterEngine.compileFilter(validated, {
  authContext: verifiedAuthContext,
});
```

The facade authenticates every call and checks the independently verified session
shop against the genuine Field Service's returned shop. A revoked session blocks
the call before field resolution. This is dependency wiring, not an implemented
session service or HTTP route. Bindings remain installed exclusively through
verified server source/schema configuration; this facade accepts no arbitrary
binding definitions or handler functions. Shop identities allow dotted domains
with strict nonempty/length/trim/control validation; revision tokens keep their
separate restricted character and length rules.

## Complete product-ID query compilation

Use explicit server imports for the catalog verifier and complete-query factory:

```javascript
import { createMirrorSqlSchema } from "./filters/mirror-schema.js";
import { verifyMirrorSqlSchema } from "./services/mirror-schema.server.js";
import { createFilterCompiler } from "./filters/compile.js";
import { createCursorService } from "./filters/pagination.js";

// Supply actual, server-owned schema mappings and the existing PostgreSQL pool.
// Every table mapping includes an explicit PostgreSQL namespace.
const physicalSchema = await verifyMirrorSqlSchema({
  database,
  schema: createMirrorSqlSchema(verifiedMirrorMappings),
  mirrorSchemaVersion: publishedMirrorSchemaVersion,
  sourceContractVersion: installedSourceContractVersion,
  // Explicit canonical fieldId/entity/column/type approvals, reviewed at bootstrap.
  fieldMappings: approvedCanonicalColumnMappings,
});
const cursorService = createCursorService({ secret: serverOwnedCursorSecret });
const compiler = createFilterCompiler({ fieldService, physicalSchema, cursorService });
const contract = await compiler.validateFilter(input, trustedFilterContext);
const query = await compiler.compileFilter(contract, {
  authContext: verifiedAuthContext,
  pageSize: 50,
});
```

Catalog verification checks actual tables, identity types/collations and indexes
in a read-only transaction. The compiler rechecks catalog drift, live published
coverage/authorization, actual field columns and final typed parameter count.
The returned privately issued SELECT is a query plan, not permission to execute.
No raw shop/generation overrides or decoded cursor positions are accepted.
Approved column mappings are checked against both canonical identity and actual
catalog types/columns; the compiler's installed sources must match those exact
approvals. An existing unrelated column with the right SQL type is insufficient.

Cursor support is optional. `serverOwnedCursorSecret` must be a Buffer of at
least 32 securely generated bytes from the backend secret store. For a query
owned by this compiler, call `compiler.createCursor(query, lastProductId)` with
the last actual result ID. Pass that opaque token as `cursor` to a later
`compiler.compileFilter(contract, { authContext, cursor, pageSize })` call. The
compiler itself authenticates the HMAC and checks expiry, execution fingerprint,
shop, generation, physical schema fingerprint, ID type and ordering. Each page
still reruns Field Service authorization/coverage and catalog verification.

Text cursor comparison and ordering both use explicit `"pg_catalog"."C"`
collation, requiring a matching scoped B-tree index in the verified catalog.
UUID and bigint IDs use native ordering and exact string representations;
signed 64-bit IDs never pass through floating-point numbers. Cursor and LIMIT
parameters both count toward the final SQL budget. Unsigned, expired, altered
or cross-context tokens fail closed. Without a configured cursor service, cursor
input is rejected and the compiler supports only a first page.
An executor still must hold a valid publication lease for the query lifetime,
authorize the operation at dispatch and use the same verified database/schema.
No query executor, production mappings or live database verification is supplied
by this change. Compiled-query and signed-cursor provenance are not authorization.

## Combined verification

Verified on 2026-10-27 with Node.js v24.16.0 using the current workspace sources:

- `npm --prefix web test`: 436 passed, no failures, one TODO for the unwired HTTP
  field consumer. This command now includes the Field Engine, mirror coverage
  and Express foundation suites; CI runs the same command.
- `node --test tests/*.test.js` from `web/frontend`: all 46 tests passed.
- `npm run build` from `web/frontend` with a placeholder build API key: passed.

`SOURCE_DATASETS.METAFIELDS` is registered as `"metafields"` and has a regression
check. Source fixtures remain separate from the reviewed production
`FIELD_SOURCES` now installed in `fields/sources.js`; see `source-registry.md`.
Live application verification remains pending deployed mirror tables,
repositories, authorization and execution endpoints. The expected
HTTP-consumer test stays marked TODO until its actual endpoint is wired.

## Validated filter boundary

Configure `createFilterService({ fieldService })` from server-only
`web/filters/validate.js` with the genuine application field service.
Its `validateFilter(ast, { authContext, operation, executionContext })` obtains
authorized mappings and published coverage, checks operator compatibility and
normalizes every operand. Its immutable result binds shop, operation, generation,
coverage revision, targeting snapshot and `registryVersion`. No brand issuer
is exported.

The same instance's `compileFilter(validated, { authContext })` rejects copied or
foreign filters and revalidates authentication, authorization, current published
coverage, approval compatibility, definition revisions and mapping fingerprints.
Store `registryVersion` with approved previews and pass it as
`expectedRegistryVersion` when resuming in a new process. Reconstruct filters
through validation; serialization does not preserve private provenance.

SQL generation supports explicit canonical column mappings from the trusted
source registry only. It returns a scoped WHERE fragment with separate typed
`values`, not a complete query. Column, alias and scope identifiers are restricted
and quoted; operands, shop and generation IDs use parameters. Missing mappings,
arbitrary SQL expressions, unsupported storage/operator combinations and dynamic
SQL sources fail closed. Actual production mappings and query execution are not
implemented. Future executor code must supply trusted FROM/JOIN clauses and
retain the generation under a transaction or retention lease.

## NULL and identity contracts

Negative predicates preserve PostgreSQL UNKNOWN for NULL, including under
logical NOT. Only explicit null checks inspect nullness; null is not the empty
string or an empty list. A different true OR branch can still match the row.
See [PostgreSQL logical operators](https://www.postgresql.org/docs/current/functions-logical.html)
and [array comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html).

Canonical serialization lives in `filters/serialization.js`, separately from
AST parsing. It sorts object keys, preserves group/array order and exact scalar
representation, and carries its own version. `filters/fingerprint.js` defines
structural and bound SHA-256 identities. The bound identity includes the shop,
operation, generation, coverage and registry versions and approved targeting ID.
These identities are correlation data, never reusable authorization grants.
Every validation and compilation reauthorizes; changing operation requires new
validation, even for the identical AST or fingerprint.

## Structural and execution budgets

AST parsing keeps its 1,000-node/depth-32 limit and exact JSON byte accounting.
Malformed Unicode and numeric `-0` are rejected, including nested operands and
object keys. Negative-zero decimal strings remain strings at this stage.

Semantic execution limits are separate: 100 conditions, depth 12 and total OR
fan-out 32 (sum of child counts for all OR groups). The private compiler allows
500 actual parameters including tenant/generation values and reports its actual
plan counts. Supported variant predicates share correlated scopes, counted as
emitted and capped at 16. The execution page-size guard
defaults to 50 and permits sizes 1–100. No additional AST cache or authorization
cache is introduced.

## Compiler bindings bootstrap

Populate `FILTER_BINDING_DEFINITIONS` and `FILTER_SQL_SCHEMA` in the trusted
source module only after SQL/schema verification. `filters/bindings.js` keeps
construction private and accepts no configuration arguments through its getter.
Definitions select immutable built-in handler IDs and cannot register functions
or raw SQL. Lookup returns metadata only.

Each definition contains `fieldId`, `entity`, `sourceKind`, ordered `datasets`,
`correlation`, `handlerId`, `operators`, `cost`, `mirrorSchemaVersion` and
`sourceContractVersion`. Product handlers use `product_column_v1`/`product` with
cost 1; variant handlers use `variant_exists_v1`/`variant_exists` with cost 2.
Operators must match canonical capabilities and installed handlers. Cost is a
per-predicate estimate, not proof of database performance.

The schema contract supplies product/variant scopes and both compatibility
versions. Published snapshot repositories return actual versions in coverage
receipts, checked exactly before compilation. Version labels, registry provenance
and fixture tests do not replace real schema and SQL verification.

Variant SKU = ABC AND variant price > 100 uses one correlated EXISTS, including
when positive AND groups are nested. Mixed product/variant OR and variant NOT
currently fail closed until an explicit scope/quantifier contract is defined.
Dynamic metafield SQL remains unavailable. Production source and binding
definitions are still unimplemented.

## Fingerprint v2 integration

Use `fingerprintFilterAst` for canonical structural content identity and
`fingerprintFilterExecution` for operation/snapshot identity. Neither is a token
or signature. Configured validation supplies authenticated shop, resolved
generation and coverage, concrete registry identity, actual module contract
versions and the exact trusted definition revisions for referenced dynamic IDs.
It does not forward request-controlled identity fields into the hashing options.

Revision metadata is bounded, descriptor-safe, unique and sorted ordinally.
Missing/extra dynamic revisions or an AST-version mismatch fail closed. Dotted
Shopify shop domains are supported separately from opaque generation/revision
tokens. Pure hashing validates formats and consistency; the repository and field
service must still verify authenticity, authorization and current revisions.

Both compatibility fingerprint names now emit format v2, so regenerate v1 hashes.
Keep pagination signing separate: a future server HMAC cursor must cover the
execution fingerprint, cursor position and expiry. An unsigned SHA-256 value
cannot establish that client-carried state is authentic.
