# History execution and item completion

The existing issued `createHistoryExecution()` / `assertHistoryExecution()` authority remains in place. Its worker contract now includes `execute`, `inspectItem`, and `verifyItemCompletion`. Inspection reads durable requests and evidence; it does not infer success from transport results.

Completion delegates to the history repository on the worker's supplied transaction. It reloads the authoritative plan and current approval, checks installation and execution ownership, and compares the entire persisted item and approval membership with the request envelope and every change. Each change must have the exact shop, installation, job, item, operation, mutation, attempt, resource and field identity; matching intended-value and mutation-plan fingerprints; terminal VERIFIED/MATCHED evidence; and an owned AFTER snapshot with authenticated observation metadata. Missing, additional, duplicate or mixed-attempt fields reject completion. Other unresolved item requests prevent admission and completion.

The worker updates only PENDING, RETRY or RUNNING items and requires exactly one returned row. Verification, immutable engine snapshot confirmation and the fenced item update share one transaction. Verification failure retains the item for recovery; ownership loss stops processing. Recovery inspection uses the same repository authority rather than an existential verified-request query.

`dispatchGuard` travels as a separate `beginDispatch` option. The existing dispatch authorization hook invokes it on the same transaction connection before admission and again before commit. It is absent from request serialization and fingerprints. The worker guard checks the exact installation, command, fence, lease token, cancellation state, current approval and current write permission. It does not open a pre-dispatch guard transaction or invoke heartbeat renewal while holding history's command lock.

The unapplied split-runtime-roles migration grants the operation worker only additional evidence metadata columns and the inert edit-operation lock column for completion. It grants no history values or history writes. Existing database deployments need this migration before enabling this path.

The separately pasted `web/services/shopify-verified-writer.server.js` remains an exact standalone copy, without route imports or executor wiring.

Validation: 1,193 backend tests pass, including 64 focused completion, execution, repository and worker tests. PostgreSQL schema/integration checks could not start because Docker Desktop's Linux engine pipe is unavailable. The new SQL grants, transaction integration scenario and real PostgreSQL concurrency remain unverified; no production migration or credential provisioning was performed.
