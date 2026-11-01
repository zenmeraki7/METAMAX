# Schedule transaction boundary review — 1 November 2026

The service deliberately separates authenticated tenant execution from worker-only
control-plane bookkeeping. A persisted shop ID, schedule template, queued
occurrence or lease is not merchant execution authority.

Owner: [schedules.server.js](../web/services/schedules.server.js). Database role
contracts: [database-profiles.server.js](../web/security/database-profiles.server.js).

## Operation map

| Operation | Connection and transaction owner | Required scope and authority | Atomic effects |
| --- | --- | --- | --- |
| `createSchedule`, deferred targets | Merchant connection; service-owned READ COMMITTED transaction | Authenticated shop, shared publication barrier, transaction-local `app.shop_id`, current installation row lock; browser shop/client overrides rejected | Schedule row and immutable installation binding |
| `createSchedule`, frozen targets | Merchant selection service owns the protected selection transaction; schedule insertion reuses its client | Same authenticated tenant; selection verifies published coverage and membership; returned snapshot shop/installation must match | Frozen membership and schedule template referencing that snapshot commit/roll back together |
| `listSchedules` | Merchant connection; service-owned scoped transaction | Authenticated shop, current installation and explicit shop/installation predicates | No durable changes. The helper opens READ WRITE because installation verification uses a row lock; it is not an unscoped read |
| `cancelOccurrence` | Merchant connection; service-owned scoped transaction | Current authenticated shop/installation; lock exact occurrence | Bound command cancellation intent and occurrence cancellation/reconciliation state together; terminal FAILED rows remain immutable |
| `triggerDueSchedules`: discovery | Operation-worker connection; service-owned READ COMMITTED transaction | Intentionally global, issued operation-worker profile; due/enabled/live-installation checks, up to 10 schedule row locks with SKIP LOCKED | Locks due recipes; no product selection, approval or execution |
| `triggerDueSchedules`: per-row materialization | Same worker transaction | Set `app.shop_id` from each locked database schedule before INSERT. Installation triggers check current shop installation and owning schedule | Unique occurrence `(shop,schedule,scheduled_for)` and schedule next-run/last-run/fence advance in the same batch transaction |
| `processNextOccurrence`: installation/budget cleanup | Operation-worker connection; separate atomic autocommit statements | Intentionally global control-plane policies; current installation comparisons or exhausted retry/lease predicates | Invalid work becomes REVIEW_REQUIRED; exhausted pre-dispatch work becomes FAILED |
| `processNextOccurrence`: claim | Operation-worker connection; one atomic CTE UPDATE statement | Intentionally global; due time, live immutable installation, attempt budget, expired/live leases, SKIP LOCKED | Persist RUNNING status, incremented attempt/fence and private lease token; commit before merchant authentication or phase execution |
| SELECT, unfrozen targets | Merchant selection service owns protected transaction | Fresh opaque merchant context; authenticated shop, exact occurrence installation, field/filter/coverage/publication checks | Frozen selection/membership and fenced SELECT-to-APPROVE checkpoint share one transaction |
| SELECT, frozen targets | Merchant service owns outer scoped checkpoint transaction; snapshot getter delegates a separate protected read | Fresh merchant context; exact shop/installation, valid approved snapshot, expiry and size bounds; outer publication barrier remains held | Only checkpoint is written in outer transaction; approved snapshot is read, not copied or mutated |
| APPROVE | Merchant connection; schedule service owns scoped transaction; approval service receives its client | Fresh merchant authority plus independently authorized approval; current occurrence installation/fence/token/lease | Immutable approval and occurrence contract reference/checkpoint commit together |
| DISPATCH | Merchant connection; schedule service owns scoped transaction; dispatch gateway receives its client | Fresh merchant authority, current write authorization, exact approved snapshot/registry/mappings, bounded READ COMMITTED transaction | Command, items, outbox and occurrence command reference/checkpoint commit together. No direct queue or Shopify call |
| DONE outcome polling | Operation-worker connection; service-owned **tenant-scoped** transaction | Worker authority instead of fresh merchant context; shared publication barrier, `app.shop_id`, current immutable installation, owned occurrence lease and exact command/contract/snapshot links | Copy command disposition/counts to occurrence; terminal outcome waits for finalization ledger |
| Failure/backoff persistence | Operation-worker connection; separate atomic autocommit UPDATE | Intentionally control-plane; exact shop/id/phase/fence/token, RUNNING state and live lease | Persist retry/review disposition and release only the matching claim; stale owners update zero rows |

The scoped helper initializes `app.shop_id` through `lockPublication` before its
installation query. It holds a shared advisory publication barrier and a shop row
lock for the transaction. Its explicit server limits are 2 seconds for lock waits
and 30 seconds per statement. Begin/commit/rollback stay with the transaction
owner; passed clients do not transfer ownership to approval or dispatch.

## Why global operations do not require a merchant context

The operation-worker profile has explicit global SELECT/UPDATE policies on
`job_schedules` and `schedule_occurrences`, plus global installation-metadata
discovery. Catalog and selection payload reads retain tenant-scoped policies;
those control-plane exceptions do not authorize global product access. A worker
can discover and durably classify work
when merchant credentials are unavailable. `requireWorker()` rejects a merchant
facade before a global service operation can run.

The initial occurrence claim is committed before asking for the merchant context.
It is only scheduling ownership. SELECT/APPROVE/DISPATCH independently reload
merchant authority. Failure persistence must remain possible when that lookup
fails; requiring a merchant session there would strand claimed work.

DONE deliberately skips `getScheduleAuthContext`, but does not skip tenant scope
or installation fencing. It observes an already-dispatched command and its
finalization state; it cannot create another command, grant an approval or send a
mutation. DISPATCHED or phase DONE is not a success receipt.

`app.shop_id` on the worker connection is needed for scoped trigger/helper reads
and data access. It does not narrow the worker's intentionally global control
policies into a merchant permission grant. Explicit row predicates and lease CAS
remain mandatory.

## Concurrency, rollback and uncertain outcomes

- A failure anywhere in a discovery batch rolls back every new occurrence and
  all next-run/fence updates, including earlier tenants in that batch.
- Concurrent discovery uses schedule row locks and durable uniqueness; workers
  cannot create duplicate occurrences for the same scheduled instant.
- A cancellation or replacement claim makes an old phase checkpoint fail its
  CAS. Selection, approval or dispatch writes made on that phase's client roll
  back with the checkpoint.
- A lost phase COMMIT response can leave a durable advanced checkpoint. The
  failure-persistence CAS then affects zero rows and returns SUPERSEDED; recovery
  reloads the stored phase instead of publishing or mutating again.
- Occurrence failure persistence cannot clear a newer lease or overwrite a newer
  owner's state. The role tests force takeover during authentication and verify
  the old owner updates nothing.
- `createSchedule` has no creation idempotency key. Its contract does not promise
  exactly-once creation after a lost response; a caller must reconcile schedule
  metadata before blindly recreating an uncertain request.

## Verification added for this review

Actual-role PostgreSQL suite: **17 passed, 0 failed**. Four new boundary tests cover:

1. Merchant listing/creation isolation and rejection of merchant global discovery.
2. Rollback of a mixed-tenant discovery batch after its second occurrence fails.
3. Concurrent worker discovery across distinct shop installations, exact
   installation binding, no scope leakage and cross-shop cancellation denial.
4. Committed global claims visible before authentication, no phase execution with
   missing credentials, and fenced failure persistence after a newer owner wins.

Operation-dispatch PostgreSQL suite: **21 passed, 0 failed**. Its DONE polling
case now makes merchant-context resolution fail and verifies polling never calls
it. Existing tests cover cancellation during selection, frozen-target creation,
phase rollback, expired claims, lost approval/dispatch COMMIT responses and
outbox publication after commit.

Commands:

```powershell
npm --prefix web run test:roles:postgres
npm --prefix web run test:operations
```

These tests use disposable localhost PostgreSQL 18.6 with real restricted logins,
not the application database. Evidence: `.audit/schedule-boundaries-roles.log`
and `.audit/schedule-boundaries-operations.log`.

## Remaining operational considerations

No role grants, live schema or runtime behavior changed in this review.

The two global housekeeping UPDATE statements have no batch limit and do not use
the scoped transaction helper's server lock/statement limits. The pool's client
query timeout is not a substitute for a server-side statement timeout. This is a
boundedness/lock-contention hardening item, not a reason to add merchant context
to global recovery. No production-scale contention certification was performed.

Frozen-snapshot lookup delegates a protected read on another connection while
the outer checkpoint transaction holds its publication barrier. Approved snapshot
immutability and fresh later approval preserve the authority boundary, but
production pool budgets must accommodate nested reads and identity resolution.
Saturation under a deployed scheduler was not tested here.

The current source has no production composition invoking createSchedulesService
or its scanner from index.js/operation-supervisor. These results establish the
service's transaction contract and integration behavior, not deployment of a
running schedule dispatcher.
