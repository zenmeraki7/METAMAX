# Backend interface contract standard

Every backend interface declares five things. A declaration may live beside the implementation or in an explicitly linked method record; it does not require shared function names or a central implementation module.

| Required declaration | Content |
| --- | --- |
| Input schema | Accepted fields, types, bounds, defaults, optionality and rejected overrides. Distinguish caller data from server-resolved values and transaction capabilities. |
| Output schema | Success, absence, conflict and error variants; identifier and timestamp representations; sensitive values; what a successful return actually proves. |
| Authority requirements | Who may call, the independently loaded records and coordinates checked, where validation occurs, and which gateway or repository owns it. |
| Lifecycle preconditions | Required states, expiry policy, installation identity, generation/snapshot rules, lease/fence requirements and transaction ownership. |
| Durable side effects | Rows, state transitions, evidence, outbox/recovery work and external effects; identify the atomic transaction boundary. State explicitly when there are none. |
| Retry and uncertainty | Required for mutation participants: idempotency identity, safe retry boundaries, single-use dispatch behavior, ambiguous remote/commit outcomes and independent recovery. |

An interface that authorizes, schedules, dispatches, verifies, completes or recovers a mutation is a mutation participant even when it never calls Shopify itself. Pure internal helpers inherit their owner's authority requirements but must declare any additional preconditions or effects. An input/output type alone is not the complete contract.

Use this declaration when adding or changing an interface:

```text
Interface: owningModule.method
Input schema:
Output schema:
Authority requirements: authoritative source -> comparison -> enforcing boundary
Lifecycle preconditions:
Durable side effects: transaction owner -> atomic changes -> external boundary
Retry and uncertainty: idempotency / ambiguous outcome / durable recovery owner
```

For interfaces outside mutation paths, mark the final item not applicable and explain any ordinary retry restrictions in lifecycle or effects. Never describe a callback's intended behavior as implemented enforcement: identify the repository/gateway check and its tests. Unknown or unverified behavior is a contract gap, not an implied guarantee.

The records below cover the critical mutation pipeline. They are not a claim that every existing backend interface has already been inventoried. Other interfaces must adopt this standard when changed; existing sync contracts remain with their owners in [the sync worker contract](sync-worker-contract.md) and [the sync repository contract](sync-run-repository-contract.md).

## Shared schemas and boundaries

### Catalog sync live progress

Owners: `createCatalogImportService.status(session, id)` and `.current(session)`
in `web/services/catalog-import.server.js`; exposed by authenticated
`GET /api/mirror/sync/:id` and `GET /api/mirror/sync`.

Input: server-loaded Shopify session; status additionally requires a validated
opaque import ID. Browser shop/generation/count values are never accepted.
Output: existing job DTO (or null where permitted), with nullable decimal-string
`progress.productsSaved`. This is the number of committed nondeleted product rows
in that job's exact shop and generation at the query snapshot. It is not JSONL
lines, a Shopify export estimate, or a declaration that staging data is published.
No total product count is invented; existing percentage remains explicitly
estimated until the job succeeds and its generation is PUBLISHED.

Authority: service authentication reloads the session and current product-read
scope before and after the read; current-job discovery joins the live installation.
The query binds authenticated shop and stored job generation. `readProgress` owns
a READ ONLY transaction, a transaction-local tenant GUC for product RLS, a 5-second
statement timeout, commit/rollback, and client release. No publication or mutation
lock is acquired. Calls do not authorize any filtering or mutation against staging.
Status reads have no durable effects; current-job discovery preserves its existing
initial-sync repair behavior when no job exists. Read-response loss may be retried;
this change adds no Shopify calls or writes and changes no mutation retry policy.

Counting uses the existing tenant/generation product scope and is not a cached
estimate. Its cost grows with that generation's rows; this change does not certify
merchant-scale polling performance. The UI shares one serial poller, uses a
3-second active interval, slower idle discovery, visibility pausing, bounded
backoff and timeouts, and preserves the last confirmed values on transient errors.

- IDs crossing service boundaries are strings; bounded counts are safe integers; service timestamps are ISO strings. PostgreSQL rows remain internal to repositories.
- `SelectionSnapshot` is the frozen DTO returned by [selection-snapshot.server.js](../web/services/selection-snapshot.server.js): snapshot/shop/installation IDs, generation/coverage/mapping coordinates, operation and operation ID, target mode, status, selected count/hash, registry/definition metadata, and frozen/expiry timestamps. It contains no product array or SQL capability.
- `ExecutionAuthority` is the immutable projection defined in [execution-contract.server.js](../web/services/execution-contract.server.js). Its mandatory coordinates and database mappings are documented in [CT-106–120](ct-106-120-authority-and-lifecycle.md). It is metadata, not a bearer permission grant. The final verified contract hash is projected outside its own hashed payload.
- A worker claim carries the exact shop, installation, command ID, fence, lease token and expiry. A field evidence identity additionally includes execution item, operation, mutation, attempt, resource GID and field ID. Private claims, dispatch tokens and transaction clients must never become HTTP receipts or queue payload authority.
- Factory-injected resolvers, authorization providers and evidence providers are trusted backend dependencies. Business methods still use the owning durable repository/gateway to verify their results; a permissive callback is not a substitute for field verification or claim ownership.

## Selection

Owner: [selection.server.js](../web/services/selection.server.js).

**Input schema.** `createSelection` accepts authenticated context, selection mode, bounded explicit product IDs or validated filter, bounded exclusions, supported operation, optional operation ID, bounded lifetime/item limit and optional abort signal. It rejects browser shop/client overrides. `withSelectionTransaction` accepts the same options and a trusted callback receiving `{client, snapshot: SelectionSnapshot}`. `getSelectionSnapshot` accepts `{authContext, snapshotId}`. `getSelectionItems` adds numeric-string `after` and integer `limit` from 1–1000.

**Output schema.** Creation returns `SelectionSnapshot`; persisted lookup returns the same DTO or `null`. `withSelectionTransaction` returns the callback's result, not necessarily a snapshot. Membership reads return `{productIds: string[], hasMore: boolean, nextAfter: string|null}`. Invalid, unauthorized or expired scopes fail rather than yielding a readiness grant.

**Authority requirements.** Authentication resolves the shop; the protected catalog query verifies field/filter permissions and physical coverage. The service independently reads publication/generation coordinates and captures the current installation. Stored reads match that installation. All membership SQL remains parameterized and tenant/generation scoped.

**Lifecycle preconditions.** Materialization runs inside a protected publication transaction. The callback receives that transaction and must not commit, release or retain it. The selection becomes APPROVED only after exact membership, count and hash are frozen. Stored reads reject expired or incompatible snapshots.

**Durable side effects.** Creation inserts the selection and membership and freezes its metadata atomically. The callback's phase checkpoint joins that transaction. Protected catalog dependencies may maintain generation retention. Membership reads do not create a new selection.

**Retry and uncertainty.** Caller retries must not treat a previously returned DTO as authorization. Scheduled creation and checkpoint advancement share one transaction; recovery reloads the occurrence phase after a lost commit response. A queued selection token cannot replace fresh authorization or publication verification.

## Approval and approval reads

Owner: [approval.server.js](../web/services/approval.server.js), with [approval-coordinates.server.js](../web/services/approval-coordinates.server.js).

**Input schema.** `approveContract` accepts authenticated context, shop/snapshot IDs, supported operation and validated payload, plus an optional caller-owned transaction and bounded approval lifetime. An optional approving actor must match the independently resolved actor. Execution coordinates/authority are server-owned. Imports accept the exact reviewed preview identity/hash and load its stored mappings. Live and evidence-only reads accept an explicit query client and shop/contract IDs; the live getter has no caller-controlled historical-mode option.

**Output schema.** Approval returns contract/snapshot IDs, revision, operation, APPROVED status, hash, actor and timestamps, frozen payload and `ExecutionAuthority`. Reads return a persisted record with frozen payload and authority, or `null`. Historical reads are explicitly marked `evidenceOnly: true` and cannot pass live execution-context checks.

**Authority requirements.** Approval resolves and authorizes the actor before and after drafting. Coordinates come from the stored selection/current installation and trusted registry/writer metadata. Retrieval verifies the canonical hash and immutable headers. Live retrieval also revalidates current coordinates and adapter compatibility; evidence retrieval verifies immutable historical coordinates for reconciliation, not another send.

**Lifecycle preconditions.** Approval requires an unexpired approved selection of the same operation and installation, exact installed field/operation support and compatible targeting policy. The contract transitions DRAFT to APPROVED in the same transaction. New mutation authority expires; historical evidence reads do not extend or renew it.

**Durable side effects.** Approval inserts and freezes the execution contract and, for imports, associates the reviewed preview with it atomically. Read methods change no approval, expiry or permission.

**Retry and uncertainty.** A lost approval response is not permission to replace its immutable contract or infer dispatch. The caller must recover through its durable preview/occurrence references. A historical read cannot bypass the live getter by supplying an option flag. Adapter incompatibility requires compatible execution or explicit revalidation.

## Merchant dispatch

Owner: [merchant-gateway.server.js](../web/security/merchant-gateway.server.js); the public compatibility module retains `createJobDispatchService`.

**Input schema.** `dispatchBulkEdit`, `dispatchUndo` and `dispatchImport` accept authenticated context, approved contract ID, optional caller-owned merchant transaction and audit actor label. Undo also requires the approved source command ID. Browser shop overrides are rejected. Legacy caller idempotency keys cannot split an approved operation: the service derives identity from shop, operation kind and contract ID.

**Output schema.** The frozen receipt contains command/edit-operation IDs, contract ID, command status, deterministic idempotency key, materialized item count and `existing`; existing durable results are included when present. Undo adds restore IDs. An internally owned transaction commits dispatch bookkeeping before returning. With an external client, the receipt remains provisional until the caller commits; neither receipt proves successful Shopify execution.

**Authority requirements.** The issued merchant gateway resolves the trusted tenant, checks the current installation, independently reloads the approval and compares its normalized authority, then checks current write permission. Both existing-command branches perform the same current authorization. External transaction clients are verified as merchant-profile clients.

**Lifecycle preconditions.** Hold the shared publication barrier and exact active installation row `FOR SHARE` while reading/materializing the approved selection. Variant policy/count and import row mappings must match the contract. External clients must be dedicated merchant connections in explicit READ COMMITTED READ WRITE transactions, with nonzero statement/lock timeouts bounded to 30s/2s. Pools, autocommit, incompatible settings and concurrent dispatch on one connection are rejected. The service owns a savepoint for its changes, rolls back to it on error and releases it on success; the caller owns the outer commit/rollback, awaits every operation and retains the client/locks until completion. Rollback failure requires outer rollback/discard. The service commits only transactions it opens.

**Durable side effects.** Command, edit aggregate, exact item instructions, outbox event, Undo association when applicable, and audit event commit together. Import materialization preserves each canonical resource and its own updates. The service does not publish Redis work or invoke Shopify.

**Retry and uncertainty.** Database uniqueness identifies one logical dispatch. On an ambiguous commit, retry by the same approved contract and reload the winner, with current authorization. Never infer that a missing HTTP receipt means no durable command exists.

## Worker claim and processing

Owner: [worker-gateway.server.js](../web/security/worker-gateway.server.js); `createOperationWorker` and its issued-interface assertion remain intact.

**Input schema.** `claimNext`/`processOne` accept a bounded worker ID and lease duration (5–300 seconds). Transport, approval, authorization and issued History Execution dependencies are server-injected. A batch processes at most 25 due items.

**Output schema.** Claiming returns a private database claim or `null`. Processing returns a tagged receipt: empty, stale claim, progress/partial, succeeded, failed, uncertain outcome, review required, recovery required, recovery-persistence failure or finalization pending. Count summaries declare `countUnit: resources` and distinguish successful, failed, pending, uncertain and canceled resources. Terminal mixed commands persist `PARTIAL`; unfinished batches return `IN_PROGRESS` while retaining retry eligibility. Terminal execution and finalized history are separate facts.

**Authority requirements.** The issued operation-worker gateway fences each owned transaction with the exact current installation, command, fence, token, lease and cancellation state. New mutations independently reload the live approval/authority and current resource write permission. An issued history executor verifies field evidence. Queued data and possession of a command ID are insufficient.

**Lifecycle preconditions.** Claim only eligible supported command kinds. Heartbeat renewal is fenced; loss of ownership stops new work and protected acknowledgments. Verified items take the local evidence-completion path before acquiring new mutation permission or constructing a Shopify client. Incompatible live authority suspends further execution for review.

**Durable side effects.** Claims/renewals, immutable engine BEFORE snapshots, fenced item updates, outcome counts/audit, command disposition and finalization tasks are durable. Item success requires complete field verification and exactly one eligible item update in the same owned transaction. External writes occur only through History Execution.

**Retry and uncertainty.** Pre-send failures have bounded durable retry eligibility. Stale-claim errors stop immediately, including inside recovery inspection. Verified results may be completed locally without replaying mutations. Ambiguous sends remain uncertain; independently durable scanning and finalization repair dropped recovery scheduling or acknowledgments. Review flags are not automatically cleared by another claim.

## History admission, handoff and execution

Owners: [history-repository.server.js](../web/edit-history/history-repository.server.js), [history-execution.server.js](../web/edit-history/history-execution.server.js), and the installed [execution adapter](../web/services/history-execution-adapter.server.js).

**Input schema.** `prepareRequest` accepts authenticated operation/mutation references, current claim and 1–64 normalized entries containing intent, attempt, BEFORE evidence and resource-family identity. The installed adapter further requires one exact item/resource and supported VALUE/SET fields. Current product/variant writers expose no atomic conditional inverse mutation, so new Undo approvals, dispatches and writes fail closed; already verified evidence and outcome reconciliation remain available. `beginDispatch(request, {dispatchGuard})` keeps the transaction guard outside serialized request data. `consumeDispatch` accepts exact request/attempt/claim references and the private one-use token/handoff. `execute` accepts `{claim, item, workerId, shopifyClient, approved, dispatchGuard}`; the worker supplies its fenced `captureBefore` persistence extension.

**Output schema.** Admission returns persisted request state and field receipts. Dispatch authorization returns a private handoff/token; consumption returns durable consumption state. Execution returns persisted `VERIFIED`, `CONFLICT` or `OUTCOME_UNKNOWN` with operation identity and verified values when available. These are distinct from command-wide completion.

**Authority requirements.** The repository independently resolves tenant/installation, loads the immutable plan, compares the full approval authority, verifies current claim/field membership/BEFORE provenance and installed writer support, and checks live authorization. The transaction-scoped guard and existing dispatch authorizer use the same dispatch transaction. Family admission prevents overlapping or unresolved resource-family writes.

**Lifecycle preconditions.** Intent and BEFORE evidence commit before dispatch authorization. Worker-facing execution requires `dispatchGuard`; direct repository admission still has mandatory durable dispatch authorization. Current publication and expiry checks precede new handoff consumption. The one-use handoff must be durably consumed before one remote mutation invocation. AFTER observations retain all original binding coordinates. Guard functions are not fingerprinted or serialized, and no separate pre-dispatch guard transaction substitutes for this boundary.

**Durable side effects.** The repository owns history transactions: operation/request/change records, protected snapshots, authorization token hashes, consumption, authenticated outcomes, observations, recovery tasks and counters. The executor performs the remote mutation between durable history transitions; database and Shopify commits are not atomic.

**Retry and uncertainty.** A proven pre-send conflict can enter verified-no-write state. A lost consumption commit response must not trigger a send. A timeout, malformed acknowledgement or lost outcome commit response cannot justify another send; persist uncertainty and reconcile evidence. Failure to persist uncertainty/recovery is an explicit operational failure, with independent scanning required. Do not retry the whole remote execution path based on transport success or changed-value heuristics.

## History inspection and item completion

Owners: [item-completion.server.js](../web/edit-history/item-completion.server.js) and History Execution.

**Input schema.** `inspectItem({claim, item})` loads server-owned request references. `verifyItemCompletion({tx, claim, item, approved, result})` requires the supplied worker transaction; it does not acquire or commit a substitute transaction.

**Output schema.** Inspection returns `NOT_DISPATCHED`, `VERIFIED`, `UNCERTAIN` or `CONFLICT` from persistent evidence. Completion returns `true` only after complete verification; missing, extra, duplicate or mixed-identity evidence throws. A single verified change never verifies an entire multi-field item.

**Authority requirements.** Resolve tenant and exact live command ownership, independently load the immutable historical approval/plan, authorize evidence inspection/completion, and compare persisted item instructions and every approved member. Each field uses the complete shop/installation/job/item/operation/mutation/attempt/resource/field identity and matching terminal AFTER evidence.

**Lifecycle preconditions.** This is an evidence-only boundary. Expiry or publication replacement prevents new mutations but does not erase a verified result or require another write grant to finish local bookkeeping. Installation and worker ownership fencing remain mandatory.

**Durable side effects.** Verification reads evidence in the caller's transaction. The worker, not this predicate, performs the exact fenced item update and immutable engine snapshot confirmation in that same transaction. Inspection owns its bounded read/authority transaction and sends nothing remotely.

**Retry and uncertainty.** Retry local completion from persisted evidence after an ambiguous local commit; inspect status before changing item disposition. Never use this interface to authorize a new send. Stale ownership exits immediately; incomplete evidence remains recovery/review work.

## Mutation and command finalization

Owners: [history-lifecycle.server.js](../web/edit-history/history-lifecycle.server.js), [job-finalization.server.js](../web/edit-history/job-finalization.server.js), and [operation-finalization.server.js](../web/security/repositories/operation-finalization.server.js).

**Input schema.** `finalizeMutationAttempt` identifies one operation/mutation/attempt with authenticated context. `finalizeExecutionJob` accepts independently authenticated context, execution job ID and expected tenant coordinates. The worker-facing `finalize` alias performs command-wide finalization; it does not choose the last item's request. The ledger worker accepts bounded worker identity and optional command/shop filters.

**Output schema.** An incomplete result is `{completed:false}`. Mutation completion identifies that attempt only. Job completion identifies the job, aggregate state and updated operation count. Ledger reconciliation returns finalized, pending/retry, stale or review outcomes; it acknowledges completion only after History and required Undo reconciliation succeed.

**Authority requirements.** Independent recovery authentication/permission, exact installation-bound command and immutable historical approval are loaded again. Successful items require complete request membership and terminal evidence; unresolved or inconsistent history cannot be acknowledged.

**Lifecycle preconditions.** Command-wide finalization requires a terminal engine command and no unresolved remote evidence. Mutation-attempt completion alone cannot terminate an operation or command. All associated operations are considered. A command with no write history can finish local bookkeeping without inventing mutation evidence.

**Durable side effects.** History aggregate state changes occur in the history repository transaction. Separate fenced ledger transactions track History/Undo pending flags, retries, completion and review incidents. A terminal command does not imply ledger success.

**Retry and uncertainty.** Finalization is local and independently retryable; it never sends Shopify mutations. Read-only historical approval verification permits reconciliation after expiry/adapter replacement without issuing a live execution grant. Failures remain durable; exhaustion requires review rather than silent suppression.

## Scheduled occurrences

Owner: [schedules.server.js](../web/services/schedules.server.js).

**Input schema.** `createSchedule` accepts authenticated context, supported UTC recurrence, a bounded bulk-edit template, optional frozen targets, due time and enabled flag. `triggerDueSchedules` accepts a valid discovery time. `processNextOccurrence` accepts a 5–600 second lease. Cancel/list methods require authenticated shop context. Composition supplies separate merchant and issued operation-worker gateways.

**Output schema.** Creation/listing returns schedule metadata; discovery returns newly persisted occurrence identities. Processing returns empty, advanced phase, retry, superseded or review-required. These are scheduling checkpoints, not merchant mutation-success receipts. The occurrence stores the command's result/counts and execution/finalization disposition.

**Authority requirements.** Current authenticated tenant and captured installation govern creation. Worker discovery, claim and phase updates compare immutable occurrence installation, fence, token and lease. Selection/approval/dispatch obtain fresh merchant authority. Outcome polling independently checks the leased occurrence, installation and its exact command/contract/snapshot relationship using the worker gateway.

**Lifecycle preconditions.** SELECT, APPROVE and DISPATCH are distinct fenced checkpoints; DONE means dispatch bookkeeping is complete, not successful execution. DISPATCHED/EXECUTING wait for the command and finalization ledger. Terminal mixed execution persists command status `PARTIAL`, and the occurrence retains `PARTIAL` after finalization. Reinstallation or incompatible pre-dispatch adapter metadata requires review. A frozen selection uses the normalized snapshot contract.

**Durable side effects.** Unique occurrence identity is `(shop, schedule, scheduled_for)`. Phase references join the corresponding selection/approval/dispatch transaction. The occurrence stores durable result counts and terminal disposition after finalization. Canceling a dispatched occurrence requests cancellation on its bound command before reconciling the outcome.

**Retry and uncertainty.** Reclaim only expired leases; replay resumes the persisted phase. A lost checkpoint commit response does not create another approved operation. Waiting for execution resets scheduling retry attempts; reconciliation failures remain retryable or require review. Status polling does not acquire a new merchant mutation grant or re-dispatch the command.

## Publication fencing

Owner: [publication-lock.server.js](../web/mirror/publication-lock.server.js).

**Input schema.** `lockPublication(client, shopId, {write=false, relation})` receives an active trusted transaction, bounded server-resolved shop and installed server-owned relation. Browser SQL identifiers or relation overrides are not accepted by callers.

**Output schema.** Returns after acquiring the transaction-scoped barrier; it is not a coverage or authorization receipt.

**Authority requirements.** The caller owns authentication, installation and gateway verification. Setting a tenant GUC inside this helper does not establish authority by itself.

**Lifecycle preconditions.** Readers and publishers use the same shop advisory key. READ COMMITTED reads protected data after acquisition; repeatable-read/serializable paths also lock and verify the exact publication row to reject an older snapshot. ACCESS SHARE is a DDL fence, not a publication-update barrier.

**Durable side effects.** None from the helper itself. Its locks last until the caller commits or rolls back; protected publisher changes belong to that transaction.

**Retry and uncertainty.** Transaction conflicts retry the complete local transaction and revalidate coordinates. Acquiring this lock does not authorize a remote write or resolve an uncertain one. No database lock is held across the Shopify network request.

## Reviewed import handoff

Owners: [import-preview.server.js](../web/services/import-preview.server.js), merchant dispatch and History Execution; see [the complete handoff](ct-103-105-execution-handoff.md).

**Input schema.** Validation/preparation accept authenticated context and 1–1000 bounded Product records with one target identity and installed canonical SET fields. Approval accepts preview ID and exact reviewed hash. Execution accepts the resulting approved contract ID through `dispatchImport`.

**Output schema.** Validation returns valid/invalid row reports. Preparation returns a DRAFT preview ID/hash, snapshot ID, row count and expiry. Approval returns the immutable contract identity/hash. Dispatch returns a command receipt; the worker returns separately verified execution results.

**Authority requirements.** Independently resolve merchant actor, shop, installation, field permission and exact selection membership. Resolve input IDs to distinct canonical resource GIDs and persist each row's field mapping. Approval loads the reviewed stored preview; execution reloads the resulting contract and compares row/resource instructions.

**Lifecycle preconditions.** Preparation cannot approve. Product, variant and metafield mixtures are rejected before materialization because this importer lacks the required writers. One resource item does not represent an entire import. Supported rows use the existing history/evidence and Undo admission path.

**Durable side effects.** Preparation persists the versioned preview and frozen selection in one transaction. Approval and dispatch persist their own immutable references and work. The installed worker performs the row-specific mutations through history; the catalog mirror importer is a different service.

**Retry and uncertainty.** Preview identity/hash recovers approval association; dispatch uniqueness prevents duplicate logical imports. Ambiguous mutation outcomes use the same one-use consumption, evidence-only completion and independent recovery rules as bulk edits. Never retry an import by resending all rows after an uncertain result.

## Operation outbox

Owner: [operation-outbox.server.js](../web/workers/operation-outbox.server.js); authorized review recovery is owned by the merchant gateway.

**Input schema.** The dispatcher receives an issued operation-worker database, queue transport and optional incident logger; `dispatchNext()` has no browser payload. `requeueDispatch` accepts authenticated context, approved contract ID, supported kind, optional Undo source and a bounded review reason.

**Output schema.** Delivery returns EMPTY, DISPATCHED, RETRY, SUPERSEDED or REVIEW_REQUIRED with command identity. Requeue returns the original dispatch receipt plus `requeued:true`; it does not prove execution success.

**Authority requirements.** Worker profile is asserted at construction. Requeue reloads tenant, installation, live approval and write permission through the merchant gateway, requires existing eligible work and records an audit entry.

**Lifecycle preconditions.** Claim only due undispatched events below budget; expired final claims are independently moved to review. Every acknowledgement/failure update matches the event fence, token and live lease. Reviewed requeue retains the original command and dedupe identity and rejects completed, canceled or already published work.

**Durable side effects.** Claims, attempts, delivery acknowledgements and review flags/errors persist on the outbox. Requeue resets the bounded delivery budget and appends review audit evidence atomically. The queue receives only shop/command scheduling identity.

**Retry and uncertainty.** Queue response loss is unconfirmed delivery, not proof of no publication. Repeat delivery uses the same queue ID; command/history idempotency remains authoritative. Exhaustion emits an operational incident and requires explicit authorized requeue. No outbox operation sends Shopify mutations.

## Review and validation

The wider audit's saved-filter, strict-selection, snapshot identity, export DTO and dispatch/refresh review corrections are recorded in [the wider release fixes](wide-backend-release-fixes.md). That document also declares UTC-only recurrence, endpoint-specific HTTP errors and the REST-to-AST adapter boundary so consumers do not infer unsupported equivalence.

Review behavioral contracts in this order: schedule success versus dispatch, finalization scope, writer compatibility, authority coordinates, publication fencing, return schemas and import handoff. Cosmetic naming/import changes do not establish these guarantees.

Tests must exercise observable boundary failures: stale claims, missing fields, changed installations or adapters, expiry between phases, publication replacement, partial outcomes, duplicate scheduling and lost commit/remote responses. The [CT-106–120 matrix](ct-106-120-authority-and-lifecycle.md) records these policies and current verification limits. Document a missing enforcement check as a gap and repair it at the owning boundary; do not conceal it by renaming methods or forwarding a readiness flag.
