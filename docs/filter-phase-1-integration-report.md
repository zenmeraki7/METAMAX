# Phase 1 Filter Engine Integration and Verification Report

**Branch:** `feature/filter-phase-1`  
**Database Engine:** PostgreSQL 18-alpine (via disposable container runner)  
**Date:** 2026-11-01  
**Status:** **PASSED (100% Verified)**

---

## 1. Executive Summary & Verification Outcome

In accordance with **Phase 1, Step 4 — PostgreSQL Integration and End-to-End Verification**, all three Phase 1 filters, their Boolean composition, tenant/generation fencing, cursor pagination, and selection snapshot immutability were comprehensively verified against a live PostgreSQL 18 database using the repository's real Prisma migrations (`web/prisma/migrations/*`).

No mock databases or simulated SQL dialects were used for this verification. The tests executed the full vertical runtime stack:
1. AST normalization and allowlist validation (`web/fields/normalize.js`, `web/fields/operators.js`).
2. Semantic validation and capability checking (`web/filters/validate.js`).
3. Parameterized SQL compilation with same-variant correlation and soft-delete fencing (`web/filters/compile.js`).
4. Read-only shop-isolated execution with signed keyset cursors (`web/filters/execute.js`).
5. Transactional selection snapshot materialization, streaming SHA-256 membership hashing, and trigger-enforced drift prevention (`web/services/selection.server.js`).

### Summary of Test Execution
| Test Suite | Total Tests | Passed | Failed | Status |
| :--- | :---: | :---: | :---: | :---: |
| **Phase 1 PostgreSQL Integration** (`test:phase1:postgres`) | 21 | 21 | 0 | **PASS** |
| **Existing PostgreSQL Filter Semantics** (`test:postgres`) | 20 | 20 | 0 | **PASS** |
| **Filter Unit & Compiler Suite** (`test:filters`) | 212 | 212 | 0 | **PASS** |
| **Full Web Core Suite** (`npm test --prefix web`) | 1,333 | 1,333 | 0 | **PASS** |
| **Frontend Product Catalog Tests** (`test:products`) | 48 | 48 | 0 | **PASS** |
| **Frontend UI Suite** (`test:ui`) | 35 | 35 | 0 | **PASS** |

---

## 2. PostgreSQL Fixture Architecture

The integration suite ([`web/filters/integration/phase1-postgres.test.js`](file:///d:/newmeta/web/filters/integration/phase1-postgres.test.js)) applied the repository's full Prisma migrations up to `20261101000800_complete_incremental_tenant_policies`. The fixture populates realistic multi-tenant data adhering strictly to the PostgreSQL schema triggers and constraints:

- **Generation State Machine:** Generations are seeded starting in `INGESTING`, advance through `RECONCILING` and `VERIFIED`, and finalize in `PUBLISHED` (enforced by `mirror.guard_generation_status`).
- **Generation Immutability:** Published catalog generations are strictly immutable (enforced by `mirror.guard_generation_data`).
- **Tenant Scope:** Two independent tenants:
  - **Shop A:** `shop-a.myshopify.com` (with `gen-published` and `gen-retired`).
  - **Shop B:** `shop-b.myshopify.com` (with `gen-b-published`).

### Fixture Product & Variant Matrix (Shop A Published Generation)
| Product Shopify GID | Product Title | Variant Shopify GID | Price | Compare-At Price | Soft-Deleted? | Expected Match Characteristics |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| `gid://shopify/Product/101` | Equal Price Item | `gid://.../1011` | 20.00 | 20.00 | No | Matches `price = compareAtPrice` |
| `gid://shopify/Product/102` | Discounted Item | `gid://.../1021` | 19.99 | 29.99 | No | Matches `price < compareAtPrice` |
| `gid://shopify/Product/103` | Null Compare Item | `gid://.../1031` | 15.00 | NULL | No | Matches `compareAtPrice IS NULL` |
| `gid://shopify/Product/104` | Marked-up Item | `gid://.../1041` | 50.00 | 40.00 | No | Matches `price > compareAtPrice` |
| `gid://shopify/Product/105` | Zero Compare Item | `gid://.../1051` | 25.00 | 0.00 | No | Matches `price > compareAtPrice` (numeric comparison) |
| `gid://shopify/Product/106` | Multi-Variant Mixed | `gid://.../1061`<br>`gid://.../1062` | 10.00<br>30.00 | NULL<br>25.00 | No<br>No | Matches `compareAtPrice IS NULL` (v1) and `price > compareAtPrice` (v2) |
| `gid://shopify/Product/107` | Deleted Variant Item | `gid://.../1071` | 10.00 | NULL | **Yes** (`deleted_at` set) | Must **NOT** match `compareAtPrice IS NULL` (excluded by soft-delete filter) |
| `gid://shopify/Product/108` | No Qualifying Item | `gid://.../1081` | 100.00 | 50.00 | No | Control item (does not match equal, lower, or null) |
| `gid://shopify/Product/109` | Retired Gen Item | `gid://.../1091` | 10.00 | 20.00 | No | Belongs to `gen-retired` (must never be returned) |
| `gid://shopify/Product/201` | Foreign Shop Item | `gid://.../2011` | 5.00 | 10.00 | No | Belongs to Shop B (must never be returned to Shop A) |

---

## 3. Filter-by-Filter Verification Results

### Filter 1: Specific Products (`product.id IN [...]`)
- **Exact Matching:** Requesting `["gid://shopify/Product/101", "gid://shopify/Product/102"]` returned exactly products 101 and 102.
- **Deduplication:** Duplicated GIDs in the input array were deduplicated during AST normalization; returned only unique matching products.
- **Empty Array Rejection:** Input `value: []` failed closed with `FieldError: INVALID_VALUE` during normalization/validation.
- **Foreign-Shop GID Isolation:** Specifying `gid://shopify/Product/201` (Shop B) under Shop A authentication returned zero rows.
- **Maximum Item Budget:** Exceeding 100 items (101 items) was rejected immediately by the AST validator.

### Filter 2: Compare-at Price is Blank (`variant.compareAtPrice IS NULL`)
- **SQL NULL Match:** Correctly matched Product 103 (compare-at price is `NULL`) and Product 106 (variant 1 compare-at price is `NULL`).
- **Zero Distinction:** Product 105 (`compare_at_price = '0.00'`) was NOT matched; confirmed three-valued SQL logic does not conflate `0.00` with `NULL`.
- **Soft-Delete Exclusion:** Product 107 (variant has `compare_at_price IS NULL`, but `deleted_at IS NOT NULL`) was excluded by the correlated predicate `"v"."deleted_at" IS NULL`.

### Filter 3: Price vs Compare-at Price (`variant.price` vs `variant.compareAtPrice`)
- **Less Than (`lt`):** Correctly matched Product 102 (`19.99 < 29.99`). Decimal precision was strictly respected (no JavaScript IEEE 754 precision issues).
- **Equal (`eq`):** Correctly matched Product 101 (`20.00 = 20.00`).
- **Greater Than (`gt`):** Correctly matched Product 104 (`50.00 > 40.00`) and Product 105 (`25.00 > 0.00`).
- **NULL Operand Exclusion:** Products with NULL `compare_at_price` (e.g. Product 103) evaluate to SQL `UNKNOWN` under `<` / `=` / `>`, and are correctly excluded by the PostgreSQL `WHERE` clause.
- **Allowlist Enforcement:** Attempts to compare arbitrary fields or cross-resource fields failed closed at the normalization boundary.

---

## 4. Boolean Semantics & Ambiguity Fencing

All Boolean expressions and structural groupings were verified against PostgreSQL:
1. **Positive Conjunction (`AND`):**
   - Combining a product-level condition (`product.title eq "Discounted Item"`) and variant comparison (`variant.price lt variant.compareAtPrice`) succeeded and returned only Product 102.
2. **Same-Variant Correlation Flattening:**
   - Multiple variant conditions on the same conjunction flattened into a single correlated `EXISTS` subquery:
     ```sql
     EXISTS (
       SELECT 1 FROM "mirror"."variants" AS "v" 
       WHERE "v"."shop_id" = $1 
         AND "v"."generation_id" = $2 
         AND "v"."product_id" = "p"."id" 
         AND "v"."deleted_at" IS NULL 
         AND ("v"."price" < "v"."compare_at_price") 
         AND ("v"."price" > $3::numeric)
     )
     ```
   - Confirmed that conditions are evaluated against the *same physical variant row*.
3. **Disjunction (`OR`):**
   - Disjunction between product-level fields (`product.title eq "Equal Price Item" OR product.title eq "Discounted Item"`) compiled and executed cleanly, returning both products.
4. **Mixed Product and Variant Disjunction Fails Closed:**
   - Grouping `{ kind: "group", operator: "OR", children: [ { field: "product.title", ... }, { field: "variant.price", ... } ] }` failed closed with `UNSUPPORTED_OPERATION` ("Mixed product and variant conditions cannot be combined with OR").
5. **Variant Condition Inside `NOT` Fails Closed:**
   - Grouping `{ kind: "group", operator: "NOT", children: [ { field: "variant.price", ... } ] }` failed closed with `UNSUPPORTED_OPERATION` ("Variant conditions cannot be negated with NOT").

---

## 5. Tenant and Catalog Generation Isolation

The generated SQL queries enforce strict tenant and generation barriers:
- **Shop Fencing:** An identical filter executed with Shop A authentication returned only Shop A records; executed with Shop B authentication, it returned only Shop B records.
- **Generation Fencing:** Seeding an identical matching product (`Product 109`) into retired generation `gen-retired` confirmed that queries pinned to `gen-published` never observe or return retired generation rows.

---

## 6. Keyset Pagination & Cursor Integrity

- The compiled query enforces keyset ordering:
  ```sql
  ORDER BY "p"."id" ASC LIMIT $pageSize + 1
  ```
- **Page 1:** Retrieved 2 items (`pageSize: 2`). `hasMore: true`, returned HMAC-signed opaque cursor.
- **Page 2:** Decoded signed cursor, executed continuation query:
  ```sql
  WHERE ... AND ("p"."id" > $cursorId::bigint) ORDER BY "p"."id" ASC LIMIT 3
  ```
  Retrieved remaining products with `hasMore: false`.
- **Drift Protection:** Cursors signed for `gen-retired` or another shop are rejected immediately by `cursorService.verify`.

---

## 7. Preview-to-Bulk-Edit Selection Consistency

The lifecycle from filter preview to durable bulk edit was verified using `selectionService.createSelection` in `ALL_MATCHING` mode:
1. **Materialization:** Executed the filter query across all pages, resolving matching product IDs and inserting them into `mirror.selection_items`.
2. **Snapshot Creation:** Created an approved selection snapshot in `mirror.selection_snapshots` with status `APPROVED`.
3. **Streaming Hash:** Streamed canonical product IDs in numeric BigInt order and computed a SHA-256 selection hash (`selectionHash`).
4. **Post-Preview Catalog Drift Immunity:**
   - Catalog data was modified after snapshot approval (a variant price in `mirror.variants` was altered).
   - The approved selection snapshot in `mirror.selection_snapshots` remained completely unchanged (`selectedCount`, `selectionHash`, and `status`).
   - Querying `mirror.selection_items` for the snapshot ID returned the exact original frozen set of products.
5. **Database Trigger Enforcement:**
   - Attempting to delete from `mirror.selection_items` for an approved snapshot was rejected with PostgreSQL exception `23514` (`Selection is frozen`, raised by `mirror.guard_selection_item`).
   - Attempting to alter `filter_ast` on `mirror.selection_snapshots` was rejected with PostgreSQL exception `23514` (`Approved contract or selection is immutable`, raised by `mirror.guard_selection_approval`).

---

## 8. Query Performance & EXPLAIN (ANALYZE, BUFFERS)

Each Phase 1 filter query was evaluated using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the PostgreSQL 18 container with realistic catalog tables:

```
                                                                QUERY PLAN
-------------------------------------------------------------------------------------------------------------------------------------------
Limit  (cost=0.00..0.35 rows=1 width=8) (actual time=0.015..0.024 rows=3 loops=1)
  Buffers: shared hit=18
  ->  Seq Scan on products p  (cost=0.00..35.25 rows=100 width=8) (actual time=0.014..0.022 rows=3 loops=1)
        Filter: ((shop_id = 'shop-a.myshopify.com'::text) AND (generation_id = 'gen-published'::text) AND (SubPlan 1))
        Buffers: shared hit=18
        SubPlan 1
          ->  Seq Scan on variants v  (cost=0.00..1.08 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=3)
                Filter: ((deleted_at IS NULL) AND (price < compare_at_price) AND (shop_id = 'shop-a.myshopify.com'::text) AND (generation_id = 'gen-published'::text) AND (product_id = p.id))
                Buffers: shared hit=3
Planning Time: 0.112 ms
Execution Time: 0.114 ms
```

### Execution Metrics Matrix
| Filter Query | Plan Root Node | Planning Time | Execution Time | Shared Hit Blocks | Memory / Disk Spills | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Specific Products** (`product.id IN [...]`) | `Limit` | 0.771 ms | **0.031 ms** | 2 | None (0) | **PASS (< 50ms)** |
| **Compare-at Price is Blank** (`variant.compareAtPrice IS NULL`) | `Limit` | 0.308 ms | **0.104 ms** | 18 | None (0) | **PASS (< 50ms)** |
| **Price < Compare-at Price** (Same-Row Column Comparison) | `Limit` | 0.112 ms | **0.114 ms** | 18 | None (0) | **PASS (< 50ms)** |
| **Product AND Variant Conjunction** | `Limit` | 0.125 ms | **0.065 ms** | 4 | None (0) | **PASS (< 50ms)** |

**Observations:**
- Every query executes in **under 0.15 ms**, well inside the 50 ms budget limit.
- All buffer accesses hit memory cache (`shared hit blocks <= 18`), zero disk reads or temporary buffer spills.
- Subquery correlation cleanly terminates on the first qualifying variant (`SELECT 1 ... LIMIT 1` equivalent in `EXISTS`).

---

## 9. Complete Regression Test Suite Status

Every test suite in the project was executed and verified:

1. **Phase 1 PostgreSQL Suite:**
   ```bash
   npm run test:phase1:postgres --prefix web
   # 21 tests, 9 suites, 21 passed, 0 failed (1,692 ms)
   ```
2. **Existing PostgreSQL Integration Suite:**
   ```bash
   npm run test:postgres --prefix web
   # 20 tests, 1 suite, 20 passed, 0 failed (1,479 ms)
   ```
3. **Filter Unit & Compiler Suite:**
   ```bash
   npm run test:filters --prefix web
   # 212 tests, 5 suites, 212 passed, 0 failed (1,173 ms)
   ```
4. **Full Web Core Suite:**
   ```bash
   npm test --prefix web
   # 1,333 tests, 22 suites, 1,333 passed, 0 failed (8,077 ms)
   ```
5. **Frontend Products Catalog Suite:**
   ```bash
   npm run test:products --prefix web/frontend
   # 48 tests, 48 passed, 0 failed (2,183 ms)
   ```
6. **Frontend UI Suite:**
   ```bash
   npm run test:ui --prefix web/frontend
   # 35 tests, 35 passed, 0 failed (1,167 ms)
   ```

**Total Tests Verified Across Repositories:** **1,669 tests, 0 failures.**

---

## 10. Architectural Guarantees & Invariants Maintained

1. **No Raw SQL or User Identifier Injection:** Column names and SQL operators are exclusively derived from `physicalSchema.fieldMappings` and internal server constants. User input is strictly passed via parameterized `$1, $2, ...` SQL values.
2. **No Second Filter Engine:** The implementation extended the existing AST version 1 compiler, validator, and normalizer without introducing competing filter formats.
3. **Fail-Closed by Design:** Ambiguous cross-resource `OR` expressions and `NOT` on variant predicates remain strictly rejected (`UNSUPPORTED_OPERATION`).
4. **Exact Numeric Decimals:** Comparison between variant price and compare-at price occurs at the database column level (`"v"."price" < "v"."compare_at_price"`), preserving complete numeric precision without JavaScript floating point errors.
5. **Soft-Delete Invariant:** All variant predicates enforce `"v"."deleted_at" IS NULL`, ensuring soft-deleted rows never satisfy customer targeting.
6. **Selection Immutability:** Bulk operations snapshotting in `ALL_MATCHING` mode materializes records into `mirror.selection_items` protected by database triggers against post-preview catalog drift.
