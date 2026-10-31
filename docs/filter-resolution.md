# Trusted filter resolution

`web/filters/resolver.js` exports `createFilterResolver` and
`assertResolvedFilterPlan` through the server-only `web/filters/index.js`.
The factory supports two explicit server-configured profiles. Their options
cannot be mixed.

The authenticated profile, `createFilterResolver({ fieldService })`, requires
the genuine Field Service created by `createFieldService`. Objects implementing
the same method names are rejected before their callbacks run.

The resolver owns two steps:

- `resolveFilterFields(ast, { authContext, operation, executionContext })`
  inspects a bounded structural AST, extracts its deduplicated field IDs, and
  requests read access from the configured Field Service. `operation` defaults
  to `filter` only when omitted. Authenticated shop resolution, canonical versus
  dynamic resolution, authorization, definition verification, approved targeting
  and actual pinned-generation coverage remain the Field Service's responsibility.
- `revalidateFilterFields(resolution, { authContext })` accepts only original
  receipts issued through this resolver instance. It reruns the Field Service's
  live authentication, authorization, coverage, registry and definition checks.
  Copied receipts, receipts from another resolver and direct Field Service
  receipts cannot acquire ownership by matching their public properties.

Both steps assert genuine receipt provenance, immutable field descriptors,
canonical registry identities, exact requested-field membership, read access
and the exact union of dataset dependencies. Unsupported context keys, symbols
and getters are rejected. Browser-controlled shops, field lists, mappings,
authorization callbacks, coverage callbacks and write access cannot override
the server configuration.

Resolution is not complete semantic validation and does not grant permission to
compile SQL. `createFilterService` uses this resolver internally, then validates
operator support, field constraints, normalized operands, mapping compatibility,
correlation and execution budgets before issuing its private validated contract.
Compilation revalidates the original resolution through the same resolver before
using the immutable approved snapshot. No validated-filter brand issuer or SQL
compiler is exported by the resolver.

Normal application code should continue using the configured compiler:

```js
const validated = await compiler.validateFilter(requestFilter, {
  authContext, // created by server authentication
  operation: "filter",
  executionContext, // loaded from trusted published/approved state
});
const query = await compiler.compileFilter(validated, { authContext });
const result = await executor.execute({ query, authContext });
```

The lower-level authenticated resolver exists for trusted backend consumers needing the same
resolution contract. It performs no SQL execution, HTTP handling or Shopify API
calls, and supplies no fabricated dynamic mappings or production repositories.
It does not make a structurally valid AST or a previously issued receipt into
a reusable authorization grant.

## Verified physical planner

`createFilterResolver({ physicalSchema, bindingRegistry })` provides `resolve(ast)`.
The optional registry defaults to the existing `getFilterBindingRegistry()`.
Both the registry and schema must have genuine private provenance. The planner
uses the installed canonical sources, registry and verified physical approvals;
it creates no second field registry or SQL expressions.

Plans contain version 1, registry/schema fingerprints, at most 100 distinct field
IDs, frozen handler/correlation metadata and exact column/type mappings, the
sorted dataset union, correlation categories and estimated unique-field cost.
Only the existing product and variant column handlers are accepted. Physical
scope mismatches, unapproved fields, dynamic families, source accessors and
unsupported datasets fail closed. All returned data is deeply immutable.
`assertResolvedFilterPlan` rejects copies and checks that the underlying schema
capability remains active. It asserts planning provenance, not authorization.

The compiler runs authenticated semantic validation before retaining a physical
plan. It compares both plans' mappings and dependencies, checks live catalog and
Field Service state at compilation, and re-resolves physical planning metadata
before issuing a query. Physical `resolve(ast)` alone does not validate operators,
normalize operands, verify coverage or authorize execution. Correlation categories
describe dependencies; `validate.js` continues to determine same-variant semantics.

## Enabled SQL families

SQL bindings remain limited to canonical product and variant columns, using only
`product_column_v1` and `variant_exists_v1`. The registry rejects inventory items,
inventory levels, locations, collections, product options and categories even
when their canonical definitions, datasets or Prisma models exist. Dynamic
metafields, arbitrary JSON paths, aggregate sources and invented handler IDs
remain disabled. The pure Field Engine may resolve metadata for these families;
that does not install a SQL adapter or enable filtering against their storage.

## Compiler-owned resolution plans

After semantic validation, the compiler captures a dedicated immutable plan in
its private contract WeakMap. It retains the normalized AST and code versions,
authenticated shop/operation/targeting/approval binding, exact resolved field
descriptors, definition revisions, physical columns, dataset union, binding
registry version and verified physical-schema fingerprint. The plan is created
only after all required physical field approvals succeed.

`compiler.getResolutionPlan(validated)` returns that compiler's original plan
for metadata inspection. It rejects copied contracts, standalone service
contracts and contracts belonging to another compiler. The validation service
also exposes its own `getResolutionPlan` for genuine service-issued contracts;
neither method accepts a plan as a replacement for a validated contract.

Compilation performs fresh resolver revalidation, then checks the emitted
predicate's exact identity and physical binding set against the retained plan.
It does not reconstruct coverage from preparation metadata. Every issued query's
execution plan references the same compiler-owned resolution plan and dataset
array. The executor obtains those dependencies from its configured compiler.
This ownership check and immutable metadata do not substitute for execution-time
authentication or transactionally protected publication checks. Merely reading
a plan never refreshes or grants authorization.
