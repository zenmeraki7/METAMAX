# History repository production QA corrections

[Security and retention](edit-history-security.md) now adds per-connection
least-privilege verification, encrypted values and default redaction, bounded
30-day cleanup, legacy backfill and uninstall/redaction integration. Dedicated
production roles, keys and migration deployment remain required.

[Execution Authority V2](edit-history-execution-authority.md) adds an explicit
tested admission boundary composed inside the journal transaction using the real
engine ownership queries. Production durable providers remain required; an
authority result is not a dispatch grant. See the
[integration report](edit-history-authority-integration.md).

Review findings are implemented and tested against disposable PostgreSQL.
Live Bulk Edit integration remains disabled. Passing tests does not grant
production approval: durable production authority providers, the additive
migration and the actual dispatch boundary still require integration review.

## Findings

| Finding | Correction and regression evidence |
| --- | --- |
| HIST-REP-001 | Mirror SQL moved into `web/services/history-execution-adapter.server.js`. Catalog checks verify referenced types/nullability, timestamp precision, validated composite joins and unique candidate keys. Migrated-schema tests reject renamed columns and missing FKs. |
| HIST-REP-002 | Atomic acknowledgement, unknown/no-write outcomes, immutable AFTER verification/conflict snapshots, durable recovery discovery/claim/renew/retry/cancel/completion and review-required exhaustion. Tested with crash recovery, takeover, expiry and contradictory evidence. |
| HIST-REP-003 | Shared `getApprovedContractInTransaction` requires the explicit client. No fake database or connection fallback. Tests assert transaction identity and exercise the real approval verifier. |
| HIST-REP-004 | Runtime checks require actual `mirror.shops.id`, `installation_version` and `uninstalled_at`. Current installation is locked/rechecked. Historical admission installation must come from immutable trusted storage, never from current shop metadata. |
| HIST-REP-005 | Replay reconstructs persisted BEFORE snapshots and authenticates their stored receipts against the authoritative plan. Deleting a receipt rejects replay even with an unchanged caller snapshot. |
| HIST-REP-006 | Immutable request envelopes and deferred triggers require the complete declared field set and shared item/resource/attempt/fence/claim/plan coordinates. Independent SQL cannot commit an empty envelope or an undeclared field with a matching BEFORE snapshot. |
| HIST-REP-007 | Independent dispatch permission and a single-use private token stored only as a hash. Consumption commits under current engine ownership and approval before HTTP. Commit-before-send crashes become unresolved recovery work, never automatic resubmission. |
| HIST-REP-008 | Transaction-local ownership-query deduplication, bounded records/field sets/history/pages, expiring callback clients, AbortSignal, five-second callback and fifteen-second aggregate callback deadlines, and SQL/lock timeouts. No cross-transaction grant caches. |

Authenticated list APIs use signed keyset cursors bound to tenant, installation,
capability and operation. Ordering preserves PostgreSQL microseconds. Pages
redact snapshot values and private execution authority.

## Lifecycle API

Methods take authenticated context and exact history operation/request IDs.
Normal workers supply the private engine claim. Recovery uses the separately
issued `{claimToken, fenceEpoch, workerId}` lease.

| Method | Purpose |
| --- | --- |
| `consumeDispatch` | Consume the private token returned once by `beginDispatch`; only the successful caller may proceed to its single external send. |
| `recordMutationOutcome` | Resolve a trusted opaque `evidenceId`; persist ACKNOWLEDGED, OUTCOME_UNKNOWN or FAILED_NO_WRITE for every field atomically. |
| `recordVerification` | Resolve trusted evidence; persist immutable OBSERVED_AFTER snapshots and VERIFIED or CONFLICT for the complete request. |
| `discoverOutcomeRecovery` | Bounded tenant-scoped discovery of unresolved requests without a live executor; queues observation work. |
| `scheduleOutcomeRecovery`, `claimOutcomeRecovery` | Deduplicated tasks claimed as one fenced request group. PREPARED requests are not recovery work. |
| `renewOutcomeRecovery`, `retryOutcomeRecovery` | Conditional renewal and bounded durable backoff. Exhaustion preserves uncertainty in REVIEW_REQUIRED. |
| `cancelOutcomeRecovery` | Cancel observation work and invalidate leases without inferring the mutation result. |
| `listOperations`, `listChanges` | Separately authorized pages, limit 1–100, with signed continuation cursors. |

The evidence loader receives the transaction client, authenticated context,
tenant, persisted request and opaque evidence ID. It returns a durable record
with `operationId`, `mutationId`, `attemptId`, exact decimal `executionJobId`,
`executionItemId`, `executionFenceEpoch`, `executionClaimId`, `kind`, `fingerprint`
and the exact complete `fields` set. Verification receipts include an issued
`afterSnapshot` for every field. `verifyMutationEvidence` independently
authenticates that record and its association with the request. Browser hashes,
kinds and observations are not evidence authority.

Evidence kinds are `AMBIGUOUS`, `SHOPIFY_ACKNOWLEDGEMENT`,
`AUTHORITATIVE_NO_WRITE`, `VERIFIED_OBSERVATION`, `CONFLICT_OBSERVATION`.
Recovery permissions are action-specific: `schedule_outcome_recovery`,
`discover_outcome_recovery`, `claim_outcome_recovery`, `renew_outcome_recovery`,
`retry_outcome_recovery`, `cancel_outcome_recovery`, `record_recovery_evidence`.
Each is checked again before commit. A recovery lease grants no mutation right.
Timeouts, expired leases and crashes cannot establish authoritative no-write.

There is no database/Shopify HTTP atomic transaction. If issuance or consumption
commits with a lost acknowledgement, or the process dies before/after sending,
preserve uncertainty and collect authoritative evidence. Never resend using the
journal state or a reused token. History does not finalize execution jobs or
clear mirror dirty flags; the engine owns revision-safe completion.

## Rollout gates

The pending resource uniqueness, envelope and resource-member migrations are
additive and tested after fresh V2 and the deployed V1-to-V2 upgrade. Applied V1/V2 migrations are
unchanged. Existing history requires trusted envelope provenance; the migration
aborts rather than inventing historical installation or execution authority.
Test schema resets occur only in explicitly isolated localhost fixtures.

The pending migrations are **not deployed live**. Before worker activation, integrate
real immutable V3 admission/observation/outcome providers, review any provenance
backfill, deploy the scoped migration and wire independent permission plus token
consumption into the actual HTTP sender. Defaults fail closed without these
providers. Fixture-only `history_test_authority` tables are not a production
provider. Undo, retention and HTTP routes remain later integrations.

Validation results: [Phase 2 report](edit-history-phase-2-repository.md).
