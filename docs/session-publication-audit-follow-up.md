# Session, installation, summary and publication audit — 2026-11-01

## Confirmed corrections

1. **Strict protected identity versus legacy storage validation.** `isValidShopifySession()` remains a credential/expiry validator compatible with legacy stored records; it is explicitly insufficient to authorize requests. `shopifySessionEvidence()` requires a boolean `isOnline` and a valid actor ID for online sessions. Official protected middleware, request verification, filter capture, installation guard and tenant-admin authentication use that stricter policy. Unclassified sessions no longer proceed through protected middleware.
2. **Installation-bound authority.** Filter capture issues no context without a trusted installation resolver. It captures branded lifecycle coordinates and rechecks that exact lifecycle on every session/tenant resolution. It also compares the installation already checked by the common request guard, preventing rebinding between middleware stages. Tenant-admin authentication now requires a lifecycle resolver, rechecks active installation on every call and returns the pinned coordinates. Tenant Authority compares those coordinates with its independent installation lookup before issuing capability authority. Uninstall or reinstall invalidates prior request contexts.
3. **One session replacement policy.** `verifyCurrentShopifySession()` compares immutable primitive evidence for session ID, shop, credential, online/offline classification and online actor ID. It rechecks validity/expiry and is used by guard, filter and tenant-admin paths. An in-place mutation of the original session object cannot rewrite the comparison baseline. Credential rotation invalidates an in-flight authenticated request; a new request must authenticate again. Scope changes remain freshly loaded policy inputs, not cached permission grants. No credentials are included in identity DTOs or diagnostics.
4. **Fresh catalog counts.** No production invalidation calls were found for the summary cache. Rather than relying on process-local invalidation across catalog workers, the cache was removed. Each page reads counts from persisted data in its protected transaction, including repeated reads of the same shop/generation. `clearCatalogSummaryCache()` remains a compatibility no-op. This adds a count query per page and trades the prior cache optimization for correct incremental/recovery behavior. It does not change pagination generation pinning.

## Publication transaction audit

The lock helper does not own BEGIN/COMMIT; callers must retain the same transaction client through protected work. PostgreSQL already rejects its `LOCK TABLE ... IN ACCESS SHARE MODE` statement outside an explicit transaction with `25P01`. That transaction-only statement is now first, before tenant GUC or advisory-lock acquisition. `ACCESS SHARE` is a DDL fence; shared/exclusive transaction advisory locks remain the publication barrier.

| Caller family | Transaction owner / protection |
| --- | --- |
| Filter execution and selection materialization | `filters/execute.js` and `services/selection.server.js` own READ COMMITTED transactions; acquire barrier before protected data statements; release on commit/rollback. |
| Mirror mutators, reconciliation and publication repository | `mirror/transactions.server.js` owns bounded READ COMMITTED transactions; same-shop exclusive barrier wraps mirror changes. The publication repository's standalone read owns its transaction; supplied-client reads remain subordinate to the executor transaction. |
| Merchant dispatch, tenant gateway and source reads | `security/merchant-gateway.server.js`, `security/tenant-db.server.js` and `security/repositories/sync-sources.server.js` own transactions before acquiring the barrier. |
| Worker completion and history dispatch | Worker gateway owns its transaction. History repository owns SERIALIZABLE transactions passed to the history execution adapter; exact publication row locking and coordinate verification supplement advisory protection. |
| Export repository and generation protection | Export repository owns transactions and passes the same client to generation protection. It awaits protection and protected work before commit. The public protection/service methods require an existing transaction. |
| Schedule freezing | Schedule service owns its transaction or runs its snapshot writer on the selection executor's protected transaction; the lock stays held through the write. |

No production autocommit lock call was identified. A unit regression ensures a failed transaction-only table fence prevents advisory acquisition; a real PostgreSQL autocommit-rejection case was added to the disposable schema suite, alongside existing wait/commit, cross-shop independence and writer-blocking cases. **The real database cases could not run** because Docker's Linux engine remains unavailable; source inspection and mocks do not certify PostgreSQL contention, RLS or migration behavior.

## Validation

- Full backend suite: **1,292 passed**, zero failures/skips.
- Import/dependency audit: **482 files, 1,365 relative imports, 160 package references**, no failures.
- New regressions cover missing classification/resolver, credential/session/shop/actor replacement, online expiry, uninstall/reinstall, the guard-to-filter lifecycle boundary, independent Tenant Authority lookup mismatch, same-generation count changes and autocommit fence failure.
- Existing test fixtures now use explicitly classified sessions and real trusted installation resolvers. Disposable integration fixtures were updated and syntax checked; they have not been database-verified.
- `test:schema` was attempted again and failed to reach `dockerDesktopLinuxEngine`; no live database was contacted or changed. Previously reported export-role and live Shopify deployment checks remain unresolved.
