# Bulk Execution and Edit History verification

Verified 2026-10-31 against this checkout. Verdict: **blocked for production
mutation dispatch and history-backed undo**. Passing repository tests do not
certify the separate Bulk Execution worker's Shopify send boundary.

## Blocking findings

1. **P1 — The worker bypasses durable journal admission and detects stale ownership
   after sending.** `web/workers/operation.worker.js:258` calls `applyMutation`
   without `prepareRequest`, `beginDispatch` or `consumeDispatch`. Claiming commits
   before item processing (line 91). The fenced item update is at line 296, after
   the external call and an unfenced snapshot update (line 288). A superseded
   worker can therefore contact Shopify and update a snapshot before returning
   STALE_CLAIM. There is no worker-owned installation recheck or resource-family
   exclusion in this path. The history adapter's command transaction locks do
   not protect a worker that never calls it. Integrate the existing writer with
   journal admission, committed single-use consumption, current installation/
   claim/approval verification and resource-family coordination. A database
   lock alone cannot make a database commit and remote write atomic; loss of
   send certainty must become reconciliation work.

2. **P1 — A timeout followed by any changed value is falsely classified as
   success.** At worker line 270, `hash(reread) !== beforeHash` suffices to claim
   the mutation applied. A different app/merchant edit satisfies this condition
   even when the approved write did not apply. The probe requested `Approved`,
   observed `Unrelated edit`, and got SUCCEEDED. Preserve uncertainty and use
   authoritative execution receipts plus exact resource/field observations;
   different-from-before is not proof of the requested mutation.

3. **P1 — The normal acknowledgement is neither an exact resource check nor an
   authoritative AFTER verification.** Worker line 285 hashes the adapter's
   returned value and immediately confirms the snapshot. There is no successful-
   call reread, expected value comparison, or returned resource identity check.
   A response naming Product/999 with an unapproved title succeeds for the
   Product/101 item. Treat acknowledgement separately from verification and
   persist authenticated observations bound to each exact resource/field.

4. **P1 — Ambiguous writes are retried and the stored retry deadline is ignored.**
   The generic catch at worker line 310 routes timeout, stale observation and
   post-send database failures into RETRY/FAILED (line 320), without a durable
   uncertain outcome. Item selection at line 140 never checks next_attempt_at,
   although line 322 sets it; commands retry after 30 seconds irrespective of
   potentially longer item backoff. Expired RUNNING claims also lack an attempt-
   budget condition (line 59). The probe made two sends after ambiguous failures.
   Unknown writes require evidence-only reconciliation, not automatic resend or
   a no-write assertion; exhaustion must remain review-required. Enforce due
   times and budgets in authoritative claim/selection queries.

5. **P1 — Undo can overwrite an intervening edit it has already observed, and
   the V3 undo workflow is absent.** The worker checks the source after_hash at
   line 180, then rereads at line 222 for a new BEFORE snapshot without comparing
   that new value to the expected post-edit state. The probe supplied `Edited`
   for the eligibility read, `Intervening edit` for that second read, and the
   worker restored `Original` and reported success. In addition,
   `undo-service.server.js`, `undo-repository.server.js`, and
   `undo-conflict-detector.server.js` are empty, as are the history undo conflict
   and recovery test files. The legacy approved inverse command/conflict test
   is useful partial coverage, not a history undo implementation. Build the
   history eligibility/conflict/handoff workflow through the existing execution
   engine, preserving current policy checks, family coordination, fencing,
   durable inverse history and stable handoff idempotency.

## Verified boundaries

| Concern | Verified | Remaining boundary |
| --- | --- | --- |
| Dispatch | Journal admission rolls back atomically; distinct current dispatch permission and single-use hashed token; one concurrent consumer | Worker does not invoke these methods |
| Uncertain outcomes | Interrupted requests are discovered; evidence is authenticated; ACK is separate from verified observations; uncertain attempts block new admission | Worker uses generic failure/retry and changed-value heuristics |
| Exact identities | Tenant/install/job/item/resource/field/family lineage, authoritative plan fingerprints, pinned selection and variant parent membership; multi-resource pair uniqueness | Worker does not authenticate its returned mutation result or V3 AFTER observations |
| Idempotency | Durable bulk/undo command dispatch and outbox creation; full journal request replay; changed bindings rejected; lost COMMIT not blindly replayed | Command idempotency does not guarantee at-most-once remote mutation across worker crashes |
| Retries | History recovery claims/takeover/fencing, due time, bounded backoff, cancellation and review-required exhaustion | Legacy item due times and ambiguous resend are unsafe |
| Undo | Legacy inverse approval, original successful snapshot linkage, field normalization and initial conflict check | Empty V3 modules/tests and demonstrated intervening-edit overwrite |

All five mutation-evidence comparisons in the V2 upgrade trigger use
`IS DISTINCT FROM`; the earlier NULL comparison issue remains corrected.
The resource-family history index is an index, not an exclusion/dispatch lock.

## Evidence and reproduction

| Run | Result |
| --- | --- |
| `cd web; npm test` | 1,027 passed; one existing TODO; no failures |
| `cd web; npm run test:history:postgres` | 76 passed against disposable PostgreSQL |
| `cd web; npm run test:operations` | 18 passed against disposable PostgreSQL |
| `node .audit/bulk-history-worker-probes.mjs` | Five unsafe behaviors reproduced |

The diagnostic probes import the real operation worker with an in-memory
database/client fixture and no network. They intentionally assert observed
unsafe behavior to make these findings reproducible; their successful exit is
**not** a safety acceptance result. Lease loss is simulated by a zero-row fenced
completion update. Retry due-time behavior is supported by the actual selection
SQL; the diagnostic fixture does not model a PostgreSQL scheduler or clock.
PostgreSQL suites validate the separate durable repository/dispatch contracts.

`index.js` currently starts catalog, export and history-security maintenance
runtimes, but does not compose `createOperationWorker` with
`createHistoryRepository`. No live end-to-end mutation or undo was attempted.
No production code, live schema, credentials or dispatch settings were changed
by this verification. Keep mutation activation blocked until these integration
gaps have adversarial end-to-end coverage at the actual send boundary.
