# Canonical consistency fixes — 2026-10-31

SEM-001: RECONCILING and PUBLISHING both process late webhook revisions. A live, fenced execution can reopen its unpublished VERIFIED staging generation, invalidate coverage receipts, reconcile the latest revisions, and verify coverage again. Publication rechecks dirty state under the same transaction barrier as publication. Phase evidence permits late dirty work to advance to PUBLISHING, where reconciliation is mandatory; it does not permit dirty publication. Already published generations remain immutable.

Deploy `web/prisma/migrations/20261031130000_reopen_verified_staging/migration.sql` before deploying the updated catalog worker. This migration replaces the generation-status guard, permitting only the narrowly guarded VERIFIED-to-RECONCILING transition. It does not change tables or existing snapshot contents. It has been exercised on disposable PostgreSQL, not applied to the application's database.

WORKER-001: successful item completion resets the command's consecutive no-progress retry counter. Successful batches no longer consume a fixed maximum of eight claims. Per-item failure counters remain bounded, and abandoned/no-progress command claims retain their retry limit. Unit regressions run 201 bulk and already-verified undo items through nine real worker scheduling invocations; the history capability and database are fixtures in these scheduling tests.

API-001: the toolbar prevents mixed product/variant Match any combinations both when switching match mode and when adding a filter to an existing Match any group. It explains that mixed groups require Match all. Same-entity Match any remains available; compiler correlation restrictions are retained.

Regression coverage includes both real PostgreSQL late-webhook windows (before phase evidence and before publication), large worker continuations and abandoned claims, and rendered toolbar interactions. The existing sync-source unknown-status timestamp check also passes in the current working tree.

Verification logs are in `.audit/canonical-fix-*.log`. Backend: 1,049 passed, one existing TODO. Frontend: 42 product tests and 27 UI tests passed; production build passed with a nonsecret placeholder key. PostgreSQL filter suite: 20 passed. PostgreSQL schema/catalog suite: 158 passed, including both injected webhook races.

PostgreSQL history suite: 92 passed, including the actual journaled operation worker and retry-deadline checks.
