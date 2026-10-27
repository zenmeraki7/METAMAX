# Reconciliation guarantees

Catalogue webhook bodies are invalidation signals, not authoritative product state.
For accepted deliveries belonging to an active installation:

| Guarantee | Enforcement | Verification |
| --- | --- | --- |
| Commit before HTTP success | Receiver awaits recordProductWebhook; receipt, dirty revision and active-snapshot invalidation share a transaction. Queue delivery follows acknowledgment. | Delayed-commit HTTP test; failed-commit 503 test; PostgreSQL rollback test |
| Duplicate delivery idempotency | WebhookEvent primary key on Shopify delivery ID; conflicting ID metadata is rejected. A duplicate receipt does not increment revision or enqueue again. Workers claim current dirty state, so duplicate jobs skip clean/leased rows. | Concurrent receipt and duplicate-worker tests |
| Authoritative state | Worker fetches product plus every variant page; verifies product identity/version and an exact variant count before replacing the mirror. | Authoritative refetch and complete variant replacement tests |
| Safe absence classification | Only two explicit, error-free product:null reads establish absence. HTTP failures, missing data, GraphQL errors, access denial, throttling and pagination inconsistency throw. | Product-service HTTP/error tests and PostgreSQL denied-delete test |
| Publication ordering | Receipt and incremental completion take the Shop SHARE barrier; publication takes UPDATE. Completion also matches installation generation, snapshot pointer, observed revision, lease token and unexpired database-clock lease. Writes and acknowledgment commit together. | Publication race, newer-revision, expired-lease and rollback tests |
| Product deletion | Authoritative confirmed absence deletes current product JSON and compatibility cache transactionally; Variant rows cascade from SnapshotProduct. The revision ledger remains to fence stale workers. | PostgreSQL product/variant removal test |
| Variant deletion | Stable products/update covers variant removal. Fetch the complete authoritative variant set, then replace product JSON and the scoped Variant projection in the same fenced transaction. Inventory items are separate resources. | PostgreSQL [1,2,3] to [1,3] replacement test |

X-Shopify-Webhook-Id identifies individual deliveries; X-Shopify-Event-Id correlates
merchant actions across deliveries/subscriptions. Do not deduplicate unrelated topics
or resources using eventId alone. Receipt retention is bounded by the existing policy;
this is not a promise of exactly-once queue delivery or perpetual delivery-ID storage.

Confirmed-uninstalled installations are explicitly ignored and cannot create dirty
work. An installation whose registration is missing or still committing receives a
retryable response. The receiver never depends on Redis for durable acceptance.

The completion update uses clock_timestamp() inside its SQL condition. Expiration
is checked at the write, not using an application clock captured before a row-lock
wait. A lost or expired claim cannot clear dirty state even if Shopify succeeded.
Null-token backend compatibility writes apply only to completely unleased rows;
ordinary workers always provide their claimed token. Database conflicts retain
bounded retry behavior, and failed application writes roll back the acknowledgment.

No new webhook subscriptions or scopes were added. The existing stable product
subscriptions are appropriate for this pipeline; do not invent a separate stable
variant-delete topic. The app config was not deployed and no live merchant deletion
was performed.

Verification: 116 local/HTTP tests pass, including five receiver-boundary tests.
Eight PostgreSQL guarantee tests pass on the disposable foundation branch with
mocked Shopify responses, using the actual receiver repository, product reader,
reconciliation service, publication transaction and database constraints. These do
not need Redis. Redis worker transport remains outside this verification.

Run local tests with `node --test web/tests/webhook-boundary.test.js` and the
PostgreSQL suite using `node web/scripts/test-mirror-foundation.js --host <verified-disposable-Neon-host> --suite reconciliation`.
The database runner refuses the application endpoint. No migration was added for
the reconciliation fix; the prior prepared foundation migration is still required
for the full mirror schema and was not applied to the application database here.

References: [delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries),
[stable topics](https://shopify.dev/docs/api/webhooks/2026-10),
[root invariants](../AGENTS.md).
