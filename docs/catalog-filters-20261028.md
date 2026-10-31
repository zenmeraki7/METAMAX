# Catalog filtering integration — 2026-10-28

The existing 27 product/variant bindings and `product.tags` now share the verified
filter runtime used by the application catalog. No schema migration is needed
for tags: the mirrored `products.tags` column and ingestion already exist.

## Request and response contract

`GET /api/mirror/products` retains the frontend's `search`, `status`, `limit`,
`filters`, `match` and signed `cursor` parameters. The server translates them
into the existing AST and uses the existing validator, resolver, compiler and
executor. Browser fields and operators are never used as SQL identifiers.

The response remains `{ products, snapshotId, publishedRevision, syncStatus,
summary: { productCount, variantCount, activeCount }, filteredCount,
pageInfo: { hasNextPage, endCursor } }`. Product IDs are Shopify GIDs;
`variantCount` is numeric and `totalInventory` is an exact integer string.
Images are null because this mirror does not store a verified image projection.

`GET /api/products/count` uses the same validated catalog query implementation
and returns `{ count, precision: "EXACT" }`. `GET /api/mirror/status` returns the
current published snapshot and coverage revision. These routes require Shopify
authentication, return JSON errors and disable shared caching.

Counts exclude the pagination cursor, so they describe every matching product.
Rows, counts and summaries are read in the executor's protected repeatable-read
transaction. The compiler owns the count predicate and checks every projected
field. Price and SKU conditions retain the existing same-variant correlation
rules. Unsupported combinations, such as mixed product/variant OR scopes not
implemented by the shared engine, still fail closed.

## Authorization and startup

`index.js` awaits the installed runtime before accepting traffic. Bootstrap
verifies the physical schema; missing columns/tables stop startup. Dependencies
default to the real publication repository and field authorization service.
Each request and execution recheck the bound stored session, installed shop,
product scope, field registry and exact published generation/coverage.
No dynamic field adapter or write authorization is implicitly enabled.

Set a persistent server-only `FILTER_CURSOR_SECRET` of at least 32 bytes. The
Shopify API secret supplied by Shopify CLI is the fallback. Keys and database
credentials must stay out of frontend code.

**Deployment prerequisite found:** a read-only check of the application's current
`web/.env` connection failed physical verification with `Mapped mirror table
unavailable`. That connection was not modified. To serve merchant data, choose
the intended isolated, migrated database connection and finish publishing a
complete products/variants generation there through the hardened synchronization
services. Pointing at the isolated baseline alone does not create merchant data.
The prior `live-catalog-verification.json` is historical evidence and does not
establish readiness of the current database/schema.

## Toolbar and tags

The picker exposes the 27 fixed fields plus Tag with type-specific operators.
`neq` replaces `ne`. Decimal/bigint operands stay exact strings; boolean values
are booleans; date inputs become ISO timestamps. Presence/empty operators omit
their value. Set/range inputs accept comma-separated values.

Tags use `list_contains`, `list_not_contains`, `is_empty`, `is_not_empty`,
`is_null` and `is_not_null`. Membership is exact and case-sensitive: `Summer`
differs from `summer`. Percent signs, underscores, quotes and commas in a single
tag are literal values. Negative predicates retain SQL NULL semantics. The
frontend no longer sends the unsupported `contains_any` operator.

## Verification

- Backend suite: 568 passing, zero failures, one existing TODO.
- PostgreSQL filter regression suite: 20 passing.
- PostgreSQL schema suite: 21 passing, including an actual HTTP application using
  the default authorization/repositories and all 28 field bindings. Cases cover
  title/vendor/status/price/SKU, tags, counts across pages, forged descriptors,
  injection-like values, cursor tampering, missing scopes and uninstall denial.
- Frontend product suite: 35 passing; production Vite build succeeds.
- Rendered Chrome/Playwright checks at desktop and 390px mobile widths pass:
  vendor `neq` and tag `list_contains` reach the API, no page errors, no mobile
  horizontal overflow. Browser plugin was unavailable; bundled Playwright used
  installed Chrome because its matching headless binary was absent. This UI
  check uses explicit intercepted test responses; real database behavior is
  independently exercised by the HTTP/PostgreSQL tests.

Shopify's remote component validator was not run: automatic approval review
rejected transmitting private toolbar source. Local build, interaction and real
Polaris browser rendering checks passed. No source was uploaded.

Production deployment and a live merchant session on a published database remain
unverified. No application database credentials, production merchant data or
production schema were changed.
