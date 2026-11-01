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

The [method-by-method transaction boundary review](schedule-transaction-boundaries-2026-11-01.md) identifies merchant-scoped phases, worker-only global discovery/claims/recovery, the per-schedule tenant initialization needed by INSERT triggers, and tenant-scoped worker outcome polling. It records transaction ownership, lease CAS, rollback and uncertain-commit behavior with real-role test evidence.

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

### Catalog sync preview and edit barrier

Operational evidence and verification limits are recorded in [catalog sync behavior](catalog-sync-behavior-2026-11-01.md). The catalog dispatch fairness sequence requires the narrowly granted USAGE privilege in migration `20261101001000_catalog_dispatch_sequence_usage`; the restricted-login PostgreSQL test executes `nextval` to prevent recurrence. Worker failure diagnostics contain only bounded own-data code/type/constraint/stage values; accessors and raw messages are excluded, and diagnostic failure cannot interrupt durable recovery handling.

Owners: `services/catalog-import.server.js`, `20261101000900_catalog_sync_edit_barrier`, `security/worker-gateway.server.js`, `app.js`. Existing authenticated sync GETs add `editingAllowed:boolean` and `previewProducts:Array<{id:ShopifyProductGid,title:string,status:ProductStatus,vendor:string|null,productType:string|null}>` (at most 50, ordered by Shopify ID using the tenant/generation index). Input remains authenticated stored session and optional validated import ID; neither browser shop nor generation coordinates are accepted. Status reads now also require the job's current live installation. Preview rows and the exact `progress.productsSaved` count share the SQL statement's committed tenant/generation snapshot. Uncommitted rows, tombstones and other shops/generations are excluded. Returned rows are unfiltered display DTOs, never a targeting snapshot, coverage grant, SQL binding, approval or export source. The first 50 rows refresh with the shared status poll; additional rows become pageable through the verified catalog after publication. No sensitive tokens, inventory or internal row IDs are returned. No durable read effects; a lost read response is safe to poll again. This is a bounded display preview, not a merchant-scale performance certification; the exact count still scans the generation.

Editing remains unavailable until the latest installation import is SUCCEEDED and its generation is the current PUBLISHED generation, with no active/cancel-pending imports. Failed, cancelled and uncertain syncs fail closed until a successful replacement. `editingAllowed` is a UI hint only. Database triggers independently recheck live lifecycle at mutation command insertion, worker acquisition/reacquisition, dispatch authorization and single-use dispatch consumption. The worker discovery query skips blocked tenants so another shop can proceed. Outcome acknowledgments, cancellation, no-write proofs, uncertainty resolution and finalization remain available; these do not authorize another Shopify send. Existing selection, staff authorization, contract/claim fencing and publication checks remain required. No new raw-query or staging-filter path exists.

`withEditingLock(session, trustedCallback)` is an internal callback interface used by the sample creation HTTP endpoint. It reloads read/write and online staff scope, owns a bounded READ COMMITTED transaction and shared publication barrier, then checks the live database barrier before invoking the callback. Output is the callback's result. A missing gate or incomplete sync returns HTTP 503 `CATALOG_EDITING_LOCKED`; rejected staff authorization remains 403. The lock spans this existing remote request. No callback/transport is automatically replayed following a lost response or commit acknowledgment; a remote success cannot be undone by rolling back the local read transaction. The actual bulk path retains its immutable request journal and uncertain-outcome recovery.

The new migration's private fixed-search-path definer functions read lifecycle metadata only, return no catalog rows, and revoke PUBLIC execution. The explicit public assertion requires matching transaction tenant scope; trigger-only helpers derive the shop from the existing row and never change tenant GUCs or confer authority. The mutation side takes the same shared advisory publication barrier as existing readers. Sync admission takes its exclusive side and rejects RUNNING mutation commands or DISPATCH_AUTHORIZED/ACKNOWLEDGED/OUTCOME_UNKNOWN history requests, so already-admitted writes drain or recover before a new import starts. Database rejection is SQLSTATE 55000; it rolls back the owning transaction, not a prior remote request. Installation and publication locks retain their existing transaction owners. Migration DDL is one transaction; lost apply acknowledgment requires checking Prisma's durable ledger before retry.

`ensurePeriodicFullSyncs()` is a server-only catalog-worker method with no browser input or sensitive output. The existing background dispatcher scans at most 10 live installations per tick using a rotating keyset and rechecks eligibility inside the exclusive shop/publication transaction. It coalesces a durable refresh request for installations whose last import attempt/publication is at least 72 hours old, skipping active/staging imports, pending requests and review-required requests. The existing refresh dispatcher owns allocation, credential reload, bounded retries and dead-letter review. Recent failed attempts are not reset every tick; periodic retry is no sooner than 72 hours after that attempt, with manual review retained for uncertain/exhausted work. A lost request-commit response is recovered by the next scan observing the durable pending request; it must not increment that pending revision again. Multiple schedulers cannot issue duplicate requests for one due period. First-install repair uses the existing per-installation durable job tombstone, including terminal jobs, so app opens/status polling do not start fresh full exports. Existing signed, deduplicated webhooks continue to journal product revisions and request generation refreshes; this change does not replace the current webhook-triggered export/reconciliation mechanism with an incremental published-row writer.

Verification: `npm --prefix web run test:sync-progress:postgres` uses actual migrations/restricted logins on disposable local PostgreSQL. It checks 0→50→51 committed counts, the 50-row preview bound, tenant/generation/tombstone and uncommitted exclusion, reopen idempotence, locked callback/command admission, verified-versus-published-versus-acknowledged unlock, private function denial, 72-hour suppression/coalescing, and a real advisory-lock race between an admitted callback and a new sync. The publication fixture performs real state transitions with durable run/coverage records; it does not run Shopify ingestion or the complete bulk-edit-to-Shopify worker. Frontend tests independently render 50 preview rows and verify live updates and disabled editing through completion. Existing production-scale and end-to-end worker verification limitations remain open.

## Catalog worker readiness

Owner: `mirror.catalog_edit_is_ready(text)` in migration `20261101001200_catalog_worker_readiness`; consumer: `security/worker-gateway.server.js::claimNext`.

- Input: server-owned shop domain from an operation command, not browser or queue authority. Output: one non-null boolean indicating a live installation, exact published generation with a latest successful import, and no active/pending-cancellation import.
- Authority: EXECUTE is restricted to `metamax_operation_worker`; PUBLIC has none. SECURITY DEFINER uses a fixed `pg_catalog` search path and fully qualified relations. This avoids granting the operation worker catalog-import rows or mutation privileges.
- Lifecycle: discovery is advisory and supplies no execution grant. `guard_catalog_edit_admission` and `guard_catalog_dispatch_admission` still take the transaction advisory barrier and recheck readiness before a claim or remote send. Concurrent sync cannot be approved from the discovery result alone.
- Ownership/effects: caller owns the SQL transaction; function is read-only, returns no merchant data, and cannot finalize commands. Read retries and lost responses are safe; no external or durable effects occur.

The catalog worker may DELETE `mirror.subscriptions` only under the existing tenant RLS policy to remove an old installation's observation cache before reinstall rotates its identity. Migration `20261101001300_catalog_installation_cleanup` grants no subscription INSERT/UPDATE and no operation-write permissions. The unused history runtime EXECUTE grant on `assert_catalog_edit_ready` is revoked; dispatch triggers retain their owner authority.

## Historical item evidence

Owner: `services/history-execution-adapter.server.js::lockEvidenceItemAuthority`; consumer: `edit-history/item-completion.server.js`.

- Input: the caller's active transaction client, authenticated `{shopId, installationId}`, authoritative persisted execution plan and exact `{fenceEpoch, leaseToken}` claim. No client/plan/tenant from browser JSON is accepted by the repository. Output: locked command, independently hash-verified historical contract, and an `assertClaim()` closure restricted to that transaction and claim. The returned contract is evidence-only, never dispatch authority; private claim tokens must not be exposed in HTTP DTOs.
- Authority/enforcement: `assertExecutionClaim` checks RUNNING ownership, fence, live lease and cancellation under a row lock. The method checks installation, command/contract/edit aggregate linkage, immutable approval hash and execution coordinates, field-resolution fingerprint, one exact execution item/resource and its complete field/value set. Durable item values must equal the plan and approved bulk payload, import row or undo field membership. The completion service independently authorizes evidence access and validates every persisted request/change/after-snapshot receipt.
- Lifecycle: expired/revoked approvals and replacement publications may still be read as historical evidence; they cannot authorize a new send. Current installation, worker lease and exact immutable execution ownership remain mandatory. Completion rechecks the claim after evidence reads and commits item/history finalization on the caller's transaction.
- Effects/retries: this method reads and locks only; it opens/commits no transaction and calls no remote API. Any verification failure aborts completion and its surrounding transaction. The worker retries only aborted database work; lost COMMIT responses remain uncertain and are inspected from durable history/item state before another finalization. Neither evidence recovery nor a missing response permits resending a Shopify mutation.

## RLS initialization and bounded publication callbacks

`services/approval.server.js::approveContract` still requires an authenticated actor matching the requested shop and current operation authorization. After opening its own REPEATABLE READ transaction it initializes `app.shop_id` from that verified identity before reading the selection. The setting is transaction-local and rolls back/clears with the transaction; a supplied transaction retains its existing owner and scope. Inputs, output, frozen contract writes, uncertainty and replay behavior remain as declared under Approval and approval reads.

`services/schedules.server.js::triggerDueSchedules` uses the issued operation-worker profile for global discovery, then sets the transaction-local shop to each persisted schedule before inserting its occurrence. Installation triggers check the live installation against the stored schedule. Discovery coordinates are not execution authority: each phase independently authenticates its current context and installation before materialization, approval or dispatch. Schedule advancement and occurrence insertion share the worker transaction; lost commit acknowledgment is recovered by the occurrence's durable unique identity.

Operation workers may discover, claim and update existing commands but cannot create them. Migration `20261101001400_operation_command_creation_boundary` removes their unused command INSERT grant; `verifyRuntimeDatabase` rejects any reachable command INSERT grant for that profile. Command creation remains owned by the merchant dispatch gateway, including scheduled dispatch with its authenticated merchant transaction. Approval payloads and schedule templates remain outside worker write authority. The real-role suite verifies denied command creation and immutable approval/template updates; the operation suite verifies rollback before the occurrence checkpoint and idempotent resumption after lost COMMIT responses.

`edit-history/transaction-hooks.server.js::createHistoryHookInvoker` exposes an expiring `publicationLock(shopId, {write:false, relation:'"mirror"."publications"'})` capability beside its existing SELECT-only query method. Only `args.tenant.shopId` is accepted; write locks, other relations, retained/expired capabilities and arbitrary LOCK/transaction SQL remain rejected. `mirror/publication-lock.server.js` delegates this exact operation to the wrapper, which holds the real transaction's DDL/advisory read barrier and rechecks its deadline. The caller retains transaction ownership; locks release on commit/rollback. The capability confers no tenant or mutation authorization.

`export/export-source.server.js::offline` now awaits installation-bound authentication capture before resolving an opaque worker context. Failed capture or revoked identity fails closed; installation authentication failures are mapped to the export unauthorized contract. No session token or opaque context is returned to the merchant. Authorization failures cause no remote mutations or durable effect; later retries must authenticate again.

Undo repository transactions now initialize the authenticated shop publication barrier and installation GUC before their first scoped lifecycle/source read (`undo-repository.server.js::scope`). The opaque context is independently resolved and authorized before work and immediately before commit; the callback does not receive a pool or authority grant. The repository owns SERIALIZABLE begin/commit/rollback and calls no remote mutation. A denied write or failed lifecycle recheck rolls back all undo state.

`worker-gateway.server.js::complete` remains fenced by the current command owner and full durable history evidence. If an item UPDATE reports no eligible row after a lost COMMIT acknowledgment, it accepts only the already-SUCCEEDED item with the exact confirmed immutable snapshot and matching approved after-hash. Otherwise it returns ownership loss. This acknowledges durable completion without writing mirrors or issuing another Shopify request. The command's terminal summary is recomputed from durable item/history state.

Scheduled occurrence cancellation now returns false for terminal FAILED occurrences; they retain their immutable terminal state. Cancellation remains available only for queued/running/retry/dispatched/executing occurrences under current tenant/installation authorization. It does not rewrite completed history or turn a failed terminal occurrence into a new execution.


## Legacy bulk start and ingestion recovery

`bulk-sync.startBulkQuery` (and its alias/runner consumer) accepts a trusted shop domain, running sync-run ID and exact fence, and a server-owned query string (default catalog query; at most 1 MiB). Output is an exact bound Shopify operation or its queried status; this does not certify ingestion or publication. `getSyncRun` checks shop/run/status/fence before dispatch. The Shopify client remains server-created for that shop. Browser coordinates and hashes are not authority grants. Phase-managed executions use their separate existing execution ledger; this legacy protocol rejects them.

`syncRunService.prepareBulkStart({shopId,runId,fence,inputHash})` accepts a 64-character SHA-256 of the exact query. It owns a shop-scoped database transaction, takes the publication barrier and locks the live INGESTING generation and RUNNING run through `lockedRun`. It fixes the input hash and commits `bulk_start_fence` before any remote call, returning `{dispatchFence: string}` only to the winning attempt. An existing intent without exact response evidence raises OUTCOME_UNKNOWN. With saved response evidence it atomically binds that ID under current run authority and returns `{operationId: string}`; an existing binding is returned without dispatch. Hash changes are rejected. Neither receipt nor evidence grants permission to publish.

`recordBulkStartResponse({shopId,runId,dispatchFence,inputHash,bulkOperationId})` accepts an exact numeric Shopify BulkOperation GID and the persisted dispatch identity. It owns a shop-scoped transaction and conditionally saves evidence only where run/shop/hash/dispatch fence match and execution_id is absent. Identical evidence is idempotent; conflicting evidence fails. Late evidence is allowed after lease loss, but cannot bind or complete the run. The following `prepareBulkStart` requires a current live run and binds atomically. These methods return no sensitive export URLs.

`rejectBulkStart({shopId,runId,fence,inputHash})` requires the same live-run locks, exact recorded fence/hash, no response evidence and no binding. It clears the dispatch fence only after a definitive Shopify user-error rejection with no operation and no GraphQL errors. It returns no value and preserves the query hash. Only this proven rejection permits a new start.

Retry/uncertainty: no remote call occurs inside a retryable database transaction. Failed/lost intent commits cause no send; a later attempt observes durable state before proceeding. Lost remote responses, process death after dispatch, malformed responses and lost evidence/binding commits never authorize another start. Re-entering start with the same input recovers an exact saved response and binding under a new live lease. If no response ID survived, intent remains durable and requires authoritative/manual recovery; currentBulkOperation is never adopted or cancelled as ownership proof. A known remote operation may still physically exist without a local ID when its response is lost: the protocol tracks the ambiguous attempt and blocks duplication; it does not claim atomicity across Shopify and PostgreSQL. Explicit cancellation retains its existing unknown-cleanup semantics. Migration 20261101001500 must precede code rollout; catalog-import.verifyStorage checks all three columns. The migration does not reconstruct historical unjournaled starts.

`jsonlIngestion.ingestJsonlLines` and its stream/empty aliases accept shop/generation/run/fence, a bounded grouped JSONL stream, batch size 1..100 (default 25), optional signal/count/new-chunk budget. They require the exact owned RUNNING run and a completed bound export. Output is either a deferred chunk result or durable line/chunk counts with succeeded=true after EOF, completion and generation transition commit. Checkpoint pages are bounded to 1000 and read through `transaction(database, callback, shopId)`: the connection establishes transaction-local app.shop_id through lockPublication before querying. Checkpoints are replay evidence; staging writes still independently validate live generation/run/execution authority and commit rows plus checkpoints atomically. Counts read from the stream never certify durable completeness. No remote download URL or product payload is included in new diagnostics.

On ingestion failure, committed chunks remain resumable and failIngestionRun (or cancellation on abort) is awaited. If this secondary write fails, the caller receives AggregateError with code INGESTION_FAILURE_RECORDING_FAILED, outcomeUncertain=true, cause=original error and errors=[original, recording error]. This preserves both failures without logging their raw potentially sensitive messages. Successful recording still rethrows the original error. An exception never certifies that failure/cancellation committed; recovery must re-read durable state and reacquire authority. Database role/concurrency evidence must be reported separately from mocks.


## Tenant-scoped sync discovery

`syncRunService.getSyncRun({shopId,runId})` takes a server-resolved shop domain (validated by `shop`) and a PostgreSQL bigint-compatible internal run ID, parameterized as values. It returns the existing projection (runId, shopId, generationId, dataset, status, bulkOperationId, fence, processedLines, leaseToken), or null if absent from that shop. Database integer representations are preserved. leaseToken is sensitive internal worker data; this result must not be exposed wholesale through HTTP. A result is observation, not a lease claim, mutation permission, or proof of current ownership.

`reconciliationService.scanDueDirtyProducts({shopId,limit=50})` takes a server-resolved shop and an integer limit 1..200, validated before connection acquisition. It returns an array of productId, revision, appliedRevision, dirty, deleted, attempts and fence, converting revision/appliedRevision/fence to bigint. Its fixed SQL restricts shop_id and selects only dirty, non-dead-letter rows whose retry time and lease are absent or expired, ordered by next_attempt_at NULLS FIRST and product_id. Empty results mean no eligible rows in that read, not synchronization completeness. Results are scheduling hints; claimDirtyProduct must independently reacquire current revision/lease/fence before remote work, and reconciliation must retain its atomic conditional acknowledgement plus mirror writes.

Authority and transaction ownership: callers must derive the shop through the existing authenticated backend or trusted worker context; neither a domain string nor returned coordinates grants authority. Both methods own `transaction(database, callback, shopId)`. The helper begins a bounded READ COMMITTED transaction, fences publication, sets transaction-local app.shop_id through lockPublication, and runs the fixed tenant-predicated SELECT on that same client. COMMIT/ROLLBACK and connection release are owned by the helper. There are no caller-supplied SQL identifiers, external requests, claims, durable row changes, acknowledgements or lifecycle transitions. Reads may observe any run status; dirty discovery does not require an active generation and does not choose a publication.

Retry/uncertainty: read failures roll back and propagate; helper retries only its existing bounded database-conflict codes. No remote mutation is issued or replayed, and a lost read COMMIT response certifies no result to the caller. These observations must be revalidated by the existing write/claim interfaces before side effects. Transaction-local scope ends at commit/rollback; it is not cached across shops or pooled connections. Unit tests reject pool-level reads; real tenant-only NOBYPASSRLS tests check same-shop lookup, foreign-run absence, scanner eligibility, bounds, unchanged rows, and scope cleanup on connection reuse. Production catalog control-plane read policies remain unchanged.
