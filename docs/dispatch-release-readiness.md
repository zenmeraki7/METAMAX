# Dispatch release assessment — 29 October 2026

**Verdict: integration candidate; not production approved.**

The stalled development-store catalog run subsequently completed end to end:
30,021 export records were durably ingested and published as 14,987 products and
15,034 variants. The actual persisted-session catalog controller returns READY
and the progress service returns 100%. See the
[live stall recovery record](sync-stall-recovery-20261029.md). This closes the
single-store functional verification step; production scale and failover approval
remain separate.

Passing repository tests demonstrate specific database and local timeout
properties. They do not prove a production queue-evidence provider, deployment,
real Redis failure recovery or production-scale fairness.

| Release blocker | Verified evidence | Remaining work |
| --- | --- | --- |
| Physical Prisma schema and migrations | Dispatch migrations `002`–`005`, followed by explicitly approved migration `006`, were tested against a production-derived scratch database and deployed to configured `newmeta_app`. All thirteen installed migration checksums match; live physical mappings, startup verification, preserved data and a zero-difference canonical Prisma schema check pass. See the [deployment record](dispatch-migration-deployment-20261029.md). | Migration deployment is complete for the configured branch. The Prisma transaction-protocol test is still not a test of a real generated Prisma Client; verify that adapter separately if used in production. |
| Authoritative BullMQ and execution evidence | Database checks bind retries to current revision, queue route, recovery token/fence and deadlines. `mirror.sync_dispatch_recovery_evidence` (`20261029000600_sync_dispatch_recovery_evidence`) persists verified queue/execution observations outside the recovery completion transaction and atomically consumes them inside `verifyRecoveryDecision`. Consumption stores the actual execution fence/token atomically. | Validate under multi-host production deployment and failover conditions. |
| Actual callbacks | Built-in SQL enforces installation authority, recovery routing and fresh claim consumption. `createCatalogPhaseRuntime` wires `createSyncDispatchRecoveryVerifier`, `createSyncDispatchRecovery`, `createSyncDispatcher`, `createBullMQSyncWorker`, and `createBullMQRecoveryWorker` over `createSyncRedisTransport`. | Validate custom `verifyShop`, `needsRecovery`, and `verifyConsumption` policy overrides if enabled in production. |
| Exhausted-delivery scanning | The monitor is scheduled at runtime startup, bounded, non-overlapping and drained on shutdown. Tests prove it reviews delivery state without failing execution. The audit fixed obsolete installations filling the discovery batch ahead of eligible deliveries. | Verify monitoring/alert delivery and scheduling under production backlog and restarts. Retained obsolete records can remain in global state counts even though they are excluded from actionable exhaustion discovery. |
| Durable shop scheduling and fair-selection performance | Backfill and install/uninstall/reinstall/deletion tests pass. Service ordering persists across repository instances. A captured plan profiles the actual selection SQL with 500 eligible shops. | Establish production-scale query plans, contention, fairness and latency budgets. The publication barrier still serializes participating write transactions across shops. A local single-reservation profile does not close this blocker. |
| Worker/dispatcher/recovery races | Tests cover concurrent reservation and recovery ownership, late acknowledgments, expired owners, superseded phases, and a worker claim concurrent with delivery-recovery completion. The resulting receipt is CONSUMED with the successful execution fence. | Run end-to-end tests with deployed queue consumers, separate hosts and real queue retention/removal. Current concurrency tests use real PostgreSQL with injected transport behavior. |
| PostgreSQL commit uncertainty and Redis failure injection | Tests inject response loss after actual reservation, enqueue-ack and recovery COMMITs. Durable results are inspected without replay or compensating failure. Local timeout tests cover pending calls and late rejection. | Run real BullMQ/Redis disconnect, accepted-write/lost-response, restart, failover and delayed-command tests against a disposable transport. BullMQ is not installed or wired into the current app runtime. A Redis runtime/Docker executable was not available on this host's PATH during this assessment. No production Redis failure was injected. |

## Additional verification from this audit

- Backend: **832 passed**, zero failures, one existing TODO.
- Disposable PostgreSQL: **121 passed**, zero failures.
- New regressions cover enqueue-ack COMMIT uncertainty, recovery COMMIT
  uncertainty, worker/recovery contention, exhaustion-batch starvation and a
  fair-selection plan with 500 shops.
- The scanner now joins current installed shop/job authority before applying
  its batch limit. More than 100 obsolete-installation records cannot hide a
  current exhausted delivery from that batch.

The single local performance sample measured 84.7 ms for the reservation call,
including mapping/schema verification; selection planning took 22.2 ms and
selection execution took 11.6 ms. These are observations from a disposable local
database, not thresholds, production percentiles or performance approval.

Evidence files:

- `.audit/dispatch-release-audit-unit-test.txt`
- `.audit/dispatch-release-audit-schema-test.txt`
- `.audit/dispatch-fairness-plan.json` (full EXPLAIN ANALYZE/BUFFERS plan)
- `.audit/dispatch-release-installed-state.json` (read-only installed preflight)
- `.audit/dispatch-deploy-test-approved.json` (production-derived deployment validation)
- `.audit/dispatch-deploy-live-verification.json` (live deployment verification)
- `.audit/dispatch-deploy-live-status.txt` (all migrations up to date)
- `.audit/dispatch-deploy-live-diff.txt` (no canonical schema difference)

Live dispatch migrations were deployed following isolated validation. No real
Redis write or production failure injection was performed.
No production approval or automatic release gate is inferred from these tests.
