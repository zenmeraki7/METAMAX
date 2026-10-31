# Filter executor integration contract

`web/filters/execute.js` exposes `createFilterExecutor()` and preserves
`normalizePageSize()`. `POST /api/filters/search` is registered after Shopify
session authentication. It returns 503 until the application supplies a verified
runtime; it never falls through to the SPA or executes against guessed tables.

The factory takes server-owned dependencies:

- `database`: a PostgreSQL pool with `connect()` and releasable clients.
- `resolveShop(authContext)`: independently authenticates the session and returns
  its shop ID. Request-body shop IDs and compiled bindings are not authentication.
- `compiler`: the compiler instance that issued the query, configured with a
  signed cursor service when full pages require continuation cursors.
- `publicationService.requirePublished({ client, shopId, generationId,
  coverageRevision, datasets })`: protects and verifies publication using the
  supplied transaction client. It must throw on any eligibility mismatch.

`execute({ query, authContext })` accepts an original query issued by the exact
configured compiler instance. Global compiler provenance alone is insufficient:
execution rejects a different compiler or a wrapper impersonating its methods
before connecting, including for short pages that never create a cursor.
`compiler.getExecutionPlan(query)` retrieves private, immutable dependency metadata
linked to the dedicated compiler-owned resolution plan retained after validation.
Compilation revalidates that contract and compares the predicate's identity and
physical bindings with the retained plan. Copied or foreign validation contracts
cannot be compiled by supplying an otherwise genuine plan. The
executor uses that plan's exact dataset set for publication checks against the
query's pinned shop, generation and coverage revision. Version 4 queries carry
`requiredDatasets` and `resolverVersion`. The dataset array must be the exact
immutable array retained by the configured compiler, not a matching copy.
`execute` accepts only `query` and `authContext`; any separate `datasets` argument
is rejected, even if it matches. The controller forwards no preparation datasets. Keep
validation and fresh authorized compilation immediately before execution.
After acquiring publication protection, the executor resolves the current session
again and calls `compiler.authorizeExecution(query, authContext)`. The issuing
compiler retains the original validation contract privately and reruns its
authenticated field, operation, target, definition and mapping checks through the
Field Service. A provenance proof or dependency plan cannot skip this check.
The server transaction scope routes that revalidation's coverage repository read
through the protected executor client. Repositories must honor the supplied
`client`; using a separate pool connection can block behind a queued publisher.
Failure rolls back before the product query. Do not persist or deserialize
compiled objects as permission grants.

## Mandatory publication protocol

Physical schema verification is supplied by the existing
`web/services/mirror-schema.server.js`; include that module when packaging the
application. `filters/mirror-schema-verify.js` delegates to its declared contract
and shares its private capability provenance. No configuration object or copied
capability can substitute for a successful catalog check. Bootstrap must retain
its binding preflight and actual database verification before constructing a
usable compiler; missing production bindings remain a release blocker.

`filters/validate.js` is the single owner of SQL predicate and same-variant
correlation compilation. The complete-query compiler delegates to it, then
checks the retained resolution plan and adds pagination. It must not generate
another correlation expression from the plan's field list. SKU and price
requirements remain in one tenant/generation-scoped variant EXISTS, and
ambiguous mixed OR/variant NOT remain rejected.

The executor starts a read-only repeatable-read transaction and applies local
statement and lock timeouts before invoking the publication service. That
service must acquire transaction-scoped protection and verify the exact shop,
published generation, coverage revision, and completeness of every required
dataset on the same client before the product query runs.

`mirror/publication-service.server.js` uses an existing server-configured
`barrierTable: { schema, table }`. Readers acquire ACCESS SHARE before their first
SELECT. Every publication, retirement, cleanup, coverage mutation, mirror mutation
and migration writer must acquire ACCESS EXCLUSIVE using `lockForWrite(client)`
inside its transaction before accessing protected state. Neither method starts
or commits a transaction. This coarse barrier covers all tenants sharing the
relation; it favors correctness over write concurrency. It is compatible with
read-only transactions and transaction-pooled connections.

Reader locks alone do not prevent a writer that ignores this protocol from
revoking publication. Production publication writers are not implemented in this
repository. Their participation is a release blocker: configure neither the live
runtime nor a readiness override until every publication, coverage, reclamation
and mirror writer uses the same barrier. The integration tests coordinate actual
PostgreSQL writers and prove the protocol under that assumption, not compliance
of an external writer that is absent from the repository.

Timeout setup uses SET LOCAL rather than SELECT set_config, so it does not
establish a stale repeatable-read snapshot before the barrier. The first snapshot
read happens after any conflicting publisher commits. PostgreSQL documents this
ordering requirement in [LOCK](https://www.postgresql.org/docs/current/sql-lock.html).
After acquiring the barrier, publication checks use the caller's client and the
existing coverage validator to reject tenant, generation, revision and completeness
mismatches. The executor rechecks schema capability revocation after the lock wait.

## Runtime bootstrap

`createFilterHttpRuntime` in `web/services/filter-engine.server.js` accepts:

- The application's database pool and Shopify session storage.
- `schema` (from `createMirrorSqlSchema`), canonical `fieldMappings`,
  `mirrorSchemaVersion` and `sourceContractVersion` for live catalog verification.
- `fieldServiceFactory({ resolveShop, verifyCoverage })`, which must return the
  genuine Field Service with the application's authorization and dynamic resolver.
- `coverageRepository.getPublishedSnapshot(input)`. Outside execution this must
  read one committed, consistent snapshot. When `input.client` is supplied it
  MUST use that same transaction client, without starting another transaction or
  borrowing a pool connection. The coverage service's existing snapshot contract
  includes shop, generation, coverage revision, publication status, compatibility
  versions and one complete published row for every requested dataset.
- `publishedContextRepository.getPublishedContext({ shopId })`, returning a stored
  published execution context including operation ID and generation. The runtime
  captures an immutable copy. Controller validation and compilation establish
  the authorized dependency plan; preparation does not supply coverage authority.
- An existing `barrierTable` coordinated by all writers, and `cursorSecret` as a
  persistent server-only Buffer of at least 32 bytes.

Await this factory at server startup and pass its result to
`createApp({ shopify, staticPath, filterRuntime })`. The returned `capture` middleware
is created only after the trusted source/binding registry preflight succeeds.
If `FIELD_SOURCES`, `FILTER_BINDING_DEFINITIONS`, or `FILTER_SQL_SCHEMA` is absent,
bootstrap rejects before calling the Field Service factory or connecting to the
database. A Prisma schema or dataset enum does not satisfy this prerequisite.
The `capture` middleware
must run after Shopify session validation; it creates opaque request contexts.
Each shop resolution reloads session storage and rejects revoked, expired or
changed-shop sessions. No request body can supply an authentication context.
Missing or empty verification adapters fail construction, missing authenticated
sessions return 401, and unconfigured routes return 503. A callable adapter by
itself is not evidence of production readiness; the real Shopify verifier and
session storage must be configured at deployment.

The reviewed production source/binding definitions are now installed; see
`docs/source-registry.md`. The current `index.js` still supplies no runtime:
the live mirror tables, publication/context repositories, authorization wiring
and coordinated writers are not deployed. Do not activate the runtime until those
actual contracts and writer coordination exist. The factory fails on missing or
unverified dependencies. Existing mirror-schema and coverage implementations are
reused; these files do not need replacement.

## Removed obsolete scaffolding

All nine zero-byte filter modules had no imports, exports or runtime consumers.
They were unused scaffolding, not missing production implementations. Their
responsibilities are served by existing modules:

| Removed file in `web/filters/` | Existing implementation |
| --- | --- |
| `compiler.js` | `compile.js` |
| `contract.js` | Private service-bound validation contracts in `validate.js`; version metadata in `contracts.js` |
| `coverage.js` | `web/mirror/coverage.js` |
| `dependencies.js`, `planner.js` | The compiler's private, validated execution plan in `compile.js` |
| `normalize.js`, `operators.js` | `web/fields/normalize.js` and `web/fields/operators.js` |
| `registry.js` | Trusted compiler bindings in `bindings.js` and canonical Field Engine registries |
| `schema.js` | `ast.js`, `mirror-schema.js` and the physical schema verifier |

The physical-planning resolver profile and its provenance assertion follow the
explicit contract documented in `docs/filter-resolution.md`.

The returned result contains bounded product IDs, the pinned generation and
coverage revision, and an optional signed cursor. The compiler requests
`pageSize + 1` rows. The executor validates the bounded result (including the
sentinel), removes the extra row, and sets `hasMore` only if that row exists.
The next cursor uses the last returned ID so the sentinel appears on the next
page. An exactly full final page has `hasMore: false` and no cursor. The 512 KiB
result-ID budget also bounds the lookahead row. Pagination and long-running
jobs still require publication retention and immutable target-snapshot rules
from the consuming service.

This is execution contract version 4, upgraded from the previous version 3.
Deploy the compiler and executor together; older query objects are rejected.
The signed cursor wire contract is unchanged. Each compilation rechecks the
real physical schema before live semantic revalidation, then re-resolves the
physical plan before query issuance. Correlation SQL remains in `validate.js`.

Verification: `cd web` then `npm test` for unit and HTTP checks. Run
`npm run test:postgres` for the isolated PostgreSQL suite, which now uses the
real executor and publication service for result semantics, signed pages,
publication changes after compilation, blocked writers and retirement committed
while a reader waits. The runner requires Docker or an existing portable binary
directory in `FILTER_POSTGRES_BIN`; it never uses the application's DATABASE_URL.

The PostgreSQL suite also exercises server cancellation and clean connection
reuse, actual oversized result pages, and the HTTP router/controller/runtime
with valid, missing, expired and cross-shop fixture identities. Cursor replay
within the same authorized scope is repeatable; reuse for a different shop,
filter or generation is rejected. The HTTP integration's identity verifier is
an explicit fixture, while field resolution, coverage, catalog verification,
compilation and execution use their real implementations against isolated data.

Semantic validation is exposed only through `createFilterService` or
`createFilterCompiler`, both requiring the genuine configured Field Service.
The unusable standalone `validateFilter` export has been removed.

`filters/__tests__/execute.test.js` contains page-size, provenance and transactional
execution tests, including publication denial, timeout configuration, rollback,
connection failure and response bounds. `compile.test.js` separately verifies
execution with genuine compiler-issued plans; the PostgreSQL suite verifies the
complete runtime against the database. The former duplicate test filename
`executor.test.js` has been consolidated into `execute.test.js`.

CI installs dependencies from lockfiles. Its isolated PostgreSQL job now runs
the complete backend suite (including fresh-process production import checks)
and the real executor/HTTP PostgreSQL suite on both Node 22 and Node 24. The build
job also runs both frontend test suites and the production build. CI must pass
on the committed source before deployment; local results do not establish that
an unsubmitted GitHub Actions run has passed.
