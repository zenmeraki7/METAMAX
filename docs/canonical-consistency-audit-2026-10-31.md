# METAMAX canonical consistency audit — 2026-10-31

This report assesses the current working tree, including existing uncommitted fixes. No application source was changed. This is an evidence-backed audit pass, not certification of complete repository-wide semantic coverage.

## Executive audit summary

- Files discovered: 623 outside excluded trees; complete inventory in canonical-inventory.json.
- Files inspected by automated content scan: 533, 102520 lines. Reading content for automated scanning is not a manual semantic audit. The annexes list files reviewed semantically and partial-read limitations; an exact aggregate count of fully reviewed files was not measured.
- Excluded: .git, node_modules, .shopify, .wrangler, .audit, dist, .vscode. Logs, archives, images, environment/local files and extensionless files were inventoried but not uniformly content-inspected. Secrets were not inspected. Zero read failures among selected text files.
- Tools: PowerShell, rg, Node.js test runner, Vite build, repository import/reference searches, Shopify AI Toolkit schema validator, official Shopify documentation search. Three cooperating specialist agents plus the primary reviewer handled the five requested perspectives.
- Evidence-backed findings: 3 (two High, one Medium). No demonstrated Critical, spelling, case-only or plural-only defect. No unverified suspicion promoted to a finding. One unresolved test-contract discrepancy is separately disclosed below. Duplicate reported findings: zero; two candidate false positives rejected.
- Release priority: SEM-001 blocks reliable catalog refresh; WORKER-001 blocks enabling bulk/undo execution for large selections; API-001 blocks the advertised mixed-entity Match any experience.
- Not verified: live Neon physical schema and deployed migration history, real Shopify requests, Redis delivery/recovery under faults, real concurrent database reproduction of the publication race, complete source-by-source semantic inspection, full browser interaction, all import/export/schedule/history lifecycle permutations. No production guarantees are claimed.

## Findings

| ID | Severity | Category | File | Actual identifier/behavior | Expected contract | Impact |
|---|---|---|---|---|---|---|
| SEM-001 | High | Semantic/state machine | web/mirror/catalog-sync-steps.server.js:70 | VERIFIED means skip reconciliation | New dirty revisions retain a recoverable pre-publication path | Webhook between verification and publication stalls refresh |
| WORKER-001 | High | Worker/semantic | web/workers/operation.worker.js:67 | attempts increments per successful batch | Failure retry budget must allow successful continuation | 201-item commands exhaust eight claims after 200 items |
| API-001 | Medium | UI/API contract | web/frontend/components/products/ProductsToolbar.jsx:166 | Match any across product and variant fields | Group capabilities must agree with compiler correlation rules | Supported-looking UI action fails with FIELD_UNSUPPORTED_OPERATION |

Detailed producer/consumer snippets, exact locations, triggering schedules, correction scope, dependencies and regression tests appear in the annexes below. SEM-001 and WORKER-001 are confirmed source-contract conflicts; their complete runtime failures were not reproduced. API-001 was reproduced through genuine parsing and compilation with trusted fixture dependencies; browser interaction was not reproduced.

## Canonical inventory and cross-layer drift matrix

These are reviewed boundary mappings, not assertions that all possible consumers match.

| Concept | Frontend | API | Service | Worker | Database | Status / authority |
|---|---|---|---|---|---|---|
| Shop identity | No client authority | Opaque authContext | resolveShop | shopId / shop_id | mirror.shops.id is myshopify domain | MATCH in inspected paths; middleware/filter-auth.server.js and prisma/tenant.prisma |
| Installation lifecycle | Not browser-issued | Server resolved | installationVersion | installation_version; history uses installationId | installation_version / history installation_id | INTENTIONAL TRANSFORMATION at inspected execution adapter; no assumption these are globally interchangeable |
| Product identity | Shopify product GID | product.id | productId/resourceId with explicit adapter | resource_id | shopify_id text versus internal id bigint | INTENTIONAL TRANSFORMATION; fields/sources.js distinguishes physical identity |
| Variant identity | variant.* registry | Trusted field ID | correlated variant scope | Not independently audited | variants.shopify_id / internal id | MATCH in reviewed filter bindings; worker use NOT VERIFIED |
| Generation | snapshotId | generationId -> snapshotId | generationId | generationId | generation_id | INTENTIONAL TRANSFORMATION in catalog projection |
| Coverage revision | publishedRevision | coverageRevision -> publishedRevision | live coverage check | verified publication evidence | coverage_revision | MATCH in reviewed checks; transition MISMATCH SEM-001 |
| Field ID | product.* / variant.* | registry field IDs | canonical resolver and SQL bindings | approved product SET whitelist | explicit physical columns | MATCH for reviewed mappings; group composition MISMATCH API-001 |
| Registry/schema version | capability response | Server-owned | metamax_mirror_v1, metamax_sources_v1, mapping_v1 | generation evidence | mirror_schema_version/source_contract_version/mapping_version | MATCH in inspected source; live physical schema NOT VERIFIED |
| Retry budget | Not applicable | dispatch | max_attempts=8 | attempts + LIMIT 25 + RETRY | job_commands/job_items | MISMATCH WORKER-001 |
| Queue/run identity | Not authority | Server token | durable run lookup | runId as notification, DB claim authoritative | execution/run/generation bindings | MATCH in inspected sync path; other queue permutations NOT VERIFIED |
| Mutation resource | Not authority | approved instructions | product field binding whitelist | resource_id plus history transport | history resource/request records | inspected identity adapters only; actual Shopify sends NOT VERIFIED |
| Contract version/fingerprint | Not authority | approved contract | trusted immutable payload | approved contract lookup | execution/history constraints | NOT VERIFIED end-to-end across all operations |

Intentional aliases include ne -> neq, processedCount -> processed, totalCount -> total, and In Progress -> Running. They are explicit adapters, not naming defects. Prisma uses PostgreSQL pg adapters in the active runtime; the architecture description was not treated as proof of actual implementation.

## Verification

- Backend npm test: 1,047 tests reported, 1,045 passed, one failed, one TODO, zero skipped. Log: canonical-backend-tests.log.
- Failure: services/sync-sources.test.js:22 expects lastFullSyncAt=null when job_status=UNKNOWN. sync-sources.server.js:45 calculates timestamp from covered, independently of recognized job_status; result retains 2026-10-01T01:02:03.000Z while status is unavailable. This is a reproduced test/implementation contract conflict. It is not classified as a production bug because retaining a valid prior completion timestamp may be intentional. Decide the intended response contract, then align code/test. Do not silently call this suite green.
- Frontend UI tests: 27/27 pass. Product tests: 41/41 pass. Logs: canonical-ui.log and canonical-products.log.
- Frontend build initially refused absent SHOPIFY_API_KEY as designed. Repeated with a nonsecret audit placeholder key: success. Log: canonical-build-with-key.log. This establishes compilation, not a deployable real-key artifact.
- Targeted filter suite 52/52 and execution/history/export suite 11/11 pass (subsets overlapping backend suite; not additional distinct coverage).
- Shopify configured version: web/shopify.js specifies 2026-10. Toolkit search failed with fetch failed. Official documentation lookup was used as fallback. Seven extracted static GraphQL operations from bulk-sync.server.js, shopify-catalog-source.server.js and product-creator.js validated against 2026-10. The anonymous bulk query was given an audit-only operation name to validate the combined document. currentBulkOperation is deprecated but valid; this is not a confirmed malfunction. Other dynamically built operations and Polaris event contracts were not comprehensively validated.
- Official references: https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate and https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/queries . These establish provider terminology, not proof of complete compatibility for every operation.
- Automated relative-import candidate scan produced only query-suffixed ESM fixture imports and imports inside frontend test-source strings after inspection; no missing production import established. This simple regex scan does not establish Linux case correctness.
- No live database test was run; existing historical audit logs were not counted as current verification.

## Prioritized regression plan

1. Inject webhooks after VERIFIED commit and before phase evidence commit, and after transition to PUBLISHING. Run normal recovery until publication and verify the newest revision without mutating an existing published generation.
2. Run real journaled 201+ item bulk edits and undo to completion; independently verify bounded pre-send failure and abandoned lease retries.
3. Render product.vendor + variant.price and select Match any. Assert explicit prevention/explanation or defined successful correlated semantics; preserve supported same-entity OR.
4. Resolve the UNKNOWN sync-source status timestamp test contract; test all recognized and unknown statuses.
5. For unverified boundaries, use authoritative fixture/schema tests covering payload case and singular/plural names, enum case, Prisma mappings, resource GID kinds, tenant/installation distinction, version conflicts, unknown fields and forbidden aliases. These are proposed gap tests, not claims that defects exist in each category.

## Detailed evidence annexes

# Catalog synchronization audit notes

## SEM-001 — Verified generations cannot reconcile webhooks received before publication

Severity: High. Category: Semantic/state-machine contract. Confidence: Confirmed source contract; full runtime race not reproduced.

Evidence:
- `web/mirror/catalog-sync-steps.server.js:70` returns ADVANCE immediately when generation status is VERIFIED, bypassing dirty scan.
- Same file lines 81–84 verifies generation in a transaction and then returns ADVANCE. Publication happens in a later bounded worker invocation, lines 88–98.
- `web/mirror/sync-run-service.server.js:346–349` marks generation VERIFIED.
- Same file lines 375–383 rejects publication if any tenant catalog_changes row is dirty: `invalid("New mutations arrived after verification")`.
- `web/mirror/reconciliation-service.server.js:98–105` records webhook revisions and sets dirty=true; reconciliation commit at line 248 requires staging status RECONCILING.
- `web/mirror/sync-run-repository.server.js:66` and `web/mirror/sync-run-db-adapter.server.js:12` define RECONCILING -> PUBLISHING only. The adapter commitStep at lines 209–229 has ADVANCE, DEFER, COMPLETE; no rewind transition.
- `web/mirror/catalog-execution.server.js:89–93` refuses the RECONCILING ADVANCE evidence if dirty appears before recordStep, creating an additional window where phase remains RECONCILING but generation is already VERIFIED.
- `web/mirror/catalog-sync-recovery.server.js:21,33–34` classifies later phases SAFE_TO_RETRY. `web/mirror/sync-recovery-repository.server.js:274` clears uncertainty and releases lease without modifying phase or generation status. Recovery does not re-enter reconciliation.

Expected contract: new validated webhook work must be reconciled before a consistent staging generation publishes; a transient webhook during normal operation must leave a recoverable path, while published generations stay immutable.

Reproduction schedule:
1. Finish ingestion and reconciliation, committing generation VERIFIED.
2. Let execution recordStep advance to PUBLISHING.
3. Commit a legitimate product webhook for that shop, making its catalog_changes row dirty.
4. Run publication: publication rejects with New mutations arrived after verification.
5. Run recovery and publication again: phase remains PUBLISHING and dirty work remains; error repeats.
Alternatively insert webhook between generation verification and recordStep; evidence rejects ADVANCE, and next reconcile immediately skips VERIFIED.

Impact: ordinary merchant changes in this window stall the active refresh and prevent publication; automatic recovery retries cannot clear the condition. Existing published mirror can remain stale. This is availability/staleness, not demonstrated cross-tenant leakage.

Smallest safe correction: introduce a fenced, transactional path reopening VERIFIED staging to RECONCILING and invalidating/rebuilding coverage before publication when dirty work is detected, with a compatible execution phase rewind; alternatively make verification/publication and phase evidence atomic under the publication barrier. Do not simply remove the dirty check.

Regression: a database integration test should inject a webhook at both transaction boundaries above, run normal worker/recovery to completion, assert new product revision is present in published snapshot and no published generation was mutated. Test idle no-webhook publication separately.

Inspected source contents: mirror/reconciliation-service.server.js, reconciliation-repository.server.js, reconciliation.server.js, catalog-sync-steps.server.js, ingestion-writer.server.js, catalog-writer.server.js, catalog-batch-writer.server.js, catalog-validation.js, shopify-catalog-source.server.js, bulk-operation-runner.server.js, transactions.server.js, jsonl-ingestion.server.js, sync-run-service.server.js, catalog-sync-recovery.server.js, workers/sync.worker.js. Targeted sections/references inspected: catalog-execution.server.js, sync-run-repository.server.js, sync-run-db-adapter.server.js, sync-recovery.server.js, sync-recovery-repository.server.js, integration/sync-db-adapter.js. Prisma/migrations inventoried but not individually audited. No runtime tests run by this specialist; no source modifications.

Confirmed compatible boundaries: durable ingestion checkpoint/count checks precede transition in normal JSONL caller; reconciliation acknowledgment matches observed revision/fence/lease and mirror write shares transaction; queued sync notification only supplies runId and authoritative claim comes from database. No case/singular/plural typo finding established in inspected sources.


---

# Execution, history, import and export audit notes

## WORKER-001 — Successful batches exhaust the execution retry budget

Severity: High. Category: Semantic / worker contract. Confidence: Confirmed source contract; end-to-end runtime failure not reproduced.

Authority and conflicting producer/consumer:

- `web/services/job-dispatch.server.js:56–57` initializes every bulk-edit/undo command with eight attempts:

```js
INSERT INTO mirror.job_commands(...,attempts,max_attempts,...)
VALUES($1,$2,$3,$4,'PENDING',0,8,...)
```

- `web/workers/operation.worker.js:67` increments the command's attempts for **every** acquired claim:

```sql
fence=fence+1,attempts=attempts+1
```

- `web/workers/operation.worker.js:75–77` reads at most 25 eligible items for that claim:

```sql
WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY') AND attempts<8
AND(next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ORDER BY id LIMIT 25
```

- `web/workers/operation.worker.js:129–136` treats successful continuation as command RETRY:

```js
const state=counts.remaining===0?'SUCCEEDED':waiting?'RETRY':'FAILED';
```

- `web/workers/operation.worker.js:51–54` then marks a due command FAILED with `review_required: true` when attempts reaches max_attempts, before another claim can process its remaining items.

Root cause: a bounded failure-attempt budget also counts ordinary successful pagination progress. The dispatcher has no 200-target admission limit: lines 78–101 materialize the entire approved selection and assert rowCount equals selected_count.

Trigger: dispatch an approved selection of 201 products with successful, fast Shopify operations. Invoke processOne eight times: each handles 25 items and returns PARTIAL; 200 products are changed. The ninth invocation's claimNext sets command FAILED/review_required and returns no claim; the 201st item remains PENDING. The same limit affects undo. Crashes or actual failures can lower the number of products completed.

Smallest safe correction: distinguish successful continuation from failure/crash retries; retain bounded failure handling without spending the failure budget for each successful batch. Do not merely increase eight to another fixed constant.

Affected dependencies: dispatch command initialization, worker claim/finalization transitions, operation supervisor polling and worker integration tests. No identifier or persisted schema rename is required unless a separate counter is introduced.

Regression: an actual worker integration fixture with at least 201 approved items must reach SUCCEEDED with every item SUCCEEDED, every send journaled once, and no review_required flag; independently show repeated pre-send failures and abandoned leases still exhaust their bounded budget. Include a multi-batch undo fixture.

Production reachability limitation: `web/index.js:90` constructs the operation supervisor without a worker. `web/workers/operation-supervisor.server.js:26,42` refuses to tick/start without a worker. Therefore the current default server has not installed this mutation runtime; the defect applies when the issued BulkExecutionRuntime is installed or used by integration consumers. Missing default writer wiring was not reported separately because it may be deliberate fail-closed composition.

## Verification

Executed from `D:\newmeta\web`:

```
node --experimental-test-module-mocks --test workers/operation.worker.test.js edit-history/tests/undo-recovery.test.js export/export-worker.test.js
```

Result: 11 tests passed, zero failed or skipped. The operation.worker unit suite tests dispatch and rejection of unjournaled transport, not multi-batch execution. No deterministic fake-DB reproduction was added; such a mock would need to emulate the SQL attempt and item state transitions and would not independently validate PostgreSQL behavior.

## Inspected files

Read fully:

- web/services/bulk-execution-runtime.server.js
- web/services/history-execution-adapter.server.js
- web/services/job-dispatch.server.js
- web/services/operation-instructions.server.js
- web/services/import-preview.server.js
- web/workers/operation.worker.js
- web/workers/operation.worker.test.js
- web/workers/operation-supervisor.server.js
- web/export/export-worker.server.js
- web/edit-history/history-execution.server.js
- web/package.json

Read partially:

- web/edit-history/history-lifecycle.server.js through line 170
- web/services/catalog-import.server.js through line 200

Searched for affected consumers and inspected matching lines:

- web/index.js
- web/prisma/execution.prisma
- web/prisma/migrations/20261028000300_execution_reliability/migration.sql
- web/edit-history/integration/worker-execution.js

No application source modifications. No external Shopify API contract claims or verification performed in this sub-audit.


---

# Filter and frontend canonical audit notes

## API-001 — Mixed product/variant “Match any” is advertised but rejected

Severity: Medium. Category: Contract / Semantic. Confidence: Confirmed, including direct runtime reproduction of API parsing plus genuine semantic validation/compiler rejection. Browser interaction was not exercised.

Locations:
- web/frontend/components/products/ProductsToolbar.jsx:160–166
- web/frontend/data/products.filters.js:91–93
- web/services/catalog-query.server.js:136–137
- web/filters/validate.js:203–204

Observed UI contract:
```jsx
<s-option value="any">Match any filters</s-option>
```
The same toolbar lists installed product and variant fields:
```js
export const installedFilterFields = canonicalFilterFields.filter(([id]) =>
  id.startsWith("product.") || (id.startsWith("variant.") && id !== "variant.productId")
);
```

Producer transformation:
```js
children.push(group(match === "all" ? "AND" : "OR", advanced));
```

Authoritative compiler contract:
```js
if (kind === "variant") return variantExists([node]);
if (node.operator !== "AND") throw new FieldError(C.UNSUPPORTED_OPERATION, "Mixed product/variant OR or NOT requires an explicit correlation scope");
```

Root cause: field-level capability metadata gates individual operators, but neither it nor the UI describes the compiler's group-level correlation restrictions. Individual fields are supported; the offered composition is unsupported.

Runtime impact: choosing vendor and variant price with Match any produces FIELD_UNSUPPORTED_OPERATION. The catalog request fails and the page displays unavailable/error state rather than matching products. This is a frontend/backend capability disagreement; the compiler correctly fails closed instead of guessing quantifier semantics.

Deterministic triggering query object:
```js
{
  match: 'any',
  filters: JSON.stringify([
    {field:'product.vendor',operator:'eq',value:'Acme'},
    {field:'variant.price',operator:'gt',value:'10'}
  ])
}
```

Runtime reproduction completed without writing source: imported parseCatalogQueryParams, createFilterService, createFieldService and createMirrorCoverageService. Used genuine production field registry and source bindings, trusted test shop alpha.myshopify.com, published COMPLETE products/variants coverage at generation123/revision123, and permitting test authorization. Passed the exact payload above through parseCatalogQueryParams, service.validateFilter and service.compileFilter.

Observed output:
```json
{"code":"FIELD_UNSUPPORTED_OPERATION","message":"Mixed product/variant OR or NOT requires an explicit correlation scope","ast":{"version":1,"root":{"kind":"group","operator":"AND","children":[{"kind":"group","operator":"OR","children":[{"kind":"condition","field":"product.vendor","operator":"eq","value":"Acme"},{"kind":"condition","field":"variant.price","operator":"gt","value":"10"}]}]}}}
```

Smallest safe correction: block unsupported mixed entity Match any combinations in the toolbar with an explanatory message, and ideally expose group correlation capabilities from the server. Alternatively implement an explicit quantifier contract with corresponding compiler tests; do not simply remove the compiler guard.

Affected dependencies: ProductsToolbar.jsx, products.filters.js or server capabilities DTO if restrictions are metadata-driven; frontend toolbar/catalog tests; services/catalog-query.test.js; compiler tests if supported semantics change. No migration is necessary for the UI-only correction.

Regression test: render the toolbar with genuine supported product.vendor and variant.price capabilities, select both conditions and Match any, then verify deliberate prevention/explanation or defined successful end-to-end semantics. Also test product-only and variant-only OR remain usable.

## Verification

Command, run from D:\newmeta\web:
```text
node --experimental-test-module-mocks --test filters/__tests__/compile.test.js filters/__tests__/production-bindings.test.js services/catalog-query.test.js
```
Result: 52 tests, 52 passed, 0 failed, 0 skipped. Existing test at web/filters/__tests__/compile.test.js:782–787 explicitly asserts rejection of mixed OR and variant NOT.

## Canonical mappings investigated

- ne → neq: explicit intentional frontend/API adapter.
- generationId → snapshotId: intentional catalog API projection.
- coverageRevision → publishedRevision: intentional catalog API projection.
- processedCount → processed, totalCount → total: explicit history frontend adapters.
- In Progress → Running: explicit history frontend status alias.
- Compiler queries require object-identity provenance, authenticated shop/generation binding, fresh authorization and verified physical bindings. No additional demonstrated defect established in inspected paths.

False positive rejected: compiler emits SELECT 1 plus predicate parameters for catalog_status, but executor intentionally does not execute that statement, so no PostgreSQL bind mismatch occurs.

## Files directly inspected

- web/fields/canonical.js (registry preamble/entities)
- web/fields/normalize.js (first 250 lines)
- web/fields/resolve.js (field-service constructor excerpts)
- web/fields/sources.js (binding compatibility versions)
- web/filters/semantics.js
- web/filters/bindings.js
- web/filters/compile.js
- web/filters/execute.js (execution path and status/count branch)
- web/filters/validate.js (predicate compiler and service excerpts)
- web/filters/ast.js (limits search)
- web/filters/__tests__/compile.test.js (fixtures and mixed-OR test)
- web/filters/__tests__/catalog-fixture.js
- web/services/catalog-query.server.js
- web/services/filter-engine-runtime.test.js (fixture preamble)
- web/frontend/services/products.api.js
- web/frontend/services/shopifyData.api.js
- web/frontend/hooks/useProductCatalog.js
- web/frontend/hooks/useProductSelection.js
- web/frontend/hooks/useProductFilters.js
- web/frontend/hooks/useProductCapabilities.js
- web/frontend/hooks/useHistoryOperations.js
- web/frontend/hooks/useHistoryFilters.js
- web/frontend/hooks/useSettingsDashboard.js
- web/frontend/data/products.filters.js
- web/frontend/components/products/ProductsToolbar.jsx (first 230 lines)
- web/frontend/components/products/ProductRow.jsx
- web/frontend/components/history/HistoryStats.jsx
- web/frontend/pages/ProductsPage.jsx (first 145 lines)
- web/frontend/utils/historyCsv.js

This is a scoped audit, not a claim that every file in these directories was read in full. No source files were modified.

