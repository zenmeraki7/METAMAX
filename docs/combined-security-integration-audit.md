# Combined security integration audit — 2026-11-01

The full workspace was reviewed across middleware, security, fields, filters, Mirror, dispatch, workers and history. Archive-only unresolved-reference counts do not identify broken imports in this checkout.

## Installation and dispatch boundaries

The installation resolver intentionally supplies point-in-time branded identity; it is not a lease. Merchant dispatch already compares that version with the active `mirror.shops` row **inside its dispatch transaction**, after publication protection, and holds the row `FOR SHARE`. An uninstall/reinstall update must wait for that transaction to end. Both existing-receipt branches reload the approval/current write permission; worker execution separately rechecks exact installation, command, fence and lease before authorizing work. New regression coverage also tests that the installation row remains locked after a successful dispatch savepoint is released.

Caller-supplied transactions now have an explicit enforced contract:

- Dedicated merchant connection, not a pool; explicit READ COMMITTED READ WRITE transaction.
- Nonzero `statement_timeout` no greater than 30 seconds and `lock_timeout` no greater than 2 seconds, read from PostgreSQL settings.
- `SAVEPOINT metamax_dispatch` proves an explicit transaction before profile verification; autocommit is rejected by PostgreSQL. Runtime merchant-profile verification still runs.
- Tenant context, publication protection and exact active installation locking occur within that transaction.
- Failure rolls back the dispatch's changes to its savepoint. Success releases the savepoint while outer locks remain held. The gateway never commits the caller's transaction; returned receipts are provisional until the caller commits.
- Callers must await dispatch and retain exclusive use of their connection. Concurrent dispatch calls on one external connection are rejected across gateway instances. The caller owns outer rollback/commit and must roll back/discard on savepoint recovery failure.

The schedule transaction owner now explicitly selects READ COMMITTED. The internal delivery requeue transaction and disposable outbox integration fixture satisfy the same timeout/isolation contract. Existing standalone dispatch retains its internally owned transaction and current authorization checks.

No application code can make an arbitrary trusted server callback safe if that callback independently commits/releases its connection during dispatch. This interface is server-only and requires the ownership contract above; it is not a route or a browser-supplied capability.

## Maintenance independent of the HTTP process

Added a scheduler entry point:

```sh
npm --prefix web run history:maintenance
```

It does not open an HTTP listener or require `start()`. Each invocation verifies dedicated maintenance/privacy credentials and the keyring, performs up to five bounded purge batches plus one bounded legacy-encryption batch, then closes pools and clears key buffers. Concurrent `runOnce()` calls in the same runtime join one pass. Repository transactions continue to enforce their existing limits, locks and evidence checks; there is no assumed exactly-once scheduler delivery.

Successful output contains only counts and a review flag. Exit 1 signals configuration/database/execution/shutdown failure; exit 2 signals encryption review required. The optional in-process timer remains for always-on deployments. Runtime status exposes process-local last success/failure timestamps and failure count; this is not a durable cross-process heartbeat.

**Deployment remains required:** configure an external scheduler/job runner with a suitable execution deadline, restricted secrets and credentials, bounded retry, and alerts on nonzero exits, review results and missing expected invocations. Record scheduler execution IDs, completion times and exit status in the deployment's monitoring system. Alert on retention/encryption backlog age and review queues independently of HTTP liveness. No production scheduler, alert, credential or migration was provisioned here. Scale-to-zero/serverless web traffic cannot substitute for this scheduled worker.

## Encryption key operations

The implementation validates canonical 32-byte base64 keys, selects an explicit active key, records key references on ciphertext and clears decoded key buffers at shutdown. Tests now demonstrate rotation with historical decryption, rejection when an old key is unavailable, rejection of malformed/missing keys and failure after closure. These tests do not verify a production secret manager, historical backup or restore procedure.

Production rotation procedure:

1. Provision a fresh random 256-bit key and new opaque key ID in the deployment's secret manager. Do not commit it, paste it into commands/logs, or store it in application database rows. Restrict retrieval to the required history processes.
2. Distribute a ring containing both old and new keys before switching the active key ID. Roll out consistently across writers, recovery and maintenance processes. New writes select the active ID; old ciphertext continues to use its recorded ID.
3. Verify a canary write/read with the new active key and a retained historical read using the old key, without logging values or secrets. Check failed decryptions and recovery review queues.
4. Retain old keys while any live/retained ciphertext, Undo evidence, disaster-recovery copy or restorable backup needs them. Count references by `encryption_key_reference` through an authorized administrative process and include backup-retention requirements. The existing maintenance job encrypts legacy plaintext; it does **not** automatically re-encrypt all old ciphertext during key rotation.
5. Practice a restore with historical keys before retirement. If a key is unavailable, restore the correct key from the secret manager/escrow and retry evidence/recovery; never substitute the active key, mark data absent or overwrite evidence to bypass decryption failure.
6. Retire a key only after dependency and restore checks. Enforce least privilege, audit access and protect backups/secret versions. JavaScript environment/JSON strings cannot be reliably zeroized; buffer clearing is not a guarantee that no key copy ever existed outside those buffers.

## Verification and remaining limits

- Full backend suite: **1,298 passed**, zero failures/skips.
- Combined import audit: **484 files, 1,367 relative references, 161 package references**, no unresolved imports or undeclared production dependencies. All five computed dynamic imports are test-only.
- Added regressions for external isolation/timeouts, autocommit failure, savepoint success/failure ownership, concurrent transaction use, one-shot execution without timers, joined maintenance calls, surfaced maintenance failure, pool shutdown, scheduler nonzero exit/redacted logs and key retention/unavailability.
- Changed tracked files pass whitespace checks with Windows CRLF handling; new command and disposable integration changes pass syntax checks.

The import/dependency scanner resolves the combined workspace, including modules referenced across archives. The canonical history security runtime exists at `web/security/history-security-runtime.server.js`; `web/edit-history/history-security-runtime.server.js` is its compatibility re-export.

PostgreSQL tests were attempted again but Docker's Linux engine remains unavailable. The real uninstall blocking, external-autocommit rejection, savepoint rollback, RLS and migration cases therefore remain unexecuted here. Unit tests and source inspection are not a substitute. Run the disposable schema, operation, history and export integration suites after providing Docker or local PostgreSQL. The earlier export-role integration and live Shopify deployment findings remain open.
