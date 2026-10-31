# Catalog and import route security review

Import IDs are canonical lowercase UUID v4 values. Both legacy enqueue in
`web/services/catalog-import.server.js` and phase enqueue in
`web/services/catalog-phase-runtime.server.js` generate them with
`crypto.randomUUID()`. The database stores the ID in a TEXT primary key.
`catalog-import-id.server.js` enforces grouping, version and variant at the
route and service boundaries; it grants no ownership authority.

## Request and tenant authority

`web/app.js` mounts `createShopifyAuthMiddleware` on `/api` before filters,
catalog and imports. The filter router additionally checks the private request
proof recorded by that middleware before parsing or capture. Filter runtime
capture issues an opaque context; `filter-auth.server.js` reloads the stored
session and rejects revoked, expired or changed-shop sessions when resolving it.
An HTTP shop parameter is not an authentication source.

The import router authenticates and resolves that stored session before body
validation. The import service independently reloads credentials and checks
shop identity and product-read scopes. Status binds both `j.shop_id=$1` and
`j.id=$2`; cancellation binds both `shop_id=$1` and `id=$2`. A well-formed ID
belonging to another shop produces no row and therefore a 404. Enqueue derives
the shop from the stored session and verifies the installation under a
transaction. Workers additionally fence their shop, installation and lease.

## Query semantics beyond HTTP size limits

`catalog-query.server.js` bounds query strings to 16 KiB, rejects unknown keys
and non-string values, bounds search and cursor sizes, and allows at most ten
advanced conditions. Supported keys are `search`, `status`, `limit`, `cursor`,
`filters` and `match`. Catalog projection is fixed; unsupported `fields`
parameters are rejected. Filter/controller normalization allows only `filter`,
`pageSize` and `cursor`, with bounded page size and cursor length.

Neither parsing nor normalization authorizes a filter. Both HTTP paths call
the configured compiler's semantic `validateFilter` and `compileFilter` before
the executor. The installed runtime supplies the authenticated shop, verified
physical schema, trusted field service and published context. The field service
resolves canonical or trusted shop-scoped dynamic fields and enforces operators,
normalized operands and authorization. Dynamic bindings remain fail-closed
where no verified backend resolver exists.

`filters/validate.js` adds execution limits of 100 conditions, depth 12,
32 OR branches, 16 correlated subqueries and 500 SQL parameters. Compilation
checks live bindings and issues a private query plan. `filters/execute.js`
independently resolves the shop, accepts only a query issued by its compiler,
verifies publication/coverage in a protected repeatable-read transaction, and
rechecks authorization after acquiring publication protection. Execution uses
parameterized values, a 5-second statement timeout, a 1-second lock timeout,
bounded pages and a 512 KiB result limit. Cursor signatures bind the shop,
filter and published snapshot.

## Verification boundaries

Backend tests cover missing/forged/revoked credentials, request normalization,
semantic validation, private compiler/executor provenance, cursors, execution
budgets and UUID acceptance/rejection. Import service tests also inspect the
actual SQL and bound shop/ID parameters for owner and foreign-shop requests.

Disposable PostgreSQL suites provide database-level coverage: `test:postgres`
tests the real filter HTTP runtime and scoped cursor replay; `test:schema`
includes import reads and cancellation across shops. These suites require a
running Docker engine or a complete local runtime set via `FILTER_POSTGRES_BIN`.
Passing backend tests alone does not establish live deployment schema, scopes
or coverage readiness.
