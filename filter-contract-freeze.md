# METAMAX Filter Phase 1 — Contract Freeze Record

This document records the exact, authoritative backend contracts for the METAMAX filtering system as verified in Step 1. No second filter language or alternate AST dialect is introduced.

---

## 1. Dedicated Branch

- **Branch:** `feature/filter-phase-1`
- **Base Commit:** `7564c36` (*Resolve production blockers, canonical field drift, endpoint mismatches, and performance bottlenecks*)
- **Status:** Checked out and clean.

---

## 2. Canonical Fields Verification (`web/fields/canonical.js`)

| Field ID | Label | Entity | Type | Nullable | Editable | Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| [`product.id`](file:///d:/newmeta/web/fields/canonical.js#L345) | "Product ID" | `product` | `id` | `false` | `false` | Primary logical ID |
| [`variant.price`](file:///d:/newmeta/web/fields/canonical.js#L368) | "Price" | `variant` | `money` | `false` | `true` | precision: 20, scale: 4 |
| [`variant.compareAtPrice`](file:///d:/newmeta/web/fields/canonical.js#L369) | "Compare-at price" | `variant` | `money` | `true` | `true` | precision: 20, scale: 4 |

---

## 3. Canonical Operator Catalog (`web/fields/operators.js`)

### Membership Operators
- **`in`**:
  - Label: `"Is one of"`
  - Value Shape: `set` (array of scalars up to `MAX_OPERATOR_SET_SIZE = 100`)
  - Compatible Types: All scalars (`string`, `enum`, `boolean`, `integer`, `decimal`, `money`, `percentage`, `date`, `datetime`, `id`)
  - Family: `comparison`
  - Null Policy: `exclude`
- **`not_in`**:
  - Label: `"Is not one of"`
  - Value Shape: `set`
  - Compatible Types: All scalars
  - Family: `comparison`
  - Null Policy: `exclude` (Negative predicate; excludes null/missing records)
- **`list_contains`**:
  - Label: `"List contains"`
  - Value Shape: `element` (single scalar element)
  - Compatible Types: Lists (`string_list`, `id_list`)
  - Family: `collection`
  - Null Policy: `exclude`
- **`list_not_contains`**:
  - Label: `"List does not contain"`
  - Value Shape: `element`
  - Compatible Types: Lists (`string_list`, `id_list`)
  - Family: `collection`
  - Null Policy: `exclude`

### Null & Presence Operators
- **`is_null`**:
  - Label: `"Is null"`
  - Value Shape: `none` (No `value` key in condition AST)
  - Compatible Types: All types (`ALL_TYPES`)
  - Family: `presence`
  - Null Policy: `inspect` (Explicit null test: `(column IS NULL)`)
- **`is_not_null`**:
  - Label: `"Is not null"`
  - Value Shape: `none`
  - Compatible Types: All types
  - Family: `presence`
  - Null Policy: `inspect` (Explicit null test: `(column IS NOT NULL)`)
- **`is_empty`**:
  - Label: `"Is empty"`
  - Value Shape: `none`
  - Compatible Types: Emptiable (`string`, `string_list`, `id_list`)
  - Family: `presence`
  - Null Policy: `exclude` (Empty string `""` or array `cardinality(column) = 0`)
- **`is_not_empty`**:
  - Label: `"Is not empty"`
  - Value Shape: `none`
  - Compatible Types: Emptiable (`string`, `string_list`, `id_list`)
  - Family: `presence`
  - Null Policy: `exclude`

---

## 4. Binding Metadata & SQL Aliases (`web/filters/bindings.js` & `web/fields/sources.js`)

### Versions
- `FILTER_BINDING_VERSION = 2`
- `mirrorSchemaVersion = "metamax_mirror_v1"`
- `sourceContractVersion = "metamax_sources_v1"`

### Table and Column Scopes
- **Product Scope**:
  - Table: `mirror.products`
  - Alias: `p`
  - Primary Key: `id` (bigint internal ID)
  - Logical ID: `shopify_id` (text)
  - Tenant Column: `shop_id`
  - Generation Column: `generation_id`
- **Variant Scope**:
  - Schema: `mirror`
  - Table: `variants`
  - Alias: `v`
  - Product Reference: `product_id` (bigint foreign key to `p.id`)
  - Logical ID: `shopify_id` (text)
  - Tenant Column: `shop_id`
  - Generation Column: `generation_id`

### Handlers & Correlation Types
- **`product_column_v1`**:
  - Entity: `product`
  - Source Kind: `column`
  - Correlation: `product`
  - Cost: `1`
- **`variant_exists_v1`**:
  - Entity: `variant`
  - Source Kind: `column`
  - Correlation: `variant_exists`
  - Cost: `2`

### Canonical Binding Shape
Every binding registered in `FILTER_BINDING_DEFINITIONS` has the structure:
```javascript
{
  fieldId: "variant.price",
  entity: "variant",
  sourceKind: "column",
  datasets: ["products", "variants"],
  correlation: "variant_exists",
  handlerId: "variant_exists_v1",
  operators: ["eq", "neq", "in", "not_in", "is_null", "is_not_null", "gt", "gte", "lt", "lte", "between"],
  cost: 2,
  mirrorSchemaVersion: "metamax_mirror_v1",
  sourceContractVersion: "metamax_sources_v1"
}
```

---

## 5. Request AST Grammar (`web/filters/ast.js`)

### Root Container
```json
{
  "version": 1,
  "root": { ... }
}
```

### Group Node
```json
{
  "kind": "group",
  "operator": "AND" | "OR" | "NOT",
  "children": [ ... ]
}
```
- `AND` / `OR`: 1 to 1000 children. Empty groups are rejected.
- `NOT`: Exactly 1 child.

### Condition Node
```json
{
  "kind": "condition",
  "field": "variant.price",
  "operator": "between",
  "value": ["10.00", "50.00"]
}
```
- For presence operators (`is_null`, `is_not_null`, `is_empty`, `is_not_empty`), `value` is omitted or ignored.
- For scalar operators (`eq`, `gt`, etc.), `value` is a scalar string/number/boolean.
- For set operators (`in`, `not_in`), `value` is an array of scalars.
- For pair operators (`between`), `value` is a 2-element array.

### AST Limits
- `MAX_NODES`: 1,000
- `MAX_DEPTH`: 32 (runtime compilation budget max depth: 12)
- `MAX_CONDITIONS`: 100 (enforced at semantic compilation)
- `MAX_OR_BRANCHES`: 32 (fan-out limit)
- `MAX_CORRELATED_SUBQUERIES`: 16
- `MAX_BYTES`: 128 KB (131,072 bytes)

---

## 6. SQL Compilation & Variant Correlation (`web/filters/compile.js` & `web/filters/validate.js`)

### Parameter Fencing
- Parameters are parameterized (`$1::text`, `$2::text`, ...), never string-interpolated.
- Tenant guard parameters are reserved upfront:
  - `$1::text`: `shopId`
  - `$2::text`: `generationId`
- Outer WHERE clause structure:
  ```sql
  WHERE ((p."shop_id" = $1::text AND p."generation_id" = $2::text) AND <expression>)
  ```

### Variant Correlation Structure
Variant conditions are correlated using `EXISTS`:
```sql
(EXISTS (
  SELECT 1 FROM mirror.variants AS v
  WHERE v."shop_id" = $1::text
    AND v."generation_id" = $2::text
    AND v."product_id" = p."id"
    AND <variant-predicates>
))
```
- **Same-Variant Conjunction**: When multiple variant conditions are inside an `AND` group, they are gathered into a single `EXISTS` subquery to ensure they match on the *same* variant row.
- **Fail-Closed Mixed Groups**: Mixed product and variant conditions in `OR` groups or `NOT` groups without explicit quantifiers throw `UNSUPPORTED_OPERATION`.
- **Variant `NOT`**: `NOT` inside variant subqueries is rejected to prevent inverted quantifier traps.

---

## 7. Execution, Pagination & Fencing (`web/filters/execute.js`)

- **Query Kinds**: `product_ids`, `catalog_product_ids`, `catalog_status`, `catalog_count`.
- **Pagination**:
  - `pageSize`: integer between 1 and 100 (default 50).
  - Fetches `pageSize + 1` rows to calculate `hasMore`.
  - Next cursor issued via `cursorService.issue(...)` signing `{ lastProductId, fingerprint, shopId, generationId }`.
- **Fencing**:
  - Transaction: `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY`.
  - Timeouts: `statement_timeout = '5000ms'`, `lock_timeout = '1000ms'`.
  - Publication lock: `publicationService.lockForRead(client, shopId)` and `publicationService.requirePublished(...)` held before selection.
  - Shop verification: Re-verified against authenticated session before and after locks.

---

## 8. HTTP Interface (`web/routes/filters.routes.js` & `web/controllers/filters.controller.js`)

- **Route**: `POST /api/filters/search`
- **Security**:
  - Requires `requireVerifiedShopifySession`.
  - Sets `Cache-Control: private, no-store`.
  - Limits payload to 128KB (`express.json({ limit: "128kb" })`).
- **Body Schema**:
  ```json
  {
    "filter": { "version": 1, "root": { ... } },
    "pageSize": 50,
    "cursor": "opaque-signed-cursor"
  }
  ```
  Strictly rejects any unknown keys (only `["filter", "pageSize", "cursor"]` permitted).

---

## 9. Published Catalog Projections (`web/mirror/catalog-repository.server.js`)

Projections read from `mirror.products p`:
- Selected fields: `shopify_id AS id`, `title`, `handle`, `vendor`, `product_type AS "productType"`, `status`, `tags`.
- Correlated aggregations:
  - `"variantCount"`: `count(*)` from `mirror.variants v` (`deleted_at IS NULL`)
  - `"totalInventory"`: `sum(v.inventory_quantity)`
  - `"image"`: `COALESCE(p.attributes->'featuredImage'->>'url', ...)`
  - `"tracksInventory"`: Boolean resolution checking `tracksInventory` or `inventory_items.tracked`.
- Summary row: `productCount`, `activeCount`, `variantCount`.
