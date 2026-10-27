# Canonical field engine

Pure, synchronous field contracts for the currently mirrored catalogue. Import
the public API from `web/fields/index.js`. Importing this library does not open
database, Redis, or Shopify connections. The registry has 47 versioned fields
across `product`, `variant`, `inventoryItem`, `inventoryLevel`, and `location`.
Definitions, aliases, paths, operations, and returned normalized changes are
immutable. Unknown fields and arbitrary object paths fail closed.

Contract version: `metamax-fields-v4`. Canonical IDs and source paths are
preserved. The operation surface is reduced to `set`, `add_tags`, `remove_tags`;
earlier operation IDs are rejected, not silently translated. `resolveField()`
is an optional discovery API and returns
`null` for unavailable IDs; use `requireResolvedField()` for strict resolution.

## Public API

```js
import {
  listFields, resolveField, normalizeValue, validateValue,
  getCapabilities, assertValidChange, assertValidChanges, resolveFieldValue,
} from "./fields/index.js";

const definitions = listFields({ entity: "product" });
const definition = resolveField("variant.compare_at_price");
const money = normalizeValue("variant.price", "9007199254740993.123456");
const result = validateValue("product.status", "draft");
// { ok: true, value: "DRAFT", errors: [] }

// Populate these from verified server-side installation state, not request JSON.
const context = {
  authorized: true,
  scopes: ["write_products"],
  completedDatasets: ["products"],
  coverageReady: true,
  writeAdapterReady: true,
  undoJournalReady: true,
};
const capabilities = getCapabilities("product.title", context);
const change = assertValidChange({
  field: "product.title", operation: "set", value: "Summer collection",
}, context);
const changes = assertValidChanges([
  { field: "product.tags", operation: "add_tags", value: ["Summer"] },
], context);
```

`normalizeValue` validates and normalizes a standalone value without testing
edit eligibility. `validateValue` and `validateChange` return `{ ok, value?,
errors }`, with stable error codes and no echoed input values. The `assert*`
functions throw `FieldError` and return normalized values on success.
`assertValidChanges` rejects duplicate fields, including alias collisions.

Runtime availability requires verified authorization, granted scopes, and
complete mirror dataset coverage. Missing context enables no edits.
`write_*` implies its corresponding `read_*` scope.
The `products` coverage entry must come from completed product ingestion or a
published snapshot; inventory entries correspond to completed snapshot datasets.
The context booleans are outputs of backend services, not inputs accepted from
the frontend. `writeAdapterReady` must be derived for the specific field and
capability from registered gateway support; it is not a general app-wide switch.
`undoJournalReady` must reflect a valid durable journal for this execution.
This example illustrates the required shape, not proof that those services
are already implemented or that this installation has write scopes.

## Values and operations

- Money accepts decimal strings or safe integer numbers and never uses floating-point conversion.
  Insignificant leading/trailing zeros are removed; precision is retained. No
  currency-specific scale or rounding is guessed.
- Integers accept integer numbers or decimal integer strings within explicit
  GraphQL Int bounds. Booleans accept booleans or `true`/`false` strings, not
  numeric flags or JavaScript truthiness.
- IDs require complete, entity-specific opaque GIDs. SKU strings retain leading
  zeros and whitespace. Lists require arrays; CSV is not parsed implicitly.
- Datetimes require real calendar dates and an explicit timezone. Source string
  precision is retained; Prisma `Date` instances become ISO strings.
- Product status includes `UNLISTED`. Handles use a conservative lowercase
  alphanumeric/hyphen policy. Payload limits in `FIELD_LIMITS` are application
  resource guards, not a claim that every value will satisfy every Shopify rule.
- Only `set`, `add_tags`, and `remove_tags` are available. Required titles and
  prices reject empty/null values. Use explicit `set` values where clearing is
  supported: `[]` for tags, `""` for descriptions, and `null` for compare-at price.
- Tag edits require dense string arrays, trim whitespace, normalize to NFC and
  reject duplicates after normalization. Add/remove require 1–250 entries; set
  allows 0–250. Generic CSV strings, sparse arrays and invalid Unicode fail.
- Arithmetic, percentage changes, append/prepend, replacement and rounding are
  unavailable until exact arithmetic, conflict handling and undo are implemented.
- HTML is preserved, not sanitized. Consumers must sanitize before rendering
  arbitrary HTML. URL fields reject active-content schemes and credentials.

Product title, handle, description, status, vendor, type and tags support their
declared operations. Variant prices and inventory-item SKU have explicit mutation
contracts. Tracking and shipping edits are restricted in this initial surface.
Inventory quantities, aggregate totals,
timestamps, identities, locations, and derived fields are read-only here.
Variant SKU edits target `inventoryItem.sku` with the inventory item identity.
Legacy scalar barcodes remain read-only pending a multi-barcode adapter.

## Declared capabilities versus runtime availability

`getFieldCapabilities(id)` returns frozen declarations with `filter`, `edit`,
`import`, `export`, and `undo` keys, or `null` for unknown fixed IDs.
`hasFieldCapability`, `requireFieldCapability`, `listFieldsByCapability` and
`listFieldCapabilities` inspect declarations only. Explicit restrictions can
reduce these declarations, never grant capabilities. Import/undo declarations
describe semantic eligibility; they do not implement import services or undo.
Handle and status do not declare undo in this initial contract.

`checkFieldAvailability(id, capability, context)` is the final field-level gate.
It returns frozen `{ available, reason }` results, requiring exact booleans,
granted scopes and all declared datasets. Writes additionally require a ready
adapter; undo additionally requires its journal. `getCapabilities(id, context)`
preserves the runtime-view API with `readable`, `filterable`, `editable`, and
related keys. `resolveField` exposes both `declaredCapabilities` and the runtime
`capabilities` view. Neither authenticates the shop or establishes target ownership.

`operations.js` provides immutable catalogue and field-compatibility helpers:
`getEditOperation`, `listEditOperations`, `listFieldOperations`,
`supportsFieldOperation`, and `requireFieldOperation`.
`validateEditOperation(id, operation, input)` returns `{ valid, field, operation,
value, code, message }`; `requireValidEditOperation` returns the normalized value
or throws. Both delegate to shared canonical value normalization and test only
declared compatibility. They do not authorize or execute work.
`validateFieldValue(id, value, { purpose })` supplies the matching value-result
format for declaration-level purposes; `validateValue` retains its `{ ok }` API.
Use `assertValidChange` with a fresh verified runtime context to validate a plan
change at each execution boundary.

Run `npm --prefix web run fields:example` for the executable capability/operation
example in `web/examples/fields.js`. It uses illustrative fixtures, asserts the
expected results, and makes no database, Redis or Shopify calls. In particular,
`{ authorized: true, writeAdapterReady: false }` alone returns `DATASET_NOT_READY`.
Provide granted scopes, completed datasets and `coverageReady: true` in the
fixture to demonstrate `WRITE_ADAPTER_NOT_READY` specifically. Never manufacture
those positive flags in the production integration merely to pass the gate.

## Source records

`resolveSource(field, source)` returns an immutable descriptor.
`resolveFieldValue(field, record, options)` reads and normalizes one field:

- Mirror product fields accept a `SnapshotProduct` row with its `data` JSON.
- Mirror variant fields accept that same row and an explicit `variantId`; the
  target must match exactly one entry in `data.variants`. A `Variant` projection
  alone does not contain prices or other canonical variant data.
- Mirror inventory items, levels and locations accept their Prisma rows.
  Updated timestamps map from `sourceUpdatedAt`.
- Mirror quantity fields accept an `InventoryQuantity` row whose `name` must
  match the field. Shopify quantity reads accept a level with a `quantities` array.
- `source: "shopify"` accepts the appropriate Shopify node. Missing selections
  fail as `FIELD_VALUE_MISSING`; missing is never silently treated as null.
- Variant count reads require `variantsCount.precision === "EXACT"`.

Callers must query records using verified tenant and snapshot ownership. Source
resolution does not fetch records, authenticate a shop, or prove data freshness.

## Execution boundary

Run shared field validation at submission, planning and immediately before
mutation execution. The executor still owns authorization, tenant/target checks,
leases, revisions, inventory compare-and-set, handle uniqueness, shop-specific
limits, mutation adapters, and Shopify user-error reconciliation. This field
library neither sends mutations nor grants scopes. Current read-only app scopes
will correctly prevent edit validation until write scopes are actually granted.

### Remaining merchant-write boundaries

1. Before mutation execution, independently recheck the verified installation's
   active status and generation, target shop ownership, credential validity and
   actual granted Shopify scopes. A previously authorized request or a stored
   `authorized: true` flag is not sufficient.
2. Apply final field-specific Shopify constraints, including string lengths,
   tag limits, currency/shop rules and current resource state. The current value
   rules and application payload limits are a foundation, not a complete
   merchant-write validator. Handle Shopify user errors through the gateway.
3. Capture original values in a durable journal before writes can become
   undoable. Restoration needs fresh authorization, conflict/revision checks
   against the expected post-edit state, and a verified restoration adapter.
   The declaration `undo: true` and the availability flag do not implement this.

All nine field modules contain implemented library code. Unit/regression tests
and read-only checks against published mirror records have passed. These checks
do not certify live mutation integration, complete Shopify write validation,
crash recovery or safe undo; those execution boundaries remain separate work.

## Declarative source catalogue and logical coverage

`sources.js` only declares mappings and checks dataset readiness; it does not
extract or validate values. Record extraction lives in `resolve.js` and value
validation remains in `normalize.js` / `validate.js`.

```js
import {
  getFieldSource, requiredDatasets, checkSourceCoverage, DATASETS,
} from "./fields/index.js";

const source = getFieldSource("variant.price");
// source.dataset === "variants"; source.storage.dataset === "products"
const required = requiredDatasets(["product.title", "variant.price"]);
// ["products", "variants"]
const readiness = checkSourceCoverage(["product.title", "variant.price"], {
  products: true, variants: true,
});
```

`getFieldSource` accepts fixed IDs and actual resolved descriptor objects. It
returns `null` for unknown or copied references; `requireFieldSource` throws.
Listing and coverage helpers return frozen arrays. Coverage must be a
server-trusted projection of one published tenant/generation. Only own properties
whose values are exactly `true` count. Fixed-only legacy calls check dataset
readiness; dynamic calls additionally check scoped per-definition coverage below.
Neither form authenticates the tenant or creates mirror coverage evidence.

Logical `variants` data is physically stored inside complete product snapshots;
logical `locations` data is physically stored as `inventory_locations`.
`getCapabilities(..., { completedDatasets })` accepts the current physical names:
completed `products` implies its validated full variant set, and completed
`inventory_locations` implies logical `locations`. The logical coverage helper
requires explicit logical flags; the backend must build this trusted projection.
Capabilities now require every declared source dependency, including inventory
items, levels and quantities for a named quantity field.

The existing `inventoryLevel.available` field refers to **one named quantity
row**. It is not a product/variant aggregate. `inventory.available` and Google
Shopping fields remain unregistered until their location policies and verified
ingestion sources exist. The exported dataset names reserve identifiers, not
claims that datasets have been ingested. No generic Google GraphQL object is
invented. Existing Shopify aggregate totals remain read-only source values.

## Trusted dynamic metafield metadata

```js
import {
  createMetafieldRegistry, resolveField, requireResolvedField, listResolvedFields,
  makeMetafieldId, parseMetafieldId,
} from "./fields/index.js";

// This projection must come from authenticated Shopify definitions or an
// equivalently verified shop-scoped backend cache, never request JSON.
const registry = createMetafieldRegistry("example.myshopify.com", [{
  owner: "product", namespace: "custom", key: "material",
  name: "Material", type: "single_line_text_field",
}]);
const context = { shopId: "example.myshopify.com", metafields: registry };
const material = resolveField("metafield:product:custom.material", context);
// material.type === "text"; material.source.requires === ["products", "metafields"]
const available = listResolvedFields(context);
// 48 descriptors: 47 fixed + this one dynamic definition.
```

Owner identities are `product` or `variant`, with Shopify owner types `PRODUCT`
and `PRODUCTVARIANT`. Namespace and key use bounded alphanumeric/underscore/hyphen
parts. Use concrete namespaces returned by Shopify; `$app` is an API shorthand,
not an expanded definition identity. Malformed IDs, duplicate definitions,
unsupported types, accessor properties, extra capability flags, and registry
impostors are rejected. Registry internals cannot be mutated after creation or
reconstructed by serializing a registry. Rebuild a registry from verified backend
definitions. Both lookup and listing reject registries from another shop.

Supported type projections are `single_line_text_field`, `multi_line_text_field`,
`number_integer`, `number_decimal`, `boolean`, and `list.single_line_text_field`
(mapped to this engine's `string_list`). Other types fail closed. This factory
accepts the explicit projection above plus optional `definitionVersion`, not raw
GraphQL response objects; the backend must normalize owner and type metadata.
The optional third factory argument binds metadata to a published
`{ generation, snapshotId }` for dynamic coverage checks.

The registry validates shape, not provenance, authorization, Shopify validation
rules, definition freshness, resource-subtype constraints or value coverage.
It creates no Shopify definitions and does not fetch or write values. All dynamic
value capabilities—including filtering, export and editing—remain disabled until
their access and adapters are implemented and verified. A decimal metafield type
is metadata, not permission to reuse the non-negative Money validator: metafield
value validation must honor its own definition-specific rules. Current value
normalizers, execution changes and record extraction remain fixed-field APIs.
The coverage helpers accept actual backend-created dynamic descriptors, not
unresolved dynamic ID strings or serialized copies.

## Per-definition dynamic coverage

`requiredDatasets(references)` accepts a bounded mixture of fixed IDs, canonical
objects and actual resolved descriptors. Dynamic references must be the immutable
objects returned by this process's backend registry/resolver. Clones and JSON
copies are rejected; rebuild registries from verified backend definitions.
Mixed-shop references and conflicting versions of the same definition are rejected.

```js
import {
  createMetafieldRegistry, resolveField, requiredDatasets, checkSourceCoverage,
} from "./fields/index.js";

// Illustrative values only. In production, obtain this context independently
// from authenticated installation state and the current published snapshot.
const expected = {
  shopId: "example.myshopify.com", generation: "generation-1", snapshotId: "snapshot-1",
};
const registry = createMetafieldRegistry(expected.shopId, [{
  owner: "product", namespace: "custom", key: "material",
  type: "single_line_text_field", definitionVersion: "definition-1",
}], { generation: expected.generation, snapshotId: expected.snapshotId });
const material = resolveField("metafield:product:custom.material", {
  shopId: expected.shopId, metafields: registry,
});
const required = requiredDatasets(["product.title", material]);
// ["metafields", "products"]

// Mirror-service output only, never a frontend-supplied readiness claim.
const coverage = {
  ...expected,
  datasets: { products: true, metafields: true },
  definitions: {
    [material.id]: {
      ...expected, complete: true,
      ownerType: "PRODUCT", namespace: "custom", key: "material",
      shopifyType: "single_line_text_field", definitionVersion: "definition-1",
    },
  },
};
const result = checkSourceCoverage(["product.title", material], coverage, expected);
// ready: true, requiredDefinitions: [material.id], missingDefinitions: []
```

Dynamic coverage requires all of the following:

- A registry binding to the expected generation and snapshot, plus a nonempty
  `definitionVersion`. Unbound metadata can still be resolved or used to list
  dependencies, but cannot establish dynamic coverage readiness.
- An independently supplied expected shop/generation/snapshot context. Envelope
  scope mismatches or stale descriptor bindings throw stable `FieldError` codes.
- Every required dataset marked complete, and an individual definition entry
  with own `complete: true` and matching shop, generation, snapshot, owner type,
  namespace, key, Shopify type and definition version.

Missing/incomplete or mismatched definition entries return `ready: false` with
`missingDefinitions` and detailed `definitionFailures`. These complement the
existing `required` and `missing` dataset arrays. All results are immutable.
The flat dataset-flag form and result shape remain unchanged for fixed-only calls.
Fixed-only callers can optionally use the scoped envelope with an expected context.

Definition versions must be authoritative backend revisions or fingerprints that
change when coverage-relevant definition identity/schema changes, including
deletion/recreation. A stable namespace/key or definition ID alone is not a
version. The producer must account for relevant validation, access and constraint
changes and verify its metadata remains current. This library compares tokens;
it cannot independently prove Shopify provenance or that a supplied version is
fresh. Rebuild bound registries when the published snapshot changes.

The Mirror Engine must produce `complete` from durable, validated per-definition
ingestion, including explicit absence of values for covered resources. Seeing
one value or completing the overall metafields dataset is insufficient. The
per-definition ingestion/coverage producer is still separate work; these pure
checks do not create database coverage records or enable dynamic filter/edit
adapters. Dynamic value capabilities remain disabled even when coverage passes.

## Verification

```sh
npm --prefix web run test:fields
npm --prefix web run fields:check -- --shop YOUR-STORE.myshopify.com
```

The compatibility check uses read-only, repeatable-read queries against an
explicitly named installation's published snapshot. It reports only counts and
error codes. Empty datasets are reported as skipped and cannot certify mappings.

Shopify contract references (API version 2026-10):

- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductUpdateInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductVariantsBulkInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryItemInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/enums/ProductStatus
- https://shopify.dev/docs/api/admin-graphql/2026-10/scalars/Money
- https://shopify.dev/docs/api/admin-graphql/2026-10/objects/MetafieldDefinition
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsRemove


## Type normalization and field validation (v4)

`types.js` exposes immutable type metadata through `getFieldType`,
`requireFieldType`, `listFieldTypes`, `isComparableType`, `isSortableType`, and
`isSearchableType`. Existing types remain supported; `text_array` is accepted
alongside `string_list`. Type traits do not grant field capabilities.

`normalize.js` exports `normalizeValue(type, input)` for representation parsing.
It accepts signed decimals, canonicalizes negative zero, and checks integer
strings using BigInt before converting to a safe Number. Decimal fractions
must be strings: floating point numbers and exponent strings are rejected.
Generic text and string-array items preserve whitespace and normalize Unicode
to NFC. Arrays retain duplicates; no CSV parsing or implicit coercion occurs.
Null passes through so validation can decide nullability. HTML and opaque IDs
retain their source representation; dates retain fractional precision.
Application resource bounds and invalid-character checks still apply.

`normalizeFieldValue(id, input)` also applies declared transformations such as
title trimming, handle casing, status casing and tag trimming. It does not enforce
enum membership, nullability, minimums or uniqueness. Those rules live in the
canonical field contract and are enforced by `validateFieldValue`.

```js
import { normalizeValue } from "./normalize.js";
import { validateFieldValue, requireValidFieldValue, validateFieldValues } from "./validate.js";
normalizeValue("decimal", "-0010.500"); // "-10.5"
validateFieldValue("variant.price", "-10.5"); // BELOW_MINIMUM
requireValidFieldValue("variant.price", "0019.9900"); // "19.99"
validateFieldValues([{ field: "product.title", value: "Summer" }]);
```

Validation defaults to `purpose: "edit"`. Read-only extraction must explicitly
use `purpose: "read"`; the source resolver does this. Other purposes are filter,
import, export and undo. Declared capability restrictions remain enforced;
this API does not verify live installation, scopes, coverage, write adapters or
undo journals. Missing values, forbidden nulls, invalid enums and numeric bounds
have distinct codes. `requireValidFieldValue` throws `FieldValidationError`.
Batch results are bounded and immutable and do not echo rejected input values;
malformed batch shapes throw, while invalid field values become results.

The public barrel preserves `normalizeValue(fieldId, input)` for existing callers
as validated read normalization. Use `normalizeTypedValue(type, input)` from the
barrel or `normalizeValue(type, input)` directly from `normalize.js` for new code.
Operation/change validation now lives in `operations.js` and delegates field
value checks to `validate.js`; import these APIs from the public barrel.
All 47 fields, aliases and source mappings remain, including UNLISTED status.

These contracts do not certify complete Shopify mutation validation. Final
Shopify field limits, currency rules, fresh authorization, execution checks and
conflict-safe undo still require their dedicated integration boundaries.

## Resolved dynamic value validation

`normalizeFieldValue`, `validateFieldValue`, `requireValidFieldValue`,
`validateValue`, and batch entry `field` references accept canonical IDs,
canonical descriptor identities, or genuine resolved descriptors. Resolve a
dynamic ID with `requireResolvedField(id, { shopId, metafields: registry })`
using the backend's verified shop and registry, then pass that exact descriptor:

```js
const field = requireResolvedField(dynamicId, { shopId, metafields: registry });
const normalized = normalizeFieldValue(field, rawValue);
const result = validateFieldValue(field, rawValue, { purpose: "read" });
const batch = validateFieldValues([{ field, value: rawValue }], { purpose: "read" });
```

Raw dynamic IDs, object copies, serialized descriptors and arbitrary objects are
rejected by the shared resolver identity check before their properties are read.
Fixed descriptors use the canonical contract; dynamic descriptors supply their
resolved type and declared constraints without borrowing product price or tag
rules. Generic dynamic string lists preserve blank items and duplicates unless
their trusted contract explicitly forbids them. This checks the current generic
representation contract, not every Shopify definition-specific validation rule.

`purpose: "read"` means value suitability only and grants no data access. Current
dynamic descriptors still deny edit, filter, import, export and undo; the default
edit purpose therefore returns `NOT_SUPPORTED`. Type validity never establishes
installation authorization, definition freshness, tenant access or coverage.
The caller must resolve against the trusted shop and separately check current
per-definition coverage before fetching or using values in queries or edits.


## Shopify metafield contracts (2026-10)

Definition projections may include `ownerType`, `validations: [{name, value}]`
and `access: {admin, storefront, customerAccount}` from Shopify. The registry
validates their shape, matches product/variant owner types, and freezes a detached
contract. Missing validations are unknown; only an explicit complete `[]` means
no additional rules. Value validation returns `METAFIELD_VALIDATIONS_REQUIRED`
when the list was omitted. Type-only normalization remains available.

Supported rules are numeric min/max, decimal max_precision, text min/max,
choices, and list.min/list.max for compatible types. The six-type subset also
enforces single-line text, UTF-8 payload bounds, the 128-item text-list limit,
and exact decimal type range/precision. Application input limits can be stricter
than Shopify limits. Unknown or incompatible rules, including regex, are rejected
with `UNSUPPORTED_METAFIELD_VALIDATION`; they are never ignored or executed as JS.
Metadata-only discovery still does not enable filters, writes, exports or undo.

`checkMetafieldAccess(descriptor, "read" | "write", trustedContext)` separately
checks installation authorization, matching shop, owner scopes and Admin access.
Both PRODUCT and PRODUCTVARIANT require read_products for reads or write_products
for writes; write_products implies read access. Storefront/customer flags cannot
grant Admin access. Concrete app--<id> namespaces require the verified current
app numeric ID as `context.appId`; merchant access settings do not grant another
app access. Missing Admin access is denied. Recheck definition freshness, coverage,
resource subtype constraints and adapter capability separately before live use.

No definition-fetch adapter or live merchant permission test is implemented here.
The backend must project the complete current Shopify definition and derive a new
version when its type, validations, access or applicability changes. Do not accept
these projections or app IDs from frontend requests. Unsupported owners and types
remain rejected. No definitions or values were created/changed by these tests.

References: [types](https://shopify.dev/docs/apps/build/metafields/list-of-data-types),
[validation options](https://shopify.dev/docs/apps/build/metafields/list-of-validation-options),
[limits](https://shopify.dev/docs/apps/build/metafields/metafield-limits),
[Admin access](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/MetafieldAdminAccess),
[app ownership](https://shopify.dev/changelog/posts/public-access-for-app-owned-metafields-and-metaobjects-is-now-disabled).
