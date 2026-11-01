# METAMAX Phase 1 — Filter Semantics Contract Freeze

This document defines and freezes the exact semantics, request AST specifications, SQL compilation predicates, truth tables, and compiler capability requirements for the Phase 1 filters.

It serves as the authoritative specification before making any modifications to the filter compiler or field engine.

---

## 1. Scope of Phase 1 Filters

Phase 1 formalizes five canonical filter behaviors across three functional categories:

1. **Specific Products**: Matches products whose Shopify GIDs belong to an explicitly provided set of IDs.
2. **Compare-at Price is Blank**: Matches products with at least one variant where the compare-at price is SQL `NULL`.
3. **Price Comparisons (Same-Row Variant Correlation)**:
   - **Price < Compare-at Price**: Matches products with at least one variant where both prices are present and `price < compareAtPrice`.
   - **Price = Compare-at Price**: Matches products with at least one variant where both prices are present and `price = compareAtPrice`.
   - **Price > Compare-at Price**: Matches products with at least one variant where both prices are present and `price > compareAtPrice`.

---

## 2. AST Grammar & Exact Request Specifications

All requests use the established **AST Version 1** contract defined in [`web/filters/ast.js`](file:///d:/newmeta/web/filters/ast.js#L23-L49). No secondary query dialect or ad-hoc SQL parameters are introduced.

### 2.1 Specific Products

Reuses the canonical field [`product.id`](file:///d:/newmeta/web/fields/canonical.js#L345) and the approved membership operator `in`.

```json
{
  "version": 1,
  "root": {
    "kind": "condition",
    "field": "product.id",
    "operator": "in",
    "value": [
      "gid://shopify/Product/8204781293701",
      "gid://shopify/Product/8204781326469"
    ]
  }
}
```

- **Field Identity**: `product.id` (Entity: `product`, Type: `id`, Physical SQL column: `p."shopify_id"`, Storage: `text`).
- **Operator**: `in` (Family: `comparison`, Value shape: `set`, Null policy: `exclude`).
- **Operand Constraints**:
  - Dense array of 1 to 100 (`MAX_OPERATOR_SET_SIZE`) non-empty strings.
  - Each ID must satisfy `normalizeId` (no whitespace, length $\le 256$ bytes, valid Unicode).
  - Empty selections (`value: []`) are strictly rejected by the operator shape validator with `INVALID_VALUE`.

---

### 2.2 Compare-at Price is Blank

Reuses the canonical field [`variant.compareAtPrice`](file:///d:/newmeta/web/fields/canonical.js#L369) and the canonical presence operator `is_null`.

```json
{
  "version": 1,
  "root": {
    "kind": "condition",
    "field": "variant.compareAtPrice",
    "operator": "is_null"
  }
}
```

- **Field Identity**: `variant.compareAtPrice` (Entity: `variant`, Type: `money`, Nullable: `true`, Physical SQL column: `v."compare_at_price"`, Storage: `numeric`).
- **Operator**: `is_null` (Family: `presence`, Value shape: `none`, Null policy: `inspect`).
- **Operand Constraints**: No `value` key in the condition node (`hasValue: false`). If `value` is present, `assertOperatorOperandShape` rejects it with `INVALID_VALUE`.

---

### 2.3 Price Comparisons (Same-Row Same-Variant)

To compare two columns on the same variant row without exposing arbitrary SQL column names or expressions to the browser, we use the standard comparison operators (`lt`, `eq`, `gt`) applied to `variant.price`, targeting `variant.compareAtPrice` via a structured field reference operand.

#### A. Price < Compare-at Price
```json
{
  "version": 1,
  "root": {
    "kind": "condition",
    "field": "variant.price",
    "operator": "lt",
    "value": {
      "kind": "field",
      "field": "variant.compareAtPrice"
    }
  }
}
```

#### B. Price = Compare-at Price
```json
{
  "version": 1,
  "root": {
    "kind": "condition",
    "field": "variant.price",
    "operator": "eq",
    "value": {
      "kind": "field",
      "field": "variant.compareAtPrice"
    }
  }
}
```

#### C. Price > Compare-at Price
```json
{
  "version": 1,
  "root": {
    "kind": "condition",
    "field": "variant.price",
    "operator": "gt",
    "value": {
      "kind": "field",
      "field": "variant.compareAtPrice"
    }
  }
}
```

- **Left Field**: `variant.price` (Entity: `variant`, Type: `money`, Physical SQL column: `v."price"`, Storage: `numeric`).
- **Right Field (Target)**: `variant.compareAtPrice` (Entity: `variant`, Type: `money`, Physical SQL column: `v."compare_at_price"`, Storage: `numeric`).
- **Operators**: `lt`, `eq`, `gt` (Family: `comparison`, Value shape: `scalar` or structured target reference, Null policy: `exclude`).
- **Preserved Invariant**: Both fields resolve to the exact same correlation alias (`v`) inside the same `EXISTS` subquery.

---

### 2.4 Compound Example: Specific Products AND On-Sale Variants

```json
{
  "version": 1,
  "root": {
    "kind": "group",
    "operator": "AND",
    "children": [
      {
        "kind": "condition",
        "field": "product.id",
        "operator": "in",
        "value": ["gid://shopify/Product/101", "gid://shopify/Product/102"]
      },
      {
        "kind": "condition",
        "field": "variant.price",
        "operator": "lt",
        "value": {
          "kind": "field",
          "field": "variant.compareAtPrice"
        }
      }
    ]
  }
}
```

---

## 3. Capability Gap Analysis

| Capability | Expressible with Current AST Grammar? | Supported by Current Compiler? | Required Action |
| :--- | :--- | :--- | :--- |
| **Specific Products** (`product.id in [...]`) | **Yes** | **Yes** | Fully supported. Needs no compiler modifications. |
| **Compare-at Price Blank** (`variant.compareAtPrice is_null`) | **Yes** | **Yes** | Fully supported via correlated `EXISTS`. Needs no compiler modifications. |
| **Same-Row Price Comparisons** (`price < compareAtPrice`, etc.) | **Yes** (AST parser allows plain record values) | **No** (Validator expects literal scalar values only and parameterizes them as `$N`) | **Requires a trusted compiler extension** in semantic validation and predicate compilation. |

### Technical Details of Compiler Extension
1. **Structural Parser (`web/filters/ast.js`)**: Already permits objects in `value` (up to 32 keys, depth $\le 8$). No grammar changes required.
2. **Normalization Boundary (`web/fields/normalize.js`)**: Currently assumes `operator.valueShape === "scalar"` must be a string/number literal. It must recognize a trusted `{ kind: "field", field: "<fieldId>" }` operand shape and validate that `<fieldId>` is a registered canonical field with matching type compatibility.
3. **Semantic Validation & Correlation (`web/filters/validate.js`)**:
   - Must resolve both source and target fields through the field registry.
   - Must enforce **same-entity restriction**: source and target must both belong to `variant` (or both to `product`).
   - Must enforce **same-correlation restriction**: target must map to the same correlation scope (`variant_exists_v1`).
   - Must emit direct SQL column-to-column comparison `(v."price" < v."compare_at_price")` rather than binding a parameter `$N`.
   - Negative predicates or comparisons involving SQL `NULL` naturally evaluate to `UNKNOWN` in SQL, satisfying the requirement that both prices must exist.

---

## 4. Expected SQL Predicate Shapes

All SQL queries are generated strictly by [`web/filters/compile.js`](file:///d:/newmeta/web/filters/compile.js) with outer tenant/generation fencing:
`$1::text` = `shopId`, `$2::text` = `generationId`.

### 4.1 Specific Products
```sql
SELECT p."id" AS product_id
FROM "mirror"."products" AS p
WHERE ((p."shop_id" = $1::text AND p."generation_id" = $2::text)
  AND (p."shopify_id" IN ($3::text, $4::text)))
ORDER BY p."id" ASC
LIMIT $5::integer
```
*Parameters*: `[$1 = shopId, $2 = generationId, $3 = "gid://shopify/Product/1", $4 = "gid://shopify/Product/2", $5 = 51]`

---

### 4.2 Compare-at Price is Blank
```sql
SELECT p."id" AS product_id
FROM "mirror"."products" AS p
WHERE ((p."shop_id" = $1::text AND p."generation_id" = $2::text)
  AND (EXISTS (
    SELECT 1
    FROM "mirror"."variants" AS v
    WHERE v."shop_id" = $1::text
      AND v."generation_id" = $2::text
      AND v."product_id" = p."id"
      AND (v."compare_at_price" IS NULL)
  )))
ORDER BY p."id" ASC
LIMIT $3::integer
```
*Parameters*: `[$1 = shopId, $2 = generationId, $3 = 51]`

---

### 4.3 Price < Compare-at Price (Same-Row Variant Correlation)
```sql
SELECT p."id" AS product_id
FROM "mirror"."products" AS p
WHERE ((p."shop_id" = $1::text AND p."generation_id" = $2::text)
  AND (EXISTS (
    SELECT 1
    FROM "mirror"."variants" AS v
    WHERE v."shop_id" = $1::text
      AND v."generation_id" = $2::text
      AND v."product_id" = p."id"
      AND (v."price" < v."compare_at_price")
  )))
ORDER BY p."id" ASC
LIMIT $3::integer
```
*Parameters*: `[$1 = shopId, $2 = generationId, $3 = 51]`

---

### 4.4 Same-Variant Multiple Conditions Conjunction
When a filter combines multiple conditions on variants within an `AND` group, `validate.js` flattens them into a single `EXISTS` subquery to enforce that they match on the **same variant row**:
```sql
SELECT p."id" AS product_id
FROM "mirror"."products" AS p
WHERE ((p."shop_id" = $1::text AND p."generation_id" = $2::text)
  AND (EXISTS (
    SELECT 1
    FROM "mirror"."variants" AS v
    WHERE v."shop_id" = $1::text
      AND v."generation_id" = $2::text
      AND v."product_id" = p."id"
      AND (v."price" < v."compare_at_price")
      AND (v."sku" = $3::text)
  )))
ORDER BY p."id" ASC
LIMIT $4::integer
```

---

## 5. Truth Table of Edge Cases

### 5.1 Price Comparisons & Null Evaluation (Single Variant)

| `variant.price` | `variant.compareAtPrice` | `price < compareAtPrice` | `price = compareAtPrice` | `price > compareAtPrice` | `compareAtPrice is_null` | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `10.0000` | `20.0000` | **TRUE** (Match) | FALSE | FALSE | FALSE | On sale |
| `20.0000` | `20.0000` | FALSE | **TRUE** (Match) | FALSE | FALSE | Equal prices |
| `25.0000` | `20.0000` | FALSE | FALSE | **TRUE** (Match) | FALSE | Compare-at lower than price |
| `15.0000` | `NULL` | FALSE (UNKNOWN) | FALSE (UNKNOWN) | FALSE (UNKNOWN) | **TRUE** (Match) | Standard non-sale variant |
| `0.0000` | `0.0000` | FALSE | **TRUE** (Match) | FALSE | FALSE | Zero prices match equality |
| `0.0000` | `10.0000` | **TRUE** (Match) | FALSE | FALSE | FALSE | Free promo with compare-at |
| `NULL` | `20.0000` | FALSE (UNKNOWN) | FALSE (UNKNOWN) | FALSE (UNKNOWN) | FALSE | Corrupted/missing price excluded |
| `NULL` | `NULL` | FALSE (UNKNOWN) | FALSE (UNKNOWN) | FALSE (UNKNOWN) | **TRUE** (Match) | Both prices missing |

*Key Guarantee*: In SQL three-valued logic, `(v.price < v.compare_at_price)` evaluates to `UNKNOWN` (falsy) whenever either column is `NULL`. Thus, price comparisons strictly enforce that **both prices exist**.

---

### 5.2 Multi-Variant Products Evaluation

A product matches if `EXISTS` is true for at least one active variant of that product.

| Product Scenario | Variant 1 | Variant 2 | Matches `price < compare`? | Matches `price = compare`? | Matches `compare is_null`? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Product A** | `price`: 10, `compare`: 20 | `price`: 30, `compare`: 20 | **YES** (via Var 1) | NO | NO |
| **Product B** | `price`: 15, `compare`: NULL | `price`: 15, `compare`: 15 | NO | **YES** (via Var 2) | **YES** (via Var 1) |
| **Product C** | `price`: 10, `compare`: NULL | `price`: 20, `compare`: NULL | NO | NO | **YES** (via Var 1 & 2) |
| **Product D** | `price`: 25, `compare`: 20 | `price`: 35, `compare`: 30 | NO | NO | NO |

---

### 5.3 Conjunctions, Disjunctions & Negations

1. **`AND` of two variant conditions**:
   - `variant.price lt variant.compareAtPrice AND variant.sku eq "PROMO"`: Correlates to a **single** variant row. Both predicates must hold on that specific variant.
2. **`OR` of variant conditions**:
   - `variant.price lt variant.compareAtPrice OR variant.compareAtPrice is_null`: Correlates into `EXISTS (SELECT 1 ... WHERE (v.price < v.compare_at_price) OR (v.compare_at_price IS NULL))`. Matches if any variant satisfies either branch.
3. **Mixed Product and Variant `OR` / `NOT`**:
   - `product.vendor eq "Nike" OR variant.price lt variant.compareAtPrice`: **FAILS CLOSED** with `UNSUPPORTED_OPERATION` ("Mixed product/variant OR or NOT requires an explicit correlation scope").
   - `NOT (variant.price lt variant.compareAtPrice)`: **FAILS CLOSED** with `UNSUPPORTED_OPERATION` ("Variant NOT requires an explicit quantifier contract") to prevent inverted quantifier bugs (e.g. `NOT EXISTS` vs `EXISTS(NOT ...)`).

---

### 5.4 Input Validation Edge Cases

- **Empty ID Selection (`in []`)**: Rejected with `INVALID_VALUE` by `assertOperatorOperandShape` (`min: 1`).
- **Whitespace / Formatting in GIDs**: `" gid://shopify/Product/1 "` or `"gid://shopify/Product/1 \n"` is rejected by `normalizeId`.
- **Set Size Exceeded**: `in` with $> 100$ items throws `LIMIT_EXCEEDED`.
- **Precision and Decimals**: `variant.price` enforces maximum scale 4, precision 20 (`DECIMAL_TYPES`). Field comparisons between `price` and `compareAtPrice` share identical precision and scale, guaranteeing zero precision loss.
- **Cross-Entity Field References**: Attempting `{ field: "variant.price", operator: "lt", value: { kind: "field", field: "product.title" } }` fails validation due to entity mismatch (`variant` vs `product`) and type mismatch (`money` vs `string`).

---

## 6. Selection Snapshot & Preview Consistency

To guarantee that product search previews and bulk-edit operations never drift:

1. **Pinned Selection Snapshot**:
   - Catalog filtering (`POST /api/filters/search`, `GET /api/mirror/products`) and bulk mutations share the same physical schema verification and execution engine.
   - All filter executions pass through [`withCoverageTransaction`](file:///d:/newmeta/web/mirror/coverage-transaction.server.js) and require publication locks ([`publicationService.lockForRead`](file:///d:/newmeta/web/mirror/publication-lock.server.js)).
2. **Bulk Edit Selection Authority**:
   - In [`web/services/selection.server.js`](file:///d:/newmeta/web/services/selection.server.js#L33-L50), `create({ mode: "ALL_MATCHING", filter })` runs `parseFilterAst(filter)` through the exact same validator and compiler.
   - The compiled query is bound to the exact tenant `shopId`, `generationId`, and `coverageRevision` verified at approval time.
   - The query results are materialized into the selection database snapshot before the operation executes. If a catalog publication or generation rollover occurs during this window, the generation lock detects the conflict and rolls back before mutation.

---

## 7. Required Test Plan

The implementation in Step 3 must be validated against the following test suite:

### 7.1 Unit Tests
- **`web/fields/normalize.test.js`**:
  - Test valid `{ kind: "field", field: "variant.compareAtPrice" }` operand normalization.
  - Test rejection of non-canonical field IDs in target operand.
  - Test rejection of type-mismatched target fields (e.g. comparing money to string or datetime).
  - Test rejection of empty array for `in` operator.
  - Test boundary validation for `product.id` GIDs (256-byte limit, surrogate rejection, whitespace rejection).
- **`web/filters/__tests__/validate.test.js` & `compile.test.js`**:
  - Test SQL compilation of `product.id in [...]` generating `p."shopify_id" IN ($3, $4)`.
  - Test SQL compilation of `variant.compareAtPrice is_null` generating `(v."compare_at_price" IS NULL)` inside `EXISTS`.
  - Test SQL compilation of `variant.price lt variant.compareAtPrice` generating `(v."price" < v."compare_at_price")` inside `EXISTS`.
  - Test rejection of cross-entity field comparison (`variant.price` vs `product.id`).
  - Test fail-closed rejection of mixed product/variant `OR` and variant `NOT`.

### 7.2 PostgreSQL Integration Tests (`web/filters/integration/postgres.test.js`)
- Seed fixtures:
  - Product 1: Variant A (`price`: 10, `compare`: 20) — on sale.
  - Product 2: Variant B (`price`: 20, `compare`: 20) — equal price.
  - Product 3: Variant C (`price`: 30, `compare`: 20) — price higher than compare.
  - Product 4: Variant D (`price`: 15, `compare`: NULL) — blank compare-at price.
  - Product 5: Variant E (`price`: 50, `compare`: NULL), Variant F (`price`: 25, `compare`: 50) — multi-variant mixed.
- Verify:
  - Querying `product.id in [Product 1 GID, Product 3 GID]` returns exactly `[Product 1, Product 3]`.
  - Querying `variant.compareAtPrice is_null` returns `[Product 4, Product 5]`.
  - Querying `variant.price lt variant.compareAtPrice` returns `[Product 1, Product 5]`.
  - Querying `variant.price eq variant.compareAtPrice` returns `[Product 2]`.
  - Querying `variant.price gt variant.compareAtPrice` returns `[Product 3]`.
  - Conjunction `product.id in [Product 1 GID] AND variant.price lt variant.compareAtPrice` returns `[Product 1]`.

---

## 8. Unresolved Design Decisions & Recommendations

1. **Structured Operand Shape Representation**:
   - **Recommendation**: Standardize on `{ "kind": "field", "field": "variant.compareAtPrice" }`.
   - **Rationale**: Follows the existing AST pattern (`kind` discriminant). The `field` identifier is validated strictly against `CANONICAL_FIELDS` and `FILTER_BINDING_DEFINITIONS`.
2. **Empty Selection Handling in the UI**:
   - **Decision**: The backend strictly rejects `in []` with `INVALID_VALUE`.
   - **Recommendation**: The UI toolbar/layer must disable or withhold the specific products filter condition if no products are checked, or treat an empty selection as an empty preview without dispatching an invalid AST query.
3. **Soft-Deleted Variants Fencing (`deleted_at IS NULL`)**:
   - **Observation**: `mirror.variants` includes a `deleted_at timestamptz` column. The catalog projection in `catalog-repository.server.js` filters `v.deleted_at IS NULL`.
   - **Decision**: In Step 3, ensure the compiler's `variantExists` subquery template includes `AND v."deleted_at" IS NULL` so that soft-deleted variants are never evaluated when matching price or null conditions.
