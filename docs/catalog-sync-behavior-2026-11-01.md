# Catalog sync behavior and verification — 2026-11-01

The Products page now displays up to 50 committed products from its current import before publication. Its shared three-second active poll refreshes those rows and the exact saved-product count. Preview rows have no editor links or enabled selection controls. Uncommitted rows and deleted products are excluded. The preview is a display DTO, never an authorized filter/selection snapshot. Full pagination, targeting and editing use the verified published catalog.

Editing is locked while status is unknown, paused, failed or incomplete. UI locks also cover bulk-edit/import routes; the Products table requires its loaded generation to match the completed import. Database triggers independently block mutation-command admission/reacquisition, dispatch authorization and token consumption until the latest installation import succeeds and publishes. Previously sent requests can still be acknowledged/recovered. A new sync waits for already-admitted edits and rejects unresolved remote mutations. Normal in-flight edits defer refresh scheduling without consuming its retry budget.

First-install intent is durable: opening the app again does not allocate another full import, including when the first import exhausted retries. The background scanner coalesces a refresh request when the last import attempt/publication is at least 72 hours old. It skips active staging work, pending requests and review-required work. Existing signed webhooks retain their durable revision journal and export/reconciliation refresh mechanism; this is not a new direct incremental writer into immutable published generations. Worker downtime delays scheduling until startup; unresolved/review-required work is not blindly restarted.

Applied migrations:

- `20261101000900_catalog_sync_edit_barrier`: lifecycle-only fixed-search-path database backstops; no product data changes or new logins.
- `20261101001000_catalog_dispatch_sequence_usage`: narrow USAGE grant on the catalog dispatcher's existing fairness sequence. A diagnostic transaction forced to roll back exposed PostgreSQL 42501 on `nextval`; this was the cause of repeated live `RESERVATION_FAILED` events. After the grant, reservation errors stopped and the real worker advanced through STARTING and WAITING into INGESTING. No diagnostic queue delivery or Shopify mutation was made.

Both migrations were rehearsed on fresh disposable clones before applying. The final ledger contains 46 completed migrations with none pending. Migration verification preserved 14,987 products, 15,034 variants and one shop. All three runtime profiles passed owner/BYPASSRLS checks over 61 tenant tables. These counts describe migration preservation; ongoing import writes may subsequently increase physical generation rows.

Verified checks:

| Check | Result |
| --- | --- |
| Existing Phase 1 PostgreSQL suite | 21/21, 9 suites; fixtures unchanged |
| New restricted-login PostgreSQL lifecycle scenario | Pass: 0→50→51 committed counts, preview bound/scope, reopen idempotence, edit lock/unlock, private-function denial, periodic suppression/coalescing, real concurrent advisory-lock race, fairness-sequence usage |
| HTTP/service regressions | 41/41 |
| UI regressions, including a rendered 50-row preview | 41/41 |
| Product/filter UI tests | 48/48 |
| Sync-worker regressions | 34/34, including failure diagnostics that cannot invoke accessors or expose private error messages |
| Production frontend build | Pass with the existing public Shopify client ID |

Evidence is in ignored `.audit/sync-*` logs. The live app is running under Shopify CLI. The 10:05:27 UTC observation confirmed 1,000 committed products / 2,000 durable JSONL lines during INGESTING, after the 09:57:56 observation still had zero products. The staged download was complete, but the import was not. Worker failures now log bounded code/constraint/stage data without raw error messages; a transient TRANSACTION_DEADLINE was observed and durable retry subsequently made progress. No timeout or fencing checks were relaxed. Chrome was restarted and Shopify now requires sign-in; automatic browser approval rejected the Google sign-in action because that method/account was not specifically authorized. Live embedded visual verification is pending sign-in. The last recorded database observation is in `.audit/live-sync-state.json`; do not confuse expected JSONL lines with saved products or claim the current import finished from worker phase advancement alone.

This is not merchant-scale performance sign-off or complete approved-selection-to-Shopify-worker certification. The first-50 preview uses the tenant/generation Shopify-ID index, but the exact saved count still scans that generation. Existing broader worker/performance verification gaps remain open. Shopify AI Toolkit documentation was consulted; its JSX validator still rejects ordinary documented `s-page`/`s-text` tags as missing intrinsic elements. Build, DOM behavior and PostgreSQL checks passed independently; no successful Toolkit validation is claimed.

Interface details: [catalog sync preview and edit barrier](backend-interface-contracts.md#catalog-sync-preview-and-edit-barrier).
