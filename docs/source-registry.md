# Installed canonical SQL source contract

`web/fields/sources.js` installs `FIELD_SOURCES`, `FILTER_BINDING_DEFINITIONS`
and `FILTER_SQL_SCHEMA` for the reviewed `web/prisma/` mirror migrations.
The module remains pure: no database queries, HTTP, Shopify calls or Prisma use.

All 58 canonical identities have an immutable source descriptor. Exactly 27
product/variant scalar fields have SQL bindings. The ID-to-column table is
written explicitly in code, including `description_html`, `product_type`,
`compare_at_price`, `inventory_quantity` and timestamp columns. No SQL name is
produced from a merchant field ID, casing conversion, JSON path or request schema.
Operator allowlists are fixed; adding a general operator cannot silently extend
an installed SQL handler.

Logical `product.id` and `variant.id` use `shopify_id` TEXT. Query pagination and
variant correlation use internal BIGINT identities (`products.id` and
`variants.product_id`). Those are different contracts. `variant.productId`
remains unavailable because its logical Shopify GID requires a reviewed parent
relation adapter. It is never mapped to the internal bigint foreign key.

List fields, inventory, locations, collections, options, categories and dynamic
metafields retain explicit unavailable metadata with no SQL map or binding.
Supported product fields such as `product.categoryId` still refer to the scalar
projection on the product row; that does not enable category-family handlers.
The compiler's physical planner rejects unsupported fields before calling
authorization/coverage adapters or the predicate compiler.

`web/services/filter-schema.server.js` provides server-only
`getInstalledFilterSchemaOptions()` and `verifyInstalledFilterSchema({ database })`.
The former supplies the exact `mirror.products`/`mirror.variants` schema target,
reviewed mappings and compatibility versions. The latter calls the existing real
catalog verifier, including key/index/type/collation checks. Neither a source
descriptor nor a mapping stored in the database constitutes authorization or
verified coverage.

Await `createInstalledFilterCompiler({ database, fieldService, cursorService })`
from that module to initialize the real compiler. It returns `{ compiler,
physicalSchema }` only after checking every installed column against PostgreSQL.
For HTTP startup, `createInstalledFilterHttpRuntime()` in
`web/services/filter-engine.server.js` installs the same fixed source contract
and publication barrier. It rejects caller-supplied schema/column/version
overrides, and verifies the catalog before invoking the Field Service factory.
Await this startup factory before accepting filter requests and propagate its
failure. Supply the actual session storage, authorized Field Service factory,
coverage and published-context repositories, and server cursor secret; these
dependencies have no permissive defaults. The template entry point remains
disabled until those application dependencies are supplied.

For a server-owned connection, run from `web/`:

```powershell
npm run db:verify:filters
```

This reads PostgreSQL catalogs only and exits nonzero when verification fails.
It never creates tables, publishes data or enables the HTTP route. Continue
using the configured Field Service, live coverage, publication barrier and
compiler-owned plans; the new source definitions replace none of those checks.

## Verification status on 2026-10-28

The actual Neon `newmeta` project, branch `express-backend-20261027`, database
`newmeta_app`, was inspected read-only. `mirror.products` and `mirror.variants`
are absent. The real `db:verify:filters` command returned
`verified: false`, `FIELD_CONTRACT_MISMATCH`, with 27 installed mappings.
No database migration or merchant-data change was made.

The code registry initializes successfully; live schema compatibility has NOT
passed. The application must keep the runtime disabled until the reviewed
migrations, repositories, authentication/authorization and coordinated writers
are deployed and verified. Do not substitute old JSON tables or infer mappings
from their names to force readiness.

`npm run test:schema` now applies all migrations to disposable PostgreSQL and
verifies every installed mapping, then runs the real Field Service, compiler and
executor without source mocks. It includes a SKU/price case that would falsely
match if different variants were combined. This test is also included in CI.
It initializes through `createInstalledFilterCompiler()` and commits removal of
an approved SKU column, proves startup fails, restores the column, then proves
startup succeeds again.
The local Docker engine was unavailable; portable PostgreSQL downloads also
timed out. This database scenario was not executed locally. Backend unit/HTTP
tests passed: 500 passed, zero failed, one existing TODO.
