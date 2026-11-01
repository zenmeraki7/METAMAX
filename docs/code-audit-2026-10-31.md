# Code audit — 2026-10-31

Follow-up: findings 1–5 are implemented locally and verified; see [the fix and rollout report](first-five-audit-fixes-2026-10-31.md). The new refresh-request migration is applied to the configured application database; see [deployment verification](catalog-refresh-deployment-20261031.md). Findings below describe the audited pre-fix behavior.

Findings 6–10 are also fixed locally; see [implementation, validation and coordinated rollout requirement](next-five-audit-fixes-2026-10-31.md). These changes are not deployed and require no new migration.

Reviewed the current working tree, including existing uncommitted changes. No application code was changed during the original audit. This is a review of implementation and wiring, not a certification of the deployed database or Shopify configuration.

## Validation and scope

- Backend: `npm test` — 1,034 passed, zero failed, one TODO (1,035 total).
- Frontend: `npm --prefix web/frontend run test:products` — 38 passed; `npm --prefix web/frontend run test:ui` — 17 passed.
- The first backend run could not connect to loopback HTTP servers in the restricted environment. The rerun with loopback access passed.
- Additional direct probes reproduced the opaque history authentication failure, dropped multi-product webhook fan-out, UNLISTED rejection, boolean coercion, and the secondary reconciliation repository's commit after a failed acknowledgment. These probes used real modules with controlled storage responses; they did not contact production services.
- Traced application bootstrap, HTTP authentication, catalog queries, compiler/resolver/executor boundaries, canonical field policies, selections/approval/dispatch, ingestion/reconciliation, export source authorization, history routes/repository boundaries, and corresponding frontend flows.
- No live database query plans, production role grants, migration state, or production traffic measurements were collected. Shopify AI Toolkit is installed, but its documentation search failed with `fetch failed`; this review therefore does not claim external API schema verification.

P1 means high priority. P2 means a correctness, integration, or efficiency issue to address after the urgent defects. Findings in secondary or blocked paths are labeled explicitly.

## Findings

### 1. [P1] One webhook receipt suppresses all but the first product in a fan-out

`web/privacy.js:210` calls `recordMutationEvent` once per affected product, always passing the same `eventId`. In `web/mirror/reconciliation-service.server.js:82`, an existing receipt immediately returns before inspecting the per-product `sourceKey` or writing its journal entry.

The first product commits the event receipt; every subsequent product is treated as a duplicate event. A retry also exits early, so the missing products cannot be recovered by redelivery. A direct probe with three `product_ids` produced exactly one catalog-change write.

**Fix:** Process the event receipt and the entire bounded fan-out atomically, or persist durable event membership/progress and deduplicate individual product entries separately. Test partial failures and redelivery as well as successful multi-product events.

### 2. [P1] Webhooks after publication have no running reconciliation consumer

Webhook handlers durably mark products dirty, but the running reconciliation path is the import phase in `web/mirror/catalog-sync-steps.server.js:68` (and the legacy import path). `web/mirror/reconciliation-service.server.js:217` only permits writes to a RECONCILING generation. Bootstrap in `web/index.js` starts import, export, history maintenance, and operation supervision; it does not start the standalone catalog worker. Even the standalone repository only selects INGESTING/RECONCILING destinations.

Once an import is PUBLISHED, a subsequent product update/create/delete remains dirty until another full import supplies a staging generation. Initial-sync repair does not schedule another import when an installation already has a job (`web/services/catalog-import.server.js:60`). Catalog responses continue reporting READY, so new, edited, and deleted Shopify products can remain stale indefinitely.

**Fix:** Wire a durable incremental publication flow. It must preserve consistent generations, revalidate installation authority, and publish a new revision after applying pending changes. Do not simply allow uncoordinated writes to published rows.

### 3. [P1] History routes reject valid authentication contexts

`web/middleware/filter-auth.server.js:38` deliberately issues `Object.freeze({})`, retaining session identity in a private WeakMap. `web/edit-history/history.routes.js:77`, `:160`, and `:200` instead read `authContext.shopId || authContext.shop`.

A valid captured session therefore returns 401 for the list without querying the database. Detail/change requests pass an undefined shop parameter and cannot return the intended tenant's rows. A direct probe reproduced the list failure using the actual authentication implementation.

**Fix:** Resolve tenant identity through the authentication/repository capability. Add an app-mounted test using the real opaque-context capture, rather than a mock authentication result containing public shop properties.

### 4. [P1] Inventory webhooks cannot resolve products from the mirror populated by this importer

`web/privacy.js:65` and `:78` find affected products through `mirror.variants.inventory_item_id`. Neither the bulk snapshot query nor the complete-product query requests inventory-item identity, and neither `catalog-writer.server.js` nor `catalog-batch-writer.server.js` writes that relation. The nullable foreign key points to internal `mirror.inventory_items.id`, while the webhook lookup supplies the Shopify numeric inventory-item ID.

For the production product/variant import, the relation stays null. Inventory events consequently resolve no products, even though catalog filtering and projection expose `variant.inventoryQuantity`. Additionally, lookup failures are caught and converted into an empty result, and the caller records the event receipt as processed (`web/privacy.js:223`). A transient database error is therefore acknowledged as successful handling rather than retried.

**Fix:** Persist a reviewed tenant/generation-scoped Shopify inventory-item mapping, use the correct internal/external identity translation, and propagate retryable lookup failures. If that mapping is unavailable, durably schedule a broader refresh rather than acknowledge an empty fan-out as complete.

### 5. [P1, currently masked by finding 3] History HTTP routes bypass the installation and permission boundary

The route queries in `web/edit-history/history.routes.js:96`, `:163`, and `:204` scope only by shop. They bypass the existing history repository's independent `authorizeHistoryRead`, current installation resolution, and protected lifecycle checks. The changes endpoint does not join the operation to check `purge_requested_at`, either.

The safer implementation already exists in `web/edit-history/history-pages.server.js:24` and the repository read methods: it resolves `{shopId, installationId}`, verifies the active tenant, checks independent read permission, rejects purged operations, and rechecks authority before returning. Merely fixing the empty-context access would expose a route that still omits these controls. This is an installation/lifecycle authorization gap, not a demonstrated cross-shop SQL leak in the current broken route.

**Fix:** Mount repository-backed reads with verified runtime credentials and an authenticated installation resolver. Preserve the parent-operation purge check for changes.

### 6. [P1, secondary repository] Failed acknowledgment commits mirror mutations

`web/mirror/reconciliation-repository.server.js:237` applies product-family deletes/replacement and `:276` saves the generation receipt before attempting the conditional catalog-change acknowledgment. At `:321`, `applied.rowCount !== 1` returns SUPERSEDED normally. The transaction helper consequently commits those earlier writes.

If a lease expires during the database work, the final `clock_timestamp()` check can fail after the earlier lease check passed. A controlled probe returned SUPERSEDED while committing five deletes and a revision receipt. The main import service acknowledges before writing and does not share this ordering defect; this secondary repository is exported but not wired into bootstrap.

**Fix:** Conditionally acknowledge before mirror writes within the same transaction, or throw on a failed acknowledgment so the entire transaction rolls back. Test expiry during writes, not only expiry before transaction entry.

### 7. [P1 for multi-tenant scaling] Every mirror transaction takes a global exclusive table lock

`web/mirror/transactions.server.js:30` and `:48` acquire ACCESS EXCLUSIVE on `mirror.publications` for every transaction, including event receipt recording, dirty-product claims, failures, staging writes, and ingestion checkpoints. Catalog readers acquire ACCESS SHARE on that same relation (`web/mirror/publication-service.server.js:37`).

Thus an import or webhook for shop A blocks catalog reads and mirror writes for shop B. Conversely, a large all-matching selection holds the read barrier for its whole materialization transaction, blocking webhook persistence and ingestion for every shop. SQL statement timeouts do not bound the total duration of the multi-page selection transaction. The single-product writer also performs one awaited INSERT per variant while holding this barrier (`web/mirror/catalog-writer.server.js:102`), increasing the blocking window.

**Fix:** Replace the global barrier with a reviewed per-shop publication protocol and acquire it only for operations that need it. Preserve snapshot-before-lock ordering guarantees. Batch variant writes for single-product reconciliation, and put an overall time/cancellation budget on materialization. Measure cross-shop read/write contention with real PostgreSQL.

### 8. [P2] UNLISTED is accepted by ingestion/UI but rejected by canonical validation

`web/mirror/catalog-validation.js:58` and `web/controllers/catalog.controller.js:34` accept UNLISTED, and the toolbar and product renderer offer/display it. `web/fields/constraints.js:376` defines product status as only ACTIVE, DRAFT, ARCHIVED; that enum feeds read, filter, and write policy.

A direct probe accepted an UNLISTED snapshot but rejected the same value as a canonical filter operand with FIELD_INVALID_VALUE. Selecting Unlisted in the toolbar therefore fails after the request parser accepts it. Canonical snapshot consumers can also reject an otherwise ingested row.

**Fix:** Align the server-owned enum, ingestion, frontend capabilities, and supported mutation contract; add an end-to-end status test through the actual canonical validator.

### 9. [P2] Status polling runs a full catalog query and exact count

`web/services/catalog-query.server.js:284` compiles status as `catalog: true`, page size 1. `web/filters/execute.js:401` then projects a product (including variant aggregates), loads summary metadata, and executes the full matching `count(*)` at `:402`, only to return generation/revision/status. The mounted legacy controller does the same. The frontend polls every 30 seconds when READY.

Page size 1 does not bound the count scan. Each otherwise idle browser creates repeated catalog-size-dependent database work and holds the shared publication barrier while doing it. The count endpoint also unnecessarily loads product projections.

**Fix:** Add a dedicated authenticated, publication-verified metadata read for status, and a dedicated authorized count execution mode. Keep exact counts off unchanged-revision polling.

### 10. [P2] Live history statistics and selected CSV still use demo records

`web/frontend/pages/HistoryPage.jsx:82` always renders `HistoryStats` from `demoHistory`. At `:95`, Export selected CSV filters `demoHistory`, even when the table contains real operations and shows a live connection banner. Actual operation IDs will generally not match demo IDs, yielding an empty or unrelated export.

`web/frontend/hooks/useHistoryOperations.js:30` and `:35` also replace both a legitimate empty history and a failed fetch with demo history, hiding the distinction between no operations and an unavailable backend.

**Fix:** Derive live statistics and CSV records from live state. Put examples behind explicit demo mode; render empty and error states separately.

### 11. [P2] History pagination loses records at both API and frontend boundaries

The list query in `web/edit-history/history.routes.js:112` orders solely by `created_at`, and its cursor predicate is only `created_at < cursor`. Operations sharing the boundary timestamp are skipped; there is no ID tie-breaker. The changes route has a LIMIT but no continuation cursor.

Separately, `web/frontend/hooks/useHistoryOperations.js` fetches only `/api/history` once and ignores the returned `pageInfo`. Its pagination/filtering operates over that one default 25-record page. Older operations are unreachable, and filtered history CSV covers only the loaded subset while being presented as filtered history.

**Fix:** Use the existing signed `(timestamp, id)` repository cursors, wire server continuation into the hook, and define whether search/export operates on one page or the complete server-side result.

### 12. [P2] Filter picker advertises unsupported dynamic fields and hides supported tags

`web/frontend/components/products/ProductsToolbar.jsx:219` offers arbitrary syntactically valid metafield IDs. The SQL compiler's physical resolver accepts only installed canonical bindings; dynamic fields have no registered SQL mapping. These picker-generated requests always fail, regardless of a metafield adapter's metadata.

Conversely, `:28` decides tag availability from a React test global or `window.__TAGS_VERIFIED__`. `ProductsPage` never supplies `tagsVerified`, and there is no application assignment to that window property. Normal production use therefore hides a backend-installed tag field, while UI tests enable it automatically.

**Fix:** Supply a trusted authenticated capability list containing only fields/operators with verified mappings and coverage. Drive tag and metafield options from that list and test production defaults.

### 13. [P2] Invalid boolean input becomes a valid but different targeting predicate

`web/frontend/data/products.filters.js:178` maps any boolean token other than exact lowercase `true` to false. The boolean IN/NOT IN control is free text. A direct probe of `filterOperand('boolean', 'in', 'true, typo')` returned `[true, false]`.

The backend receives valid booleans and cannot reject the original typo. An intended narrower predicate can silently become all boolean values. `True` also becomes false.

**Fix:** Parse a closed boolean vocabulary with explicit validation errors, or use a bounded multi-select. Never repair an unknown boolean token by changing it to false.

### 14. [P2] Sync-source endpoint fabricates healthy status and fresh synchronization times

`web/app.js:77` returns products, collections, inventory, and metafields as healthy with `lastFullSyncAt: new Date()` on every request. It does not inspect durable job state or dataset coverage. The running importer certifies products/variants, not all those datasets.

A failed, stale, or unimplemented source consequently appears healthy and freshly synchronized. This obscures the coverage failures that filtering correctly rejects and misleads the settings/data screens.

**Fix:** Report persisted installation-specific job/coverage state and actual completion timestamps. Mark unsupported datasets unavailable rather than healthy.

## Additional database improvements

1. `web/services/field-authorization.server.js:113`, `:133`, and `:76` reload session/shop authority repeatedly for each field. `web/fields/resolve.js:1326` authorizes fields sequentially; validation, compilation, catalog projection, and execution repeat this process. Batch current installation/scope facts per decision stage on an appropriate protected connection, retaining fresh checks at stage boundaries. Do not turn this optimization into a cross-request authorization cache.
2. `web/services/mirror-schema.server.js` performs full PostgreSQL catalog verification again for every compilation via `revalidateMirrorSqlSchema`; `web/filters/compile.js:304` calls it. Measure that overhead together with session-storage queries on a realistic remote database. Prefer a versioned migration/schema fence if it can preserve the fail-closed physical mapping guarantee. Do not remove verification without replacing its authority.

## Boundaries that held in this review

- Fixed frontend installed field IDs matched backend installed bindings in a direct comparison.
- The compiler's validated filters and executable queries use private provenance maps; structurally parsed/copied AST objects do not become executable grants.
- SQL values are parameters and SQL identifiers originate from server-owned registries; no browser-to-raw-SQL execution route was established in the reviewed mounted catalog/filter paths.
- Shop and generation predicates remain outside user boolean expressions, including correlated variant predicates.
- The main ingestion writer persists mirror rows and its checkpoint in one transaction. Completion verifies durable checkpoint counts and EOF before the normal caller transitions to reconciliation.
- The main reconciliation service conditionally acknowledges the observed revision before mirror writes in the same transaction, with fencing and retryable transaction conflict handling.
- Export source code independently checks export field authorization and approved target coverage; it does not treat a selection hash alone as permission.

## Recommended order

Fix event fan-out, post-publication reconciliation, and inventory event durability first. Replace history route SQL with the existing authorized repository reads; fixing only the opaque-context access is insufficient. Then repair the secondary acknowledgment transaction, reduce global lock contention, align canonical/UI contracts, and make polling and pagination efficient. Add targeted regression cases for the reproduced gaps before relying on the currently passing broad suite.
