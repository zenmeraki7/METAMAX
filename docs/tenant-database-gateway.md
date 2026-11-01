# Tenant Database Gateway: implementation and rollout boundary

**Current rollout:** see [tenant-security-rollout-2026-10-31.md](tenant-security-rollout-2026-10-31.md). The production credential/RLS changes and restricted runtime facade described there supersede the earlier pending status below. Legacy adapters are retained as restricted infrastructure paths; only the source-read path was converted to named statements in this rollout.

The new gateway is `web/security/tenant-db.server.js`. It uses the app's actual `pg` driver rather than adding an unused Prisma transaction path. It does not replace existing repositories automatically.

## Findings disposition

| Finding | Implemented | Remaining boundary |
|---|---|---|
| TDB-001 | Repository callbacks receive only operation-bound named statements; no client, pool, raw SQL or tenant-setting method. Verifier inspects runtime/reachable roles, ownership, effective policies and table privileges. | Production credentials/grants and each registered SQL statement still require review. |
| TDB-002 | Authority validates context, operation, worker-operation binding and exact mode before pool acquisition. Authorization is repeated inside the transaction. | This admission check is not an authorization grant. |
| TDB-003 | Shared/exclusive publication barriers coordinate installation readers with existing install/uninstall writers. Exact job_commands verification and renewal use current schema, leases, fences, kind, installation and RUNNING state. | Worker repositories must retain fences on every critical transition; these utilities do not replace durable external dispatch. |
| TDB-004 | Installation lookup uses SELECT without FOR UPDATE; shared transaction advisory lock works in READ ONLY. READ COMMITTED ensures fresh state after waiting for the lock. | New lifecycle writers must use the same exclusive barrier. |
| TDB-005 | Per-operation statement/lock deadlines, idle transaction limits and bounded callback deadline. Existing pool connection-acquisition limits remain infrastructure configuration. | Long-running jobs must checkpoint outside short transactions. |
| TDB-006 | No automatic replay. | Replay needs a separately proven idempotent contract, not a retryable SQLSTATE alone. |
| TDB-007 | Serialization/deadlock conflicts, capacity/timeouts, permanent failures and uncertain connection outcomes are distinguished. | Classification does not authorize replay. |
| TDB-008 | New gateway repositories cannot access raw clients; handles expire at transaction completion. | Existing direct pool/Prisma repositories have NOT all been migrated or certified equivalent. This remains a rollout blocker. |
| TDB-009 | Statement registry, verifier and timeout policy come only from trusted bootstrap. | Never construct them from request or job data. |
| TDB-010 | Actual PostgreSQL tests use a separate non-owner LOGIN role with NOBYPASSRLS, RLS-enabled real mirror.products, USING/WITH CHECK policies and intentionally adversarial role/policy changes. | RLS was configured only in the disposable test cluster. The live application database has NOT been inspected or changed. |

## Statement registry

Only trusted bootstrap may register `{name, mode, operations, sql, validateValues}`. Registry entries and operation lists are copied and frozen. Repository code calls `repository.run(name, values)`. Names resolve only from that registry and must match the authorized operation and transaction mode. Validators must return detached bounded parameter arrays; SQL is server-owned and parameters begin with `[shopId, installationId, installationVersion]`, followed by validated values. Statements must explicitly bind these values and use verified tenant, installation and generation scope as applicable. The gateway does not parse SQL to prove its semantics; review or compiler provenance remains mandatory. Never register browser SQL or user-controlled identifiers.

The root pool stays private to trusted composition. `verifyDatabase` should be the verifier produced by `createTenantDatabaseVerifier({tables})` for the exact reviewed relation set, not a permissive placeholder. Missing RLS, missing tables, owners, reachable elevated roles, TRUNCATE/TRIGGER privileges or unreviewed applicable policies fail closed. The verifier currently accepts one precise all-command USING/WITH CHECK policy shape. More complex policy sets need explicit review and verifier extension; they are not silently trusted.

The new authority `assertOperation` is admission-only. `runAuthorized` still revalidates installation, permissions and worker ownership in the supplied active transaction. Raw transaction clients reach only those trusted infrastructure adapters; repository callbacks receive no raw transaction access.

## Worker schema and external mutations

`tenant-db-adapters.server.js` uses actual `mirror.job_commands` columns: bigint id, shop_id, installation_version, kind, fence, lease_token, lease_until, status RUNNING and cancel_requested_at. The supported write namespace is mirror.job_commands with bulk_edit/undo. Verification locks the owned command; renewal performs another conditional UPDATE with the same exact ownership and rejects zero affected rows. Unsupported worker namespaces are denied, not generalized from browser payloads. Existing workers, history journals, dispatch authorization and uncertain-outcome recovery remain unchanged.

## RLS limits and rollout

Tenant GUCs are context, not credentials. A role with arbitrary SQL can change them. Tests deliberately show that switching app.shop_id on the private runtime connection changes the rows RLS exposes. Named statement confinement, explicit scope/authorization, least privileges and composite tenant constraints are therefore required in addition to RLS.

Table owners are rejected by the gateway verifier even when FORCE RLS is enabled, and BYPASSRLS/superuser roles or reachable elevated memberships are rejected. Non-owner non-bypass roles obey enabled RLS without relying on owner semantics. Composite tenant/generation foreign keys already have separate schema regression coverage; this gateway adds no relaxation.

No blanket RLS migration was applied to mirror tables: enabling RLS without first provisioning policies for every existing runtime path would disrupt the currently installed catalog/history/export services. No existing authorization path was replaced by a GUC check. Production deployment remains blocked on provisioned restricted credentials, reviewed policies/table registry, concrete trusted authority adapters, and migration or equivalence review of each legacy repository. The application still exports its existing pool from web/db/postgres.js for legacy bootstrap; that is not claimed fixed by introducing this module.

## Verification

Five focused gateway tests cover preflight rejection without connections, hidden/revoked handles, unknown statements, rollback without replay, SQLSTATE classification and bounded configuration. Eleven authority tests remain passing. Full backend: 1,065 passed and one existing TODO.

Disposable PostgreSQL schema/catalog suite: 159 passed, including gateway reads as a restricted login, denial of other-shop records, rejection of writes in READ ONLY, local-setting cleanup, exclusive lifecycle-lock contention, owner/superuser rejection, inherited BYPASSRLS rejection, extra permissive policy rejection and disabled-RLS rejection.

Disposable PostgreSQL history suite: 93 passed, including exact owned-worker verification, renewal, then stale-fence rejection on actual job_commands rows. Logs: `.audit/tenant-db-{backend,schema,history}.log`.

No live Shopify, live database credential audit, production role changes, production RLS changes or full repository migration occurred.
