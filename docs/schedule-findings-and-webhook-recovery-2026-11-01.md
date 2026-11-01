# Schedule findings and webhook recovery verification — 2026-11-01

## A — Tenant initialization already precedes protected reads

In the current checkout, `services/schedules.server.js::transaction` calls
`lockPublication(client, shopId)` before reading `mirror.shops` or invoking the
callback. `mirror/publication-lock.server.js::lockPublication` sets the
transaction-local `app.shop_id` before its advisory lock. Thus the helper already
initializes tenant context indirectly. A comment now makes that dependency
explicit. Adding another GUC assignment is unnecessary.

Real merchant logins verify create/list isolation, foreign occurrence cancellation
denial, and scope reset after commit. A failed cross-shop write aborts the
transaction and rolls back an earlier permitted write. These checks do not rely
on an owner role bypassing RLS.

## B — Discovery remains an intentionally global atomic batch

The issued operation-worker profile discovers at most ten schedules with
`FOR UPDATE SKIP LOCKED`. Before each occurrence INSERT it assigns the persisted
schedule's shop to the transaction-local GUC; installation triggers bind the
occurrence to the live installation and owning schedule. Occurrence creation and
schedule advancement commit together. The mixed-shop tests verify separate
installation versions, concurrent discovery without duplicate occurrences,
scope reset, and whole-batch rollback when the second insertion fails.

This is not a per-shop transaction design. Separating discovery from processing
would change the batch atomicity and require reacquiring and revalidating each
schedule before advancement. The existing design is retained. Discovery rows
never grant execution authority: phase execution reauthenticates and checks
installation, claim fence, token and lease.

## C — Effective worker permissions and the removed excess grant

New adversarial SQL checks run through a real non-owner, NOBYPASSRLS operation
worker login after all 50 migrations:

| Object | Allowed | Verified denied |
| --- | --- | --- |
| `execution_contracts` | SELECT and UPDATE of `_history_lock` | INSERT; approval status/payload UPDATE; DELETE |
| `job_commands` | Global SELECT and UPDATE | INSERT; DELETE |
| `job_schedules` | Global SELECT and scheduling-column UPDATE | INSERT; template UPDATE; DELETE |
| `schedule_occurrences` | Global SELECT, INSERT and UPDATE | DELETE |

The previous command INSERT grant was broader than current worker call sites require:
command creation is implemented by the merchant-profile dispatch gateway, whereas
the operation worker claims and updates existing commands. Forward migration
`20261101001400_operation_command_creation_boundary` removes that unused grant.
`verifyRuntimeDatabase` now rejects any reachable command INSERT privilege for
the operation-worker profile. The adversarial role test temporarily restores the
grant, verifies rejection, revokes it, and verifies compatibility again.
Global command UPDATE remains part of worker lifecycle authority;
tenant metadata is not a substitute for the trusted worker credential.

The standalone real-role suite passed **18 tests, zero failures/skips**.
Evidence: `.audit/finding-c-roles.log`.

The forward migration was deployed to the configured `newmeta_app` database.
All **50** local/live migration checksums agree. The catalog counts remained
one shop, 21,987 products and 22,034 variants. A fresh migration replay matches
live DDL, all 106 RLS policies, object and column ACLs, normalized ownership and
application-schema default privileges. Existing configured merchant, catalog
worker and operation worker credentials pass read-only role verification.
Live history runtime/maintenance/privacy credentials remain unconfigured; their
local restricted-role checks do not certify live credential deployment.
Evidence: `.audit/operation-role-repair-result.json`, `.audit/drift-summary.json`,
and `.audit/live-role-verification.json`.

## D — Crash before the occurrence checkpoint

The added PostgreSQL test delegates to the real merchant dispatch gateway and
throws after it has inserted the command, all items and the durable outbox event,
but before the schedule service records `command_id`. It verifies:

- The occurrence remains at DISPATCH with RETRY, the same snapshot/contract, and
  no command ID.
- The first command, its items and its outbox event are all absent after rollback.
- Reclaiming an expired worker lease increases the fence and creates exactly one
  command, 205 items and one outbox event for the original contract and snapshot.
- No direct queue publication occurs inside either transaction.

The operation suite passed **22 tests, zero failures/skips**. The existing test
also covers the other side of the boundary: approval and dispatch COMMIT succeed
but their responses are lost; resumption does not create a second command.
Evidence: `.audit/finding-d-operations.log`.

This injects an exception at the crash boundary; it does not kill a PostgreSQL
backend or certify production connection-loss timing.

## E — Historical BullMQ failure rerun

The exact legacy test file is absent from the current checkout. The last retained
source was restored from Git commit `285db44` into an ignored audit directory.
Its test source matches the Git blob after normalizing archive CRLF conversion.
The assertion is line 327 in that version; the captured failure log used line 326.
The assertion, polling logic and original ten-second deadline were preserved.

Using the legacy locked dependencies (BullMQ 5.81.5, Prisma 7.10.1), all 15 legacy
migrations, a disposable PostgreSQL 18.6 database and a private Memurai Redis
7.2.5 endpoint:

- The targeted run passed all **3 selected tests**, including the original
  simulated Redis enqueue failure after the database commit and the named BullMQ
  scanner recovery case.
- The complete historical webhook test file passed **12 tests, zero
  failures/skips**. The scanner case completed in approximately 143 ms.

The original `dirty === false` assertion passed; the historical failure did not
reproduce. The outage scenario throws the original enqueue error after commit;
it does not shut down the Redis server. The BullMQ scanner case uses actual local
Redis, with Shopify reads supplied by the original test fixtures. These local
results do not explain the original failure or certify remote Neon/Redis latency.

Evidence: `.audit/priority4-legacy-test.log`,
`.audit/priority4-legacy-full-test.log`,
`.audit/priority4-legacy-result.json`, and
`.audit/priority4-legacy-full-result.json`.

The production database and shared Redis service were not used by these tests.

The current backend suite also passes **1,337 tests, one skip, zero failures**
after the privilege change. Its HTTP fixtures require localhost access; the
sandbox-only attempt returned EACCES, and the rerun with localhost access passed.
Evidence: `.audit/finding-c-backend.log`.

## Other unresolved validation limits

The [integration report](integration-migration-test-run-2026-11-01.md) records the
export runtime startup privilege mismatch: the merchant role cannot access
`export_engine`, although the export integration suite passes with its fixture
owner. A passing owner-backed suite does not certify production-role startup.
The [schedule boundary review](schedule-transaction-boundaries-2026-11-01.md)
records unbounded global housekeeping updates and the lack of production
scheduler composition. Those findings remain open.
