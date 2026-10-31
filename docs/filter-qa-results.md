# Filter QA verification — 2026-10-28

These results describe the current workspace source, rather than the older
archive referenced by the findings.

| Finding | Current result |
| --- | --- |
| QA-001 | The trusted PostgreSQL executor is implemented. It checks compiler ownership and authenticated shop identity, takes publication protection before its first data read, verifies exact generation/revision/dependencies in the same transaction, applies timeouts, and bounds returned IDs and bytes. PostgreSQL tests prove blocked publication writers and rejection after retirement committed while a reader waits. |
| QA-002 | `mirror/coverage.js` and `services/mirror-schema.server.js` exist and are reused. A fresh-process import test resolves production modules without module mocks. Both suites pass from a separate source copy after a new lockfile-based dependency installation. Deployment mappings, repositories and coordinated production writers remain required. |
| QA-003 | Removed the unusable standalone `validateFilter` export. Public semantic validation requires `createFilterService` or `createFilterCompiler` with a genuine authorized Field Service. Tests reject missing configuration and service lookalikes; configured validation and live authorization are covered separately. |
| QA-004 | The controller and protected `/api/filters/search` route exist. The HTTP/PostgreSQL test covers valid pages, missing and expired sessions, cross-shop and changed-filter cursor reuse, malformed and oversized requests, and browser shop overrides. A request in the same authorized scope may safely repeat a read cursor. |
| QA-005 | The isolated PostgreSQL suite runs the real executor. It covers publication loss, same-transaction eligibility and timeout settings, server-side cancellation, connection reuse after rollback, bounded response bytes and scoped cursor reuse. |

Verification performed:

- `npm test`: 473 passed, zero failed, one existing TODO.
- `npm run test:postgres`: 15 passed, zero failed.
- Frontend `test:ui`: 12 passed; `test:products`: 34 passed; production build passed.
- A separate source directory without application environment files or existing
  dependencies: `npm ci --ignore-scripts --no-audit --no-fund`, followed by both
  suites, with the same results.
- Production import verification runs in a fresh Node process without module
  mocks. Test SQL mappings and HTTP identity verification are explicit fixtures;
  no permissive replacement production coverage or catalog service is installed.

This was a clean dependency installation of the current source snapshot, not a
clean Git checkout: the workspace contains uncommitted and untracked source.
Include these modules when committing or packaging the updated application.

Production execution remains unavailable by default. Actual source mappings,
publication/context repositories, Shopify authentication configuration and every
publication/mirror/coverage writer's participation in the shared transaction-lock
protocol are release prerequisites. The tests prove the protocol with coordinated
fixture writers; they do not prove an absent production writer participates.
The nine unreferenced zero-byte filter modules were subsequently removed after
confirming that active modules already own their responsibilities. No speculative
implementations were added. Transactional unit tests now reside in the requested
`filters/__tests__/execute.test.js`; their compiler-provenance checks and actual
PostgreSQL integration coverage remain separate. The current workspace suites
were rerun after this cleanup; the earlier clean-install run preceded it.

CI's isolated PostgreSQL job now installs from the lockfile, resolves production
imports, and runs both the full backend suite and the real executor/HTTP suite
on Node 22 and Node 24. The frontend/build job retains its test and build checks.
The updated workflow has not been dispatched from this local session.
