# Export and history audit follow-up — 2026-11-01

All four reported implementation issues were reproduced by source inspection and corrected in the full workspace.

| Finding | Resolution |
| --- | --- |
| Unbounded export replay memory | Repositories exposing persistent idempotency lookup allocate no replay map and retain no successful outcomes locally. Legacy atomic repositories retain at most 1,000 replay hints per service, expiring after 60 seconds and pruned on access. FIFO eviction and expiry fall through to the atomic repository, which remains responsible for durable idempotency/conflict checks. Tenant, installation and key use an unambiguous tuple encoding. |
| Incorrect history titles | List and detail derive titles from the same operation-type mapping: Undo Operation, Product Export, Product Import or Bulk Product Edit. |
| Partial operations presented as failed | `PARTIAL` becomes `Partial`, with its own badge, status filter and statistics card. List responses include verified, failed, uncertain and recorded field counts; rows, detail dialogs and CSV retain those counts. Failed and partial statistics are separate. |
| Unknown states presented as pending | Explicit pending states include RECORDING/PENDING/QUEUED. Unexpected or absent states become Unknown and emit `HISTORY_STATUS_UNRECOGNIZED` without logging arbitrary status strings. List and detail use identical mapping. |

The route output changes are additive. `processedCount` continues to mean verified field changes, `totalCount` recorded field changes; these are not product counts. Old responses/demo records without optional failure counts remain readable, while supplied counts must be safe nonnegative integers no greater than the total. Unknown states are not counted as active work.

## Archive claims versus the workspace

The reviewed archive itself is not available for re-inspection in this turn. Its completeness cannot be inferred from this checkout. However, the reported infrastructure omissions do **not** describe the full workspace:

- `web/index.js` and `web/app.js` provide startup and route registration.
- `web/shopify.js` configures the official Shopify Express OAuth/session integration; authenticated APIs and webhook verification are mounted in `web/app.js`.
- `web/frontend/index.html` loads App Bridge, and frontend React components exist under `web/frontend`.
- `shopify.app.toml` declares scope, OAuth callback and webhook configuration.
- Prisma schemas/migrations and backend/frontend manifests/lockfiles exist.
- All listed Mirror/auth dependencies exist. The history security runtime is correctly located at `web/edit-history/history-security-runtime.server.js`, and `web/index.js` imports that actual path. No duplicate `security/` compatibility file is needed.
- Express, BullMQ and the S3 SDK resolve in the installed production dependency tree; fresh-process imports and the full backend suite pass.

This does not certify production configuration or live services. The [Phase 2 report](phase-2-integration-integrity.md) still applies: PostgreSQL integration tests require the unavailable Docker engine/local PostgreSQL, export runtime-role provisioning remains unresolved, and live Shopify URLs, installed scopes and session/webhook behavior need deployment verification. No credentials, migrations or live-store configuration were changed here.

## Validation

- Full backend suite: **1,282 passed**, zero failures/skips.
- Frontend UI suite: **34 passed**; production frontend build passed with a placeholder public API key.
- Import audit: **480 files, 1,355 relative imports, 160 package imports**, no failures. All five computed dynamic imports belong to tests.
- New regressions cover absence of persistent-path cache inserts, legacy TTL and capacity eviction, list/detail title/status/count consistency, unknown-status diagnostics, denied history reads and rendered partial outcomes.
- Whitespace checks passed for changed tracked files with Windows CRLF handling.
