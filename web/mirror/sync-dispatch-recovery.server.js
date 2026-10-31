/** Fenced delivery-recovery verification and orchestration for mirror.sync_dispatches.
 * External queue inspection runs strictly outside PostgreSQL transactions;
 * verifyRecoveryDecision is a DB-only callback bound to private scoped receipts.
 */
import {randomUUID} from 'node:crypto';
import {dispatchJobId} from '../workers/sync-dispatcher.js';
import {getInstalledFilterSchemaOptions} from '../services/filter-schema.server.js';
import {CATALOG_INPUT_HASH} from './catalog-sync-steps.server.js';
import {runSyncDbTransaction} from './sync-db-transaction.server.js';
import {pgTransactionClient} from './catalog-execution.server.js';

export const DELIVERY_RECOVERY_DECISIONS = Object.freeze({
  CONSUMED: 'CONSUMED',
  STILL_ENQUEUED: 'STILL_ENQUEUED',
  RETRY_VERIFIED: 'RETRY_VERIFIED',
  UNRESOLVED: 'UNRESOLVED',
});

const DECISIONS = new Set(Object.values(DELIVERY_RECOVERY_DECISIONS));
const ACTIVE_QUEUE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
const ABSENT_QUEUE_STATES = new Set(['completed', 'failed']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const BIGINT = /^(0|[1-9][0-9]{0,18})$/;
const MAX_BIGINT = 9223372036854775807n;
const MAX_PROOFS = 256;

export class SyncDispatchRecoveryError extends Error {
  constructor(code, message, cause) {
    super(message, {cause});
    this.name = 'SyncDispatchRecoveryError';
    this.code = code;
  }
}

const fail = (code, message, cause) => {
  throw new SyncDispatchRecoveryError(code, message, cause);
};

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${label}`);
  }
  return value;
}

function own(raw, key) {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    fail('INVALID_RECOVERY_CLAIM', 'Plain recovery data required');
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    fail('INVALID_RECOVERY_CLAIM', `Missing ${key} data`);
  }
  return descriptor.value;
}

function validId(value, label = 'identity') {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('INVALID_RECOVERY_CLAIM', `Invalid ${label}`);
  }
  return value;
}

function validBigint(value, positive, label) {
  const text = typeof value === 'bigint' ? String(value) : value;
  if (
    typeof text !== 'string' ||
    !BIGINT.test(text) ||
    BigInt(text) > MAX_BIGINT ||
    (positive && BigInt(text) <= 0n)
  ) {
    fail('INVALID_RECOVERY_CLAIM', `Invalid ${label}`);
  }
  return text;
}

function captureClaim(raw) {
  const claim = {
    dispatchId: validId(own(raw, 'dispatchId'), 'dispatchId'),
    shopId: own(raw, 'shopId'),
    runId: validId(own(raw, 'runId'), 'runId'),
    generationId: validId(own(raw, 'generationId'), 'generationId'),
    deliveryKey: validId(own(raw, 'deliveryKey'), 'deliveryKey'),
    kind: own(raw, 'kind'),
    deliveryRevision: validBigint(own(raw, 'deliveryRevision'), false, 'deliveryRevision'),
    recoveryToken: validId(own(raw, 'recoveryToken'), 'recoveryToken'),
    recoveryFence: validBigint(own(raw, 'recoveryFence'), true, 'recoveryFence'),
    jobId: Object.hasOwn(raw, 'jobId') ? own(raw, 'jobId') : null,
  };
  if (typeof claim.shopId !== 'string' || claim.shopId.length > 255 || !SHOP.test(claim.shopId)) {
    fail('INVALID_RECOVERY_CLAIM', 'Invalid recovery shop');
  }
  if (!['SYNC', 'RECOVERY'].includes(claim.kind)) {
    fail('INVALID_RECOVERY_CLAIM', 'Invalid recovery kind');
  }
  if (claim.jobId !== null && typeof claim.jobId !== 'string') {
    fail('INVALID_RECOVERY_CLAIM', 'Invalid recovery jobId');
  }
  return Object.freeze(claim);
}

function buildScope({
  dispatchId,
  shopId,
  runId,
  generationId,
  deliveryKey,
  kind,
  deliveryRevision,
  recoveryToken,
  recoveryFence,
  decision,
}) {
  return JSON.stringify([
    dispatchId,
    shopId,
    runId,
    generationId,
    deliveryKey,
    kind,
    String(deliveryRevision),
    recoveryToken,
    String(recoveryFence),
    decision,
  ]);
}

function normalizeQueueObservation(raw) {
  if (typeof raw === 'string') {
    if (['ABSENT', 'ENQUEUED', 'CONSUMED', 'UNRESOLVED', 'UNKNOWN'].includes(raw)) {
      return Object.freeze({state: raw});
    }
    fail('INVALID_QUEUE_OBSERVATION', 'Unsupported queue observation state');
  }
  const state = own(raw, 'state');
  if (typeof state !== 'string' || !['ABSENT', 'ENQUEUED', 'CONSUMED', 'UNRESOLVED', 'UNKNOWN'].includes(state)) {
    fail('INVALID_QUEUE_OBSERVATION', 'Unsupported queue observation state');
  }
  return Object.freeze({state});
}

async function withDeadline(work, timeoutMs, code, message, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new SyncDispatchRecoveryError(code, message);
          onTimeout?.(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const SNAPSHOT_SQL = `SELECT d.id, d.shop_id, d.run_id, d.generation_id, d.delivery_revision,
    d.kind, d.delivery_key, d.state, d.recovery_token, d.recovery_fence, d.job_id,
    d.consumed_at, d.consumed_fence, d.consumed_lease_token,
    (d.recovery_until IS NOT NULL AND d.recovery_until > clock_timestamp()) AS recovery_live,
    (d.reserved_until IS NOT NULL AND d.reserved_until > clock_timestamp()) AS reservation_live,
    e.phase, e.fence AS execution_fence, e.delivery_revision AS execution_delivery_revision,
    e.lease_token AS execution_lease_token,
    (e.lease_token IS NOT NULL AND e.lease_until IS NOT NULL AND e.lease_until > clock_timestamp()) AS execution_lease_live,
    e.outcome_uncertain, e.review_required, e.cancel_requested, e.completed_at,
    j.cancel_requested AS job_cancel_requested, j.execution_mode, j.status AS job_status,
    (s.uninstalled_at IS NULL AND s.installation_version = j.installation_version) AS shop_active,
    (g.mirror_schema_version = $1 AND g.source_contract_version = $2 AND g.mapping_version = 'mapping_v1') AS schema_valid,
    CASE WHEN COALESCE(
      e.outcome_uncertain
      OR (e.lease_token IS NOT NULL AND (e.lease_until IS NULL OR e.lease_until <= clock_timestamp()))
      OR o.state = 'DISPATCHING'
      OR (o.id IS NOT NULL AND o.input_hash <> $3)
      OR (o.state = 'CONFIRMED' AND o.operation_id IS DISTINCT FROM r.bulk_operation_id)
      OR (r.bulk_operation_id IS NOT NULL AND (o.id IS NULL OR o.state <> 'CONFIRMED' OR o.operation_id IS DISTINCT FROM r.bulk_operation_id))
      OR (o.operation_id IS NOT NULL AND o.state NOT IN ('DISPATCHING', 'CONFIRMED'))
      OR (e.phase <> 'STARTING' AND (o.id IS NULL OR o.state <> 'CONFIRMED' OR o.operation_id IS DISTINCT FROM r.bulk_operation_id)),
      false
    ) THEN 'RECOVERY' ELSE 'SYNC' END AS current_route
  FROM mirror.sync_dispatches d
  JOIN mirror.catalog_import_executions e ON e.id = d.run_id AND e.shop_id = d.shop_id AND e.generation_id = d.generation_id
  JOIN mirror.catalog_import_jobs j ON j.id = e.id AND j.shop_id = e.shop_id AND j.generation_id = e.generation_id
  JOIN mirror.shops s ON s.id = e.shop_id
  JOIN mirror.generations g ON g.shop_id = e.shop_id AND g.id = e.generation_id
  JOIN mirror.ingestion_runs r ON r.id = j.run_id AND r.shop_id = e.shop_id AND r.generation_id = e.generation_id
    AND r.execution_id = e.id AND r.dataset = 'products'
  LEFT JOIN mirror.sync_external_operations o ON o.run_id = e.id AND o.shop_id = e.shop_id
    AND o.generation_id = e.generation_id AND o.kind = 'BULK_START'
  WHERE d.id = $4 AND d.shop_id = $5 AND d.run_id = $6 AND d.generation_id = $7`;

export function createSyncDispatchRecoveryVerifier({
  database,
  syncQueue,
  recoveryQueue,
  inspectQueue,
  verifyPersistedEvidence,
  proofTtlMs = 45000,
  queueTimeoutMs = 10000,
} = {}) {
  integer(proofTtlMs, 1000, 300000, 'proofTtlMs');
  integer(queueTimeoutMs, 100, 60000, 'queueTimeoutMs');
  if (database !== undefined && typeof database?.query !== 'function' && typeof database?.connect !== 'function') {
    throw new TypeError('PostgreSQL database driver required');
  }
  if (inspectQueue !== undefined && typeof inspectQueue !== 'function') {
    throw new TypeError('inspectQueue callback required');
  }
  if (verifyPersistedEvidence !== undefined && typeof verifyPersistedEvidence !== 'function') {
    throw new TypeError('verifyPersistedEvidence callback required');
  }
  if (syncQueue !== undefined || recoveryQueue !== undefined) {
    if (typeof syncQueue?.getJob !== 'function' || typeof recoveryQueue?.getJob !== 'function') {
      throw new TypeError('syncQueue.getJob and recoveryQueue.getJob are required');
    }
  }

  const versions = getInstalledFilterSchemaOptions();
  const parameters = [versions.mirrorSchemaVersion, versions.sourceContractVersion, CATALOG_INPUT_HASH];
  const hasDurableEvidenceStore = typeof database?.connect === 'function';
  const proofs = new Map();

  function pruneProofs(now) {
    for (const [id, entry] of proofs) {
      if (entry.until <= now) proofs.delete(id);
    }
    while (proofs.size >= MAX_PROOFS) {
      const oldest = proofs.keys().next().value;
      if (oldest === undefined) break;
      proofs.delete(oldest);
    }
  }

  async function issue(claim, decision, metadata = {}) {
    const now = Date.now();
    pruneProofs(now);
    const queueState = metadata.queueState ?? (metadata.consumed ? 'CONSUMED' : metadata.unresolved ? 'UNRESOLVED' : 'UNKNOWN');
    const expectedJobId = dispatchJobId({kind: claim.kind, deliveryKey: claim.deliveryKey});
    let evidenceId = randomUUID();

    if (hasDurableEvidenceStore) {
      const persisted = await runSyncDbTransaction({
        database,
        work: async tx => {
          const c = pgTransactionClient(tx);
          const locked = (
            await c.query(
              `SELECT id FROM mirror.sync_dispatches
               WHERE id = $1 AND shop_id = $2 AND run_id = $3 AND generation_id = $4
                 AND delivery_revision = $5 AND kind = $6 AND delivery_key = $7
                 AND state = 'RECONCILING' AND recovery_token = $8 AND recovery_fence = $9
                 AND recovery_until > clock_timestamp()
               FOR UPDATE`,
              [
                claim.dispatchId,
                claim.shopId,
                claim.runId,
                claim.generationId,
                claim.deliveryRevision,
                claim.kind,
                claim.deliveryKey,
                claim.recoveryToken,
                claim.recoveryFence,
              ],
            )
          ).rows[0];
          if (!locked) return null;

          const existing = (
            await c.query(
              `SELECT id, decision, queue_state, recovery_token, consumed_at,
                      (expires_at > clock_timestamp()) AS live
               FROM mirror.sync_dispatch_recovery_evidence
               WHERE dispatch_id = $1 AND recovery_fence = $2
               FOR UPDATE`,
              [claim.dispatchId, claim.recoveryFence],
            )
          ).rows[0];
          if (existing) {
            if (
              existing.consumed_at !== null ||
              !existing.live ||
              existing.recovery_token !== claim.recoveryToken ||
              existing.decision !== decision ||
              existing.queue_state !== queueState
            ) {
              return null;
            }
            return existing.id;
          }

          const inserted = (
            await c.query(
              `INSERT INTO mirror.sync_dispatch_recovery_evidence(
                 id, dispatch_id, shop_id, run_id, generation_id,
                 delivery_revision, kind, delivery_key, recovery_token, recovery_fence,
                 decision, queue_state, job_id, observed_at, expires_at
               )
               SELECT $1, d.id, d.shop_id, d.run_id, d.generation_id,
                      d.delivery_revision, d.kind, d.delivery_key, d.recovery_token, d.recovery_fence,
                      $3, $4, $5, clock_timestamp(),
                      LEAST(d.recovery_until, clock_timestamp() + $6::integer * interval '1 millisecond')
               FROM mirror.sync_dispatches d
               WHERE d.id = $2 AND d.state = 'RECONCILING'
                 AND d.recovery_token = $7 AND d.recovery_fence = $8
                 AND d.recovery_until > clock_timestamp()
               RETURNING id`,
              [
                evidenceId,
                claim.dispatchId,
                decision,
                queueState,
                expectedJobId,
                proofTtlMs,
                claim.recoveryToken,
                claim.recoveryFence,
              ],
            )
          ).rows[0];
          return inserted?.id ?? null;
        },
      });
      if (!persisted) {
        return Object.freeze({kind: 'STALE_RECOVERY'});
      }
      evidenceId = persisted;
    }

    proofs.set(
      evidenceId,
      Object.freeze({
        scope: buildScope({...claim, decision}),
        decision,
        queueState,
        consumed: metadata.consumed === true,
        unresolved: metadata.unresolved === true,
        until: now + proofTtlMs,
      }),
    );
    return Object.freeze({
      kind: 'VERIFIED',
      decision,
      evidenceId,
    });
  }

  async function readSnapshot(claim) {
    if (!database) return null;
    const values = [...parameters, claim.dispatchId, claim.shopId, claim.runId, claim.generationId];
    if (typeof database.query === 'function') {
      return (await database.query(SNAPSHOT_SQL, values)).rows[0] ?? null;
    }
    const client = await database.connect();
    try {
      return (await client.query(SNAPSHOT_SQL, values)).rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async function observeQueue(claim, expectedJobId, signal) {
    if (inspectQueue) {
      const raw = await withDeadline(
        () => inspectQueue({claim, jobId: expectedJobId, kind: claim.kind, signal}),
        queueTimeoutMs,
        'QUEUE_INSPECTION_TIMEOUT',
        'Queue recovery inspection timed out',
      );
      return normalizeQueueObservation(raw);
    }
    if (syncQueue && recoveryQueue) {
      const queue = claim.kind === 'RECOVERY' ? recoveryQueue : syncQueue;
      const job = await withDeadline(
        () => queue.getJob(expectedJobId),
        queueTimeoutMs,
        'QUEUE_INSPECTION_TIMEOUT',
        'Queue recovery inspection timed out',
      );
      if (!job) return Object.freeze({state: 'ABSENT'});
      const jobState = typeof job.getState === 'function'
        ? await withDeadline(
            () => job.getState(),
            queueTimeoutMs,
            'QUEUE_INSPECTION_TIMEOUT',
            'Queue job state inspection timed out',
          )
        : 'waiting';
      if (ACTIVE_QUEUE_STATES.has(jobState)) return Object.freeze({state: 'ENQUEUED'});
      if (ABSENT_QUEUE_STATES.has(jobState)) return Object.freeze({state: 'ABSENT'});
      return Object.freeze({state: 'UNKNOWN'});
    }
    return Object.freeze({state: 'UNKNOWN'});
  }

  return Object.freeze({
    async verify({claim: rawClaim, signal} = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        fail('INVALID_SIGNAL', 'AbortSignal required');
      }
      if (signal?.aborted) {
        return Object.freeze({kind: 'DEFERRED', reason: 'VERIFICATION_ABORTED'});
      }
      const claim = captureClaim(rawClaim);
      const expectedJobId = dispatchJobId({kind: claim.kind, deliveryKey: claim.deliveryKey});
      if (claim.jobId !== null && claim.jobId !== expectedJobId) {
        return issue(claim, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED, {
          unresolved: true,
          queueState: 'UNRESOLVED',
        });
      }

      const snapshot = await readSnapshot(claim);
      if (signal?.aborted) {
        return Object.freeze({kind: 'DEFERRED', reason: 'VERIFICATION_ABORTED'});
      }
      if (snapshot) {
        if (
          snapshot.state !== 'RECONCILING' ||
          snapshot.recovery_token !== claim.recoveryToken ||
          String(snapshot.recovery_fence) !== claim.recoveryFence ||
          !snapshot.recovery_live ||
          String(snapshot.delivery_revision) !== claim.deliveryRevision ||
          snapshot.kind !== claim.kind ||
          snapshot.delivery_key !== claim.deliveryKey
        ) {
          return Object.freeze({kind: 'STALE_RECOVERY'});
        }
        if (snapshot.job_id !== null && snapshot.job_id !== expectedJobId) {
          return issue(claim, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED, {
            unresolved: true,
            queueState: 'UNRESOLVED',
          });
        }
        if (
          !snapshot.shop_active ||
          !snapshot.schema_valid ||
          snapshot.cancel_requested ||
          snapshot.job_cancel_requested ||
          snapshot.review_required ||
          snapshot.execution_mode !== 'PHASE'
        ) {
          return issue(claim, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED, {
            unresolved: true,
          });
        }
        if (
          snapshot.completed_at !== null ||
          BigInt(snapshot.execution_delivery_revision) > BigInt(claim.deliveryRevision)
        ) {
          return issue(claim, DELIVERY_RECOVERY_DECISIONS.CONSUMED, {
            consumed: true,
          });
        }
        if (
          snapshot.consumed_fence !== null &&
          (BigInt(snapshot.execution_fence) > BigInt(snapshot.consumed_fence) ||
            (BigInt(snapshot.execution_fence) === BigInt(snapshot.consumed_fence) &&
              snapshot.execution_lease_live) ||
            snapshot.current_route !== claim.kind)
        ) {
          return issue(claim, DELIVERY_RECOVERY_DECISIONS.CONSUMED, {
            consumed: true,
          });
        }
      }

      let observation;
      try {
        observation = await observeQueue(claim, expectedJobId, signal);
      } catch {
        return Object.freeze({kind: 'DEFERRED', reason: 'QUEUE_INSPECTION_FAILED'});
      }
      if (signal?.aborted) {
        return Object.freeze({kind: 'DEFERRED', reason: 'VERIFICATION_ABORTED'});
      }

      if (observation.state === 'ENQUEUED') {
        return issue(claim, DELIVERY_RECOVERY_DECISIONS.STILL_ENQUEUED, {
          queueState: 'ENQUEUED',
        });
      }
      if (observation.state === 'CONSUMED') {
        return issue(claim, DELIVERY_RECOVERY_DECISIONS.CONSUMED, {
          consumed: true,
          queueState: 'CONSUMED',
        });
      }
      if (observation.state === 'UNRESOLVED') {
        return issue(claim, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED, {
          unresolved: true,
          queueState: 'UNRESOLVED',
        });
      }
      if (observation.state === 'ABSENT') {
        if (snapshot?.reservation_live) {
          return Object.freeze({kind: 'DEFERRED', reason: 'RESERVATION_ACTIVE'});
        }
        if (snapshot?.execution_lease_live) {
          return Object.freeze({kind: 'DEFERRED', reason: 'EXECUTION_LEASE_ACTIVE'});
        }
        if (snapshot && snapshot.current_route !== claim.kind) {
          if (snapshot.consumed_fence !== null || snapshot.consumed_at !== null) {
            return issue(claim, DELIVERY_RECOVERY_DECISIONS.CONSUMED, {
              consumed: true,
              queueState: 'ABSENT',
            });
          }
          return issue(claim, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED, {
            unresolved: true,
            queueState: 'ABSENT',
          });
        }
        return issue(claim, DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED, {
          queueState: 'ABSENT',
        });
      }

      return Object.freeze({kind: 'DEFERRED', reason: 'QUEUE_OUTCOME_UNKNOWN'});
    },

    async verifyRecoveryDecision({tx, delivery, run, decision, evidenceId} = {}) {
      if (!tx || (typeof tx.$queryRawUnsafe !== 'function' && typeof tx.query !== 'function')) {
        return false;
      }
      if (!delivery || !run || !DECISIONS.has(decision) || typeof evidenceId !== 'string' || !ID.test(evidenceId)) {
        return false;
      }
      const expectedJobId = dispatchJobId({kind: delivery.kind, deliveryKey: delivery.delivery_key});
      if (delivery.job_id !== null && delivery.job_id !== expectedJobId && decision !== DELIVERY_RECOVERY_DECISIONS.UNRESOLVED) {
        return false;
      }

      if (hasDurableEvidenceStore) {
        const c = pgTransactionClient(tx);
        const rows = (
          await c.query(
            `UPDATE mirror.sync_dispatch_recovery_evidence
             SET consumed_at = clock_timestamp()
             WHERE id = $1
               AND dispatch_id = $2
               AND shop_id = $3
               AND run_id = $4
               AND generation_id = $5
               AND delivery_revision = $6
               AND kind = $7
               AND delivery_key = $8
               AND recovery_token = $9
               AND recovery_fence = $10
               AND decision = $11
               AND consumed_at IS NULL
               AND expires_at > clock_timestamp()
             RETURNING queue_state, job_id`,
            [
              evidenceId,
              delivery.id,
              delivery.shop_id,
              delivery.run_id,
              delivery.generation_id,
              String(delivery.delivery_revision),
              delivery.kind,
              delivery.delivery_key,
              delivery.recovery_token,
              String(delivery.recovery_fence),
              decision,
            ],
          )
        ).rows;
        if (rows.length !== 1) {
          return false;
        }
        const persisted = rows[0];
        if (persisted.job_id !== expectedJobId && decision !== DELIVERY_RECOVERY_DECISIONS.UNRESOLVED) {
          return false;
        }
        if (decision === DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED) {
          if (
            persisted.queue_state !== 'ABSENT' ||
            String(run.delivery_revision) !== String(delivery.delivery_revision) ||
            run.kind !== delivery.kind ||
            run.cancel_requested ||
            run.review_required ||
            run.completed_at !== null
          ) {
            return false;
          }
        } else if (decision === DELIVERY_RECOVERY_DECISIONS.STILL_ENQUEUED) {
          if (
            persisted.queue_state !== 'ENQUEUED' ||
            String(run.delivery_revision) !== String(delivery.delivery_revision) ||
            run.cancel_requested ||
            run.review_required ||
            run.completed_at !== null
          ) {
            return false;
          }
        } else if (decision === DELIVERY_RECOVERY_DECISIONS.CONSUMED) {
          const executionConsumed =
            run.completed_at !== null ||
            BigInt(run.delivery_revision) > BigInt(delivery.delivery_revision) ||
            delivery.consumed_fence !== null ||
            delivery.consumed_at !== null;
          if (persisted.queue_state !== 'CONSUMED' && !executionConsumed) {
            return false;
          }
        } else if (decision === DELIVERY_RECOVERY_DECISIONS.UNRESOLVED) {
          if (!['UNRESOLVED', 'ABSENT', 'UNKNOWN'].includes(persisted.queue_state)) {
            return false;
          }
        }
        if (verifyPersistedEvidence && (await verifyPersistedEvidence({tx, delivery, run, decision, evidenceId})) !== true) {
          return false;
        }
        return true;
      }

      const now = Date.now();
      pruneProofs(now);
      const proof = proofs.get(evidenceId);
      if (!proof) {
        if (verifyPersistedEvidence) {
          return (await verifyPersistedEvidence({tx, delivery, run, decision, evidenceId})) === true;
        }
        return false;
      }
      if (proof.until <= now || proof.decision !== decision) {
        return false;
      }
      const expectedScope = buildScope({
        dispatchId: delivery.id,
        shopId: delivery.shop_id,
        runId: delivery.run_id,
        generationId: delivery.generation_id,
        deliveryKey: delivery.delivery_key,
        kind: delivery.kind,
        deliveryRevision: delivery.delivery_revision,
        recoveryToken: delivery.recovery_token,
        recoveryFence: delivery.recovery_fence,
        decision,
      });
      if (proof.scope !== expectedScope) {
        return false;
      }
      if (decision === DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED) {
        if (
          proof.queueState !== 'ABSENT' ||
          String(run.delivery_revision) !== String(delivery.delivery_revision) ||
          run.kind !== delivery.kind ||
          run.cancel_requested ||
          run.review_required ||
          run.completed_at !== null
        ) {
          return false;
        }
      } else if (decision === DELIVERY_RECOVERY_DECISIONS.STILL_ENQUEUED) {
        if (
          proof.queueState !== 'ENQUEUED' ||
          String(run.delivery_revision) !== String(delivery.delivery_revision) ||
          run.cancel_requested ||
          run.review_required ||
          run.completed_at !== null
        ) {
          return false;
        }
      } else if (decision === DELIVERY_RECOVERY_DECISIONS.CONSUMED) {
        if (proof.consumed !== true) {
          return false;
        }
      } else if (decision === DELIVERY_RECOVERY_DECISIONS.UNRESOLVED) {
        if (proof.unresolved !== true) {
          return false;
        }
      }
      if (verifyPersistedEvidence && (await verifyPersistedEvidence({tx, delivery, run, decision, evidenceId})) !== true) {
        return false;
      }
      return true;
    },

    releaseEvidence(evidenceId) {
      if (typeof evidenceId === 'string') {
        proofs.delete(evidenceId);
      }
    },
  });
}

export function createSyncDispatchRecovery({
  repository,
  verifier,
  recoverySeconds = 120,
  verificationTimeoutMs = 15000,
  repositoryTimeoutMs = 15000,
  logger = console,
} = {}) {
  for (const method of ['listRecoveryCandidates', 'claimDeliveryRecovery', 'finishDeliveryRecovery']) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`repository.${method} is required`);
    }
  }
  if (typeof verifier?.verify !== 'function') {
    throw new TypeError('verifier.verify is required');
  }
  integer(recoverySeconds, 10, 3600, 'recoverySeconds');
  integer(verificationTimeoutMs, 100, 60000, 'verificationTimeoutMs');
  integer(repositoryTimeoutMs, 100, 30000, 'repositoryTimeoutMs');

  let running = null;
  const safeLog = (level, payload) => {
    try {
      Promise.resolve(logger?.[level]?.(payload)).catch(() => {});
    } catch {}
  };

  async function recoverDelivery(dispatchId, {signal} = {}) {
    validId(dispatchId, 'dispatchId');
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      fail('INVALID_SIGNAL', 'AbortSignal required');
    }
    if (signal?.aborted) {
      return Object.freeze({kind: 'RECOVERY_ABORTED', dispatchId});
    }

    const rawClaim = await withDeadline(
      () => repository.claimDeliveryRecovery({dispatchId, recoverySeconds}),
      repositoryTimeoutMs,
      'RECOVERY_CLAIM_TIMEOUT',
      'claimDeliveryRecovery deadline exceeded',
    );
    if (rawClaim === null) {
      return Object.freeze({kind: 'NOT_CLAIMED', dispatchId});
    }
    const claim = captureClaim(rawClaim);
    if (claim.dispatchId !== dispatchId) {
      fail('INVALID_RECOVERY_CLAIM', 'Claimed dispatchId mismatch');
    }
    if (signal?.aborted) {
      return Object.freeze({kind: 'RECOVERY_DEFERRED', dispatchId, reason: 'VERIFICATION_ABORTED'});
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, {once: true});
    let verification;
    try {
      verification = await withDeadline(
        () => verifier.verify({claim, signal: controller.signal}),
        verificationTimeoutMs,
        'RECOVERY_VERIFY_TIMEOUT',
        'Delivery recovery verification deadline exceeded',
        error => controller.abort(error),
      );
    } catch (error) {
      safeLog('error', {
        event: 'sync_dispatch_recovery_verify_failed',
        dispatchId,
        code: error?.code || 'VERIFY_FAILED',
      });
      return Object.freeze({
        kind: 'RECOVERY_DEFERRED',
        dispatchId,
        reason: error?.code === 'RECOVERY_VERIFY_TIMEOUT' ? 'VERIFICATION_TIMEOUT' : 'VERIFICATION_FAILED',
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }

    if (!verification || typeof verification !== 'object') {
      fail('INVALID_VERIFICATION', 'Invalid delivery verification outcome');
    }
    if (verification.kind === 'STALE_RECOVERY') {
      return Object.freeze({kind: 'STALE_RECOVERY', dispatchId});
    }
    if (verification.kind !== 'VERIFIED') {
      return Object.freeze({
        kind: 'RECOVERY_DEFERRED',
        dispatchId,
        reason: typeof verification.reason === 'string' ? verification.reason : 'VERIFICATION_DEFERRED',
      });
    }
    if (signal?.aborted) {
      verifier.releaseEvidence?.(verification.evidenceId);
      return Object.freeze({kind: 'RECOVERY_DEFERRED', dispatchId, reason: 'VERIFICATION_ABORTED'});
    }

    try {
      const outcome = await withDeadline(
        () =>
          repository.finishDeliveryRecovery({
            claim,
            decision: verification.decision,
            evidenceId: verification.evidenceId,
          }),
        repositoryTimeoutMs,
        'RECOVERY_FINISH_TIMEOUT',
        'finishDeliveryRecovery deadline exceeded',
      );
      if (outcome?.kind !== 'RECORDED' && outcome?.kind !== 'STALE_RECOVERY') {
        fail('RECOVERY_OUTCOME_UNKNOWN', 'Unverified finishDeliveryRecovery outcome');
      }
      return Object.freeze({
        kind: outcome.kind,
        dispatchId,
        decision: verification.decision,
      });
    } finally {
      verifier.releaseEvidence?.(verification.evidenceId);
    }
  }

  async function recoverDueDeliveries({limit = 20, signal} = {}) {
    integer(limit, 1, 100, 'recovery limit');
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      fail('INVALID_SIGNAL', 'AbortSignal required');
    }
    if (running) {
      return Object.freeze({kind: 'ALREADY_RUNNING'});
    }
    running = (async () => {
      const candidates = await withDeadline(
        () => repository.listRecoveryCandidates({limit}),
        repositoryTimeoutMs,
        'RECOVERY_LIST_TIMEOUT',
        'listRecoveryCandidates deadline exceeded',
      );
      if (!Array.isArray(candidates)) {
        fail('INVALID_CANDIDATES', 'Recovery candidate array required');
      }
      const counts = {
        scanned: 0,
        recorded: 0,
        stale: 0,
        deferred: 0,
        notClaimed: 0,
        errors: 0,
        consumed: 0,
        stillEnqueued: 0,
        retryVerified: 0,
        unresolved: 0,
      };
      for (const candidate of candidates) {
        if (signal?.aborted) break;
        const dispatchId = validId(own(candidate, 'dispatchId'), 'dispatchId');
        counts.scanned++;
        try {
          const result = await recoverDelivery(dispatchId, {signal});
          if (result.kind === 'RECORDED') {
            counts.recorded++;
            if (result.decision === 'CONSUMED') counts.consumed++;
            else if (result.decision === 'STILL_ENQUEUED') counts.stillEnqueued++;
            else if (result.decision === 'RETRY_VERIFIED') counts.retryVerified++;
            else if (result.decision === 'UNRESOLVED') counts.unresolved++;
          } else if (result.kind === 'STALE_RECOVERY') {
            counts.stale++;
          } else if (result.kind === 'NOT_CLAIMED') {
            counts.notClaimed++;
          } else {
            counts.deferred++;
          }
        } catch (error) {
          counts.errors++;
          safeLog('error', {
            event: 'sync_dispatch_recovery_failed',
            dispatchId,
            code: error?.code || 'RECOVERY_FAILED',
          });
        }
      }
      const summary = Object.freeze({
        kind: counts.errors || counts.deferred ? 'PARTIAL' : 'COMPLETED',
        ...counts,
      });
      safeLog('info', {event: 'sync_dispatch_recovery_cycle', ...summary});
      return summary;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  return Object.freeze({
    recoverDelivery,
    recoverDueDeliveries,
  });
}

