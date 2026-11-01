# CT-103–105: execution capabilities, publication fencing and row imports

The journal data model can retain richer resource and value identities than an installed writer can execute. The installed adapter now admits one resource and one execution item per request, with multiple supported fields and explicit VALUE/SET semantics. The current writers cover eight Product properties and five ProductVariant properties. Inventory, absent values, mixed resources and mixed items are rejected at installed-adapter admission and again before transport dispatch. Generic journal normalization and database integrity continue to represent richer historical records.

Approval coordinates include the required versioned `HISTORY_EXECUTION_CAPABILITIES` contract: request shape, directly supported job kinds, operation handoffs and supported resource types. Its resource metadata includes exact mutation, observation, verification and inverse-write capabilities. Approval rejects incompatible resource/operation combinations. Retrieval compares the complete capability contract and writer digest again. Existing approvals with older coordinates require reapproval; old import previews without versioned canonical resource mappings require a new preview.

All participating paths use `lockPublication()` with the same shop advisory key. Selection, merchant dispatch and worker ownership acquire its shared barrier; publication, coverage and reclamation acquire its exclusive barrier. The helper's ACCESS SHARE table lock protects against DDL only. History now acquires the same shared barrier before installation and execution reads and locks the exact publication row FOR SHARE while checking the pinned generation, coverage and mapping. Dispatch consumption repeats the exact publication-coordinate check. A replacement publication therefore prevents a new send under the old approval.

History admission remains SERIALIZABLE. Acquiring an advisory lock does not refresh its transaction snapshot. The publication row's locking read detects an intervening row update and forces transaction rollback/retry, following PostgreSQL's [transaction isolation rules](https://www.postgresql.org/docs/current/transaction-iso.html). Ordinary READ COMMITTED callers read protected state after obtaining the barrier. No database transaction is held across the Shopify network request; ambiguous sends remain recovery work.

`20261101000100_history_publication_fence` adds an inert `_history_lock` column and grants only that column's UPDATE privilege to enable publication row locks for the history, merchant and operation-worker profiles. It grants no permission to alter publication coordinates. Apply it after the existing role split and before enabling this adapter version. No migration has been applied by this change.

Row-import execution uses the existing configured bulk execution runtime:

```js
const preview = await importPreviewService.createImportPreview({ authContext, records });
// After the merchant reviews the exact preview hash:
const approved = await importPreviewService.approveImportPreview({
  authContext,
  previewId: preview.previewId,
  expectedPreviewHash: preview.previewHash,
});
const receipt = await runtime.dispatchService.dispatchImport({
  authContext,
  contractId: approved.contractId,
});
```

The preview resolves internal selection IDs and Shopify IDs into distinct canonical Product GIDs inside the pinned selection transaction. It persists mapping version 1 and each row's canonical field/value map. Approval consumes the stored reviewed preview, including its resource mappings. Dispatch reloads that immutable approval, rechecks current tenant, installation and write authority, and joins every row's GID to the exact pinned selection while materializing job items. Cardinality must match before the outbox event commits. Idempotent dispatch also reauthorizes the caller.

The operation outbox and worker accept the import job kind. Each worker item resolves its own approved updates rather than applying a uniform bulk update. The History Repository independently compares that item with its exact approved import row. Imports then use the existing durable BEFORE evidence, transactional dispatch authorization, consumed one-use handoff, single mutation invocation, authenticated AFTER evidence, field-by-field completion, failure/retry, recovery scanner and finalization path. Verified import changes remain available to the existing history-based Undo authority; a missing field or unverified source cannot authorize an inverse write.

This row-import path is distinct from `catalog-import.server.js`, which ingests a Shopify export into the mirror. Approval does not itself execute either service. The host must configure the existing runtime's durable plan, observation, evidence and authorization providers; the default application does not gain a fabricated provider. The separately pasted V4 writer remains isolated and is not used by this handoff.

Unit regressions exercise canonical row mapping, rejected aliases and unmapped targets, unsupported execution shapes, capability-coordinate drift, exact dispatch materialization, idempotent authorization, import outbox scheduling and import worker batching. PostgreSQL scenarios cover preview-to-dispatch mappings, real import history/completion, publication barrier contention and old SERIALIZABLE snapshot rejection. Those database scenarios require the disposable Docker PostgreSQL harness and are not certified by the unit suite.

Validation on this checkout: all 1,217 backend tests pass and Prisma validation passes. The PostgreSQL/schema harness could not start because Docker Desktop's Linux engine pipe is unavailable. The migration and database concurrency scenarios remain unapplied/unverified.
