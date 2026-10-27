# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Ingestion & Reconciliation Invariants

One necessary prerequisite remains: the importer must have finished its database writes before the run transitions to RECONCILING. `processedLines === expectedLines` is only a valid completeness check if those counts represent durable, validated ingestion—not merely lines read from JSONL.

### Revision-Safe Worker Completion

A worker must never clear `dirty` just because its Shopify request succeeded. For example, if it starts reconciling revision 10 and another webhook creates revision 11, the first worker must not acknowledge revision 11.

The worker should apply its mirror writes and acknowledge its observed revision inside one database transaction, using a conditional update:
- Match `where: { shop, productId, revision, appliedRevision: { lt: revision } }`.
- Set `data: { appliedRevision: revision, dirty: false, nextAttemptAt: null, lastError: null }`.
- If `applied.count !== 1`, a newer webhook or another successful worker superseded this result; do not write the mirror.
- Persist the reconciled mirror state (including handling deleted products) using the same transaction so any failure rolls back the acknowledgment.
- Handle retryable database conflicts such as Prisma P2002 and P2034.

### Reconciliation Worker Invariants

The reconciliation worker must enforce four invariants:
1. **Read the latest revision from Neon**: A queued revision is a scheduling token, not authoritative product state.
2. **Do not process clean rows**: A redundant queued job should return quickly without making external requests.
3. **Fence concurrent writes**: A worker processing an older revision must not overwrite a newer reconciliation or bulk snapshot.
4. **Persist failure and retry eligibility**: The scanner should enqueue only due dirty rows, with bounded retry/backoff behavior.

*Idempotency requirement*: Deterministic job IDs prevent duplicate scheduling only while the job exists. Once completed or failed jobs are removed, another enqueue can create the same ID again. Therefore, the database and workers must provide idempotency, not BullMQ alone.
