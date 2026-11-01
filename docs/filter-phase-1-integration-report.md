# Phase 1 Filter Engine Integration and Verification Report

**Branch:** `feature/filter-phase-1`
**Date:** 2026-11-01
**Database:** Disposable local PostgreSQL 18-alpine
**Result:** Phase 1 suite reproduced: **21 passed, 0 failed, 0 skipped, 9 suites**.

**Sign-off boundary:** These results cover filtering and persisted selection
snapshots. They do **not** verify the complete approved-selection-to-Shopify-
mutation path or establish bulk-edit worker readiness.

**Production performance sign-off: NOT ESTABLISHED.** The query-plan test is a
small-fixture smoke test. Its passing timings are not merchant-scale benchmarks.

## Evidence and scope

The source of truth is [phase1-postgres.test.js](../web/filters/integration/phase1-postgres.test.js).
Its SHA-256 at review was
`dc5e39f750e5599769bc4b1033913914faa7ac230b73213fd7a313086759a904`.
The fixture matrix below describes the initial seed, before the selection test
changes product 102's prices. Product and variant numbers abbreviate full
`gid://shopify/Product/{number}` and `gid://shopify/ProductVariant/{number}` GIDs;
query results use the separate internal PostgreSQL bigint product IDs.

Reproduction after a clean backend dependency install:

```powershell
npm run setup:tests
npm run test:phase1:postgres
npm run test:filters
```

| Suite | Passed / total | Failed / skipped | Recorded duration | Evidence |
| --- | --- | --- | --- | --- |
| Phase 1 PostgreSQL | 21 / 21 | 0 / 0 | 1,955.4996 ms | [PostgreSQL log](../.audit/dependency-phase1-postgres-20261101.log) |
| Filter unit/compiler | 212 / 212 | 0 / 0 | 1,553.4841 ms | [Filter log](../.audit/dependency-filter-tests-20261101.log) |

These are recorded runs, not timing guarantees. The earlier report's broader
1,669-test aggregate is not used as current sign-off evidence here. This report
does not claim that all backend, schema, frontend, or concurrency suites passed.

## Fixture setup and its limits

The setup applies every numeric-prefixed migration directory in sorted order,
including `20261101000800_complete_incremental_tenant_policies` at review time.
It runs migration SQL directly; it does not exercise Prisma's deployment ledger.
It creates these tenant/generation pairs:

| Shop | Generation | Initial query scope |
| --- | --- | --- |
| `shop-a.myshopify.com` | `gen-published` | Shop A's published catalog |
| `shop-a.myshopify.com` | `gen-retired` | Excluded from the published generation |
| `shop-b.myshopify.com` | `gen-b-published` | Shop B only |

The helper stages generations through INGESTING, RECONCILING, VERIFIED, and
PUBLISHED, then RETIRED where requested. It inserts fixture ingestion and
coverage records with fixed counts of 10 for both datasets. These counts are
not measurements of actual imported JSONL rows. It temporarily disables
`guard_sync_retention` and the variants' `guard_generation_data` trigger during
setup, restoring both in `finally`. Consequently this fixture does not certify
production ingestion completeness or all publication lifecycle preconditions.

The suite uses the disposable database administrator pool and explicit test
shop/authorization providers, including an `authorizeAccess` provider returning
true. Tenant query predicates and runtime validation are exercised; independent
Shopify authentication and restricted-login RLS enforcement are not established
by this suite alone.

## Exact initial product and variant matrix

All products below are seeded ACTIVE. The first eight products belong to Shop A,
`gen-published`; controls 109 and 201 have separate scopes shown below.

| Product | Exact title | Variant | Price | Compare-at price | Variant soft-deleted? |
| --- | --- | --- | --- | --- | --- |
| 101 | Equal Price Item | 1011 | 25.00 | 25.00 | No |
| 102 | Discounted Item | 1021 | 19.99 | 29.99 | No; SKU `DISC-1021` |
| 102 | Discounted Item | 1022 | 45.00 | 50.00 | No |
| 103 | Marked Up Item | 1031 | 35.00 | 20.00 | No |
| 104 | Blank Compare At Item | 1041 | 15.00 | NULL | No |
| 104 | Blank Compare At Item | 1042 | 18.00 | 25.00 | No |
| 105 | Zero Compare At Item | 1051 | 10.00 | 0.00 | No |
| 106 | Soft Deleted Variants Item | 1061 | 12.00 | 20.00 | Yes |
| 106 | Soft Deleted Variants Item | 1062 | 20.00 | 20.00 | No |
| 106 | Soft Deleted Variants Item | 1063 | 10.00 | NULL | Yes |
| 107 | No Variants Item | None | — | — | — |
| 108 | Mixed Multi Variant Item | 1081 | 50.00 | 40.00 | No |
| 108 | Mixed Multi Variant Item | 1082 | 30.00 | 35.00 | No |
| 109 | Retired Gen Item | 1091 | 10.00 | 20.00 | No; Shop A, `gen-retired` |
| 201 | Foreign Shop Item | 2011 | 5.00 | 10.00 | No; Shop B, `gen-b-published` |

## Filter outcomes and assertion coverage

For Shop A's published generation, the initial fixture implies these result sets:

| Filter | Matching product numbers | Reason |
| --- | --- | --- |
| `product.id IN [101, 102]` | 101, 102 | Exact GID matching |
| `variant.compareAtPrice IS NULL` | 104 | Active variant 1041; deleted 1063 is excluded |
| `variant.price < variant.compareAtPrice` | 102, 104, 108 | Variants 1021/1022, 1042, and 1082 |
| `variant.price = variant.compareAtPrice` | 101, 106 | Variants 1011 and active 1062 |
| `variant.price > variant.compareAtPrice` | 103, 105, 108 | Variants 1031, 1051, and 1081 |

The price-comparison tests assert expected inclusions and selected exclusions,
not exact equality of every complete result set. The table describes
fixture-derived sets; it must not be read as stronger assertions than the source.
Zero compare-at price on 105 is distinct from NULL; variant 1041 contributes no
match to ordinary price comparisons because its comparison evaluates UNKNOWN.
Products without variants cannot satisfy a variant EXISTS predicate.

The specific-products tests additionally assert deduplication, empty-array
rejection (`INVALID_VALUE`), foreign-shop product 201 returning an empty result,
and rejection of an oversized 101-GID array against the 100-item limit.

## Boolean composition and scope

- Product 101/102 ID membership AND `price < compareAtPrice` returns exactly 102.
- `price < compareAtPrice` AND `variant.sku = 'DISC-1021'` returns exactly 102;
  the generated SQL contains exactly one EXISTS. The previous report's additional
  price-threshold example was not this test's predicate.
- Product title equality for Equal Price Item OR Discounted Item returns 101/102.
- Mixed product/variant OR and variant predicates inside NOT are rejected with
  `UNSUPPORTED_OPERATION`.
- Shop A's price-lower query excludes foreign product 201 and retired product 109.
  A separate Shop B compiler/executor returns exactly product 201.

## Pagination and frozen selection

The pagination test uses **pageSize 1**, verifies one row and a continuation
cursor on page 1, then verifies one different row on page 2. It rejects a tampered
cursor with `INVALID_VALUE`. It does not consume the third discounted product or
assert terminal `hasMore: false`; cross-shop/generation cursor replay rejection
is not asserted by this Phase 1 test.

The selection test creates an ALL_MATCHING snapshot and checks APPROVED status,
shop, generation, a present selection hash, and a selected count of at least two.
It reads stored membership and checks its length against the count. To simulate
catalog drift it disables `guard_generation_data`, sets **all** product 102
variant prices to 999.00, and restores the trigger. It then checks the snapshot's
status, hash, and count stayed unchanged. Direct deletion of selection items and
mutation of the approved filter AST each fail with SQLSTATE 23514.

It does not reread and compare the complete member-ID list after drift. Its
cleanup sets **both** product 102 variants to 19.99, rather than restoring
variant 1022's initial 45.00. Performance measurements therefore run after this
fixture mutation. The test bypass is confined to disposable PostgreSQL and does
not describe permitted production mirror writes.

## Bulk-edit execution is outside this suite

The snapshot test calls `selectionService.createSelection` and queries the stored
selection. It never creates a mutation execution contract through the approval
service, dispatches a durable job command, invokes `createOperationWorker`, or
sends a Shopify mutation. The snapshot's `APPROVED` status is not evidence that
the mutation approval, worker authority, or remote write path was exercised.

| Boundary | Evidence in this Phase 1 snapshot test |
| --- | --- |
| Filter evaluation to persisted selection | Exercised through ALL_MATCHING selection creation |
| Snapshot status, count, hash, and immutability checks | Exercised as described above |
| Exact frozen membership consumed by the execution worker | Not exercised |
| Mutation contract approval and durable command dispatch | Not exercised |
| Worker lease, current authorization, installation and publication fences | Not exercised |
| Shopify mutation payload, response, and remote outcome verification | Not exercised |
| Mirror/history completion and uncertain-response recovery | Not exercised |

Complete-path sign-off requires a separate integration scenario that starts with
the real approved selection, approves the immutable mutation execution contract,
dispatches its durable command, and runs the actual worker with the intended
restricted database profiles. A controlled Shopify transport must capture the
mutation payload so the test can compare its exact targets with the frozen
selection, including exclusions and tenant/generation coordinates. It must also
verify durable completion and reject revoked authority, stale publication or
installation, and uncertain responses without issuing duplicate writes.

Such a controlled-transport test would establish integration through the worker's
Shopify boundary, not prove acceptance by the live Shopify API. Any live-store
mutation verification needs separately identified evidence. Existing worker tests
under `web/edit-history/integration/worker-execution.js` are separate coverage;
their presence and the 21 Phase 1 passes do not establish that this complete
filter-to-mutation scenario has run successfully.

## Small-fixture query-plan smoke test

Shop A's queried published generation has **8 products and 12 variant rows**,
including two soft-deleted variants. The database also contains one retired
product/variant and one product/variant for Shop B: **10 products and 14 variants
in total**. Only four query shapes are measured, each once with `pageSize: 50`,
after earlier tests have accessed and mutated this fixture.

The test logs JSON summaries from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and
asserts PostgreSQL's reported execution time for each statement is below 50 ms.
This is a test-local smoke threshold, not a production service-level objective.
It does not time the complete authenticated HTTP request, field/schema/coverage
verification, pool acquisition, application processing, or network transfer.
The following values come from the linked
reproduction log; no full textual plan is claimed as captured evidence.

| Query | Planning ms | Execution ms | Root | Shared hit blocks | Actual rows |
| --- | --- | --- | --- | --- | --- |
| Specific products 101/102 | 0.693 | 0.032 | Limit | 2 | 2 |
| Compare-at price is blank | 0.290 | 0.221 | Limit | 18 | 1 |
| Price < compare-at price | 0.126 | 0.100 | Limit | 18 | 3 |
| Product AND variant conjunction | 0.137 | 0.071 | Limit | 4 | 0 |

The measured conjunction selects product **101**, whose equal price does not
satisfy `<`; its zero rows are expected. It differs from the earlier functional
AND test selecting 101/102, which returns product 102. The small fixture and
logged summary do not establish production-scale performance, mandatory index
usage, zero disk spills, or a concurrency guarantee.

## Merchant-scale performance evidence still required

No merchant-scale benchmark or load test is included in the recorded evidence.
The following is a required validation plan, not a report of completed work:

| Dimension | Evidence to collect before production performance sign-off |
| --- | --- |
| Scale and distribution | Deterministically seeded, realistic product/variant ratios, skewed variant fan-out, NULL and zero values, soft deletions, and several tenants. Proposed tiers: 10,000, 100,000, and 1,000,000 products; the largest tier must cover or exceed the intended supported merchant size. Record actual row counts and seed/version. |
| Query selectivity | Specific-ID inputs up to the allowed maximum; rare, common, and zero-match NULL/price comparisons; supported product/variant conjunctions. Include first and deep cursor pages and full all-matching selection materialization, with known correct results. |
| Actual application path | Measure the authenticated request through live authorization, registry/schema/coverage checks, the compiler-issued executor, and the intended restricted database profiles. Separate SQL time from complete request and selection-job duration. |
| Database environment | Record PostgreSQL version, migrations, indexes, statistics/ANALYZE state, compute, storage, memory/work_mem, pool sizes, dataset footprint, and network location. Use a production-representative environment; local Docker alone cannot certify hosted latency. |
| Cache and repetition | Record warm-up policy and repeated measurements for each scenario. Separate warm-cache runs from explicitly documented cold-cache conditions; do not describe a fresh connection as a cold database cache. |
| Concurrency and contention | Exercise several merchants and simultaneous requests under the expected load, plus ingestion, reconciliation, publication replacement, and selection jobs. Measure pool wait, locks, timeouts, retries, cancellation, and throughput without weakening snapshot or tenant fences. |
| Measurements | Save latency distributions (including p50/p95/p99 and sample counts), throughput, errors, CPU/memory, and complete EXPLAIN JSON plans with actual/estimated rows, loops, buffer reads/hits, temporary I/O, and sort/hash spills. Assess plan choices against selectivity rather than requiring an index scan for every query. |
| Acceptance and reproducibility | Establish supported scale, request/selection latency budgets, concurrency, throughput, and allowable resource/error limits before running. Publish commands, fixture parameters, environment configuration, raw artifacts and per-scenario results against those agreed budgets. |

The Phase 1 smoke test remains useful for correctness and obvious local query
regressions. It must not be used to infer percentile latency, sustained load
capacity, production index behavior, or approval to support an unmeasured
merchant catalog size. Production performance sign-off remains open until the
separate workload above has been executed and its acceptance criteria met.
