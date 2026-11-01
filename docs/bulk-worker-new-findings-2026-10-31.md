# Bulk worker findings NEW-01 through NEW-06

## Existing protections verified

NEW-01: the current worker already runs a fenced heartbeat. Renewal is now factored as `renewClaim()`. It matches the exact shop, installation, command, fence and token, requires an active installation and unexpired uncancelled RUNNING command, and never revives an expired claim. Transport wrappers check ownership immediately before calling a resource adapter and propagate the heartbeat abort signal. Regression tests cover slow items, failed/hung renewal, in-flight abort and final acknowledgment races.

NEW-02: both existing-dispatch branches already reload the current approval and check current write permission and tenant/installation identity. Tests cover replay, concurrent insert losers, permission revocation, approval changes and reinstalls. Existing authorized receipts now also expose the durable merchant result.

NEW-04: the current worker already stops on stale errors at both the item exception boundary and the enclosing processing boundary. Ownership lost during verified/uncertain inspection or local completion recovery returns `STALE_CLAIM` without retrying the mutation. Tests cover these secondary failure paths.

## NEW-03: resource outcomes

Commands now persist an aggregate result containing successful, failed, pending, uncertain, cancelled and total resource counts. Journal uncertainty is counted independently of item status. A terminal mixed result now persists command status `PARTIAL` and reports `PARTIAL` in the receipt and audit event. This replaces the earlier internal `FAILED` classification; see [the current rollout and verification notes](bulk-edit-reliability-follow-up.md). A batch awaiting more work explicitly reports `IN_PROGRESS` with `terminal:false`; it cannot be mistaken for terminal partial success. Counts include earlier claims, not just the current batch. History finalization also treats a failed engine command with verified changes as partial, even when all journaled changes succeeded and other failed items never reached journal admission.

## NEW-05: independent discovery

Ambiguous-evidence or recovery-scheduling failures now raise `HISTORY_RECOVERY_PERSISTENCE_FAILED`, preserving persistence results and underlying errors. The worker reports this as an operational incident and stops processing without another mutation attempt.

The supervisor independently scans expired/inactive command leases for durable interrupted dispatch requests. It does not depend on an error marker, ambiguous evidence, or task written by the original worker. A separate scan token, fence and lease, retry deadline, sanitized error and bounded attempt counter are stored in `job_commands.checkpoint.recoveryScan`. Failed discovery is retried with bounded backoff and emits structured error/review alerts. Successful discovery schedules the existing durable History recovery tasks; it never replays a Shopify write or infers success from changed current values.

Composition now requires `executionProviders.resolveRecoveryAuth({shopId,installationId,executionJobId,workerId,operation,signal})`. This must resolve independently authorized tenant recovery credentials. It receives no expired execution claim. History verifies the resolved tenant against the discovered shop/installation and limits discovery to that exact command, independently authorizing discovery and scheduling. Missing credentials fail closed and remain visible for review. The scanner covers current active installations; old-installation uncertainty requires explicitly authorized investigation rather than granting an old claim authority.

## NEW-06: finalization

The existing finalization ledger atomically records terminal command reconciliation needs and retries History and Undo separately. It is independent of the original worker process. Logs now include shop/command identity and review escalation. A task abandoned on its last attempt is durably marked `REVIEW_REQUIRED` and emits an alert. One failed maintenance phase no longer prevents other reconciliation phases or command processing from running.

Structured `logger.error` events are the alert integration point; no external notifications were configured or sent. Operators should monitor `recoveryScan` errors/review states and `mirror.operation_finalizations` backlog/review states. The prior `20261031190000_operation_finalization` migration remains required. These changes add no migration.

## Verification

All 1,161 backend tests pass. Added cases cover 9-success/1-failure partial results, unfinished and uncertain counts, persistence incidents, independent scanner authentication/fencing/backoff, authorized idempotent partial receipts and finalizer review alerts. PostgreSQL cases were added for discovering a consumed dispatch with no original recovery task and rejecting mismatched recovery tenants. Database integration remains unverified locally because `npm run test:schema` cannot start Docker (`spawnSync docker EPERM`). No database changes were deployed.
