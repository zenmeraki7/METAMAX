import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncDispatchRecoveryVerifier,
  createSyncDispatchRecovery,
  DELIVERY_RECOVERY_DECISIONS,
} from './sync-dispatch-recovery.server.js';
import {dispatchJobId} from '../workers/sync-dispatcher.js';

const baseClaim = Object.freeze({
  dispatchId: 'dispatch-1',
  shopId: 'store.myshopify.com',
  runId: 'run-1',
  generationId: 'gen-1',
  deliveryKey: 'a'.repeat(64),
  kind: 'SYNC',
  deliveryRevision: '0',
  recoveryToken: 'token-1',
  recoveryFence: '1',
  jobId: dispatchJobId({kind: 'SYNC', deliveryKey: 'a'.repeat(64)}),
});

const matchingDelivery = Object.freeze({
  id: baseClaim.dispatchId,
  shop_id: baseClaim.shopId,
  run_id: baseClaim.runId,
  generation_id: baseClaim.generationId,
  delivery_key: baseClaim.deliveryKey,
  kind: baseClaim.kind,
  delivery_revision: 0n,
  recovery_token: baseClaim.recoveryToken,
  recovery_fence: 1n,
  job_id: baseClaim.jobId,
  consumed_at: null,
  consumed_fence: null,
});

const matchingRun = Object.freeze({
  id: baseClaim.runId,
  shop_id: baseClaim.shopId,
  generation_id: baseClaim.generationId,
  delivery_revision: 0n,
  kind: 'SYNC',
  phase: 'STARTING',
  cancel_requested: false,
  review_required: false,
  completed_at: null,
});

const txStub = Object.freeze({
  async $queryRawUnsafe() {
    return [];
  },
});

test('verifier validates configuration and rejects forged or unissued receipts', async () => {
  assert.throws(() => createSyncDispatchRecoveryVerifier({proofTtlMs: 999}), RangeError);
  assert.throws(() => createSyncDispatchRecoveryVerifier({queueTimeoutMs: 50}), RangeError);
  assert.throws(() => createSyncDispatchRecoveryVerifier({inspectQueue: 'invalid'}), TypeError);
  assert.throws(() => createSyncDispatchRecoveryVerifier({syncQueue: {}}), TypeError);

  const verifier = createSyncDispatchRecoveryVerifier({
    inspectQueue: async () => 'ABSENT',
  });
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED,
      evidenceId: 'unissued-receipt',
    }),
    false,
  );
});

test('verifier issues private scoped receipts from queue observations and enforces exact scope', async () => {
  const verifier = createSyncDispatchRecoveryVerifier({
    inspectQueue: async () => ({state: 'ABSENT'}),
  });
  const verified = await verifier.verify({claim: baseClaim});
  assert.equal(verified.kind, 'VERIFIED');
  assert.equal(verified.decision, DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED);

  // Scope mismatches or decision mismatches are rejected.
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: DELIVERY_RECOVERY_DECISIONS.CONSUMED,
      evidenceId: verified.evidenceId,
    }),
    false,
  );
  for (const patch of [
    {id: 'other-dispatch'},
    {shop_id: 'other.myshopify.com'},
    {run_id: 'other-run'},
    {generation_id: 'other-gen'},
    {delivery_key: 'b'.repeat(64)},
    {recovery_token: 'other-token'},
    {recovery_fence: 2n},
    {delivery_revision: 1n},
  ]) {
    assert.equal(
      await verifier.verifyRecoveryDecision({
        tx: txStub,
        delivery: {...matchingDelivery, ...patch},
        run: matchingRun,
        decision: DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED,
        evidenceId: verified.evidenceId,
      }),
      false,
    );
  }

  // Exact matching scope succeeds.
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED,
      evidenceId: verified.evidenceId,
    }),
    true,
  );

  // Released evidence cannot be reused.
  verifier.releaseEvidence(verified.evidenceId);
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED,
      evidenceId: verified.evidenceId,
    }),
    false,
  );
});

test('verifier maps BullMQ job states without treating queue errors as absence proof', async () => {
  let state = 'waiting';
  let failQueue = false;
  const queue = {
    async getJob(jobId) {
      assert.equal(jobId, baseClaim.jobId);
      if (failQueue) throw new Error('Redis unavailable');
      if (state === null) return null;
      return {
        async getState() {
          return state;
        },
      };
    },
  };
  const verifier = createSyncDispatchRecoveryVerifier({
    syncQueue: queue,
    recoveryQueue: queue,
  });

  const enqueued = await verifier.verify({claim: baseClaim});
  assert.equal(enqueued.decision, DELIVERY_RECOVERY_DECISIONS.STILL_ENQUEUED);
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: DELIVERY_RECOVERY_DECISIONS.STILL_ENQUEUED,
      evidenceId: enqueued.evidenceId,
    }),
    true,
  );

  state = 'completed';
  const absent = await verifier.verify({claim: baseClaim});
  assert.equal(absent.decision, DELIVERY_RECOVERY_DECISIONS.RETRY_VERIFIED);

  failQueue = true;
  const deferred = await verifier.verify({claim: baseClaim});
  assert.equal(deferred.kind, 'DEFERRED');
  assert.equal(deferred.reason, 'QUEUE_INSPECTION_FAILED');

  const mismatchedJob = await verifier.verify({
    claim: {...baseClaim, jobId: 'forged-job-id'},
  });
  assert.equal(mismatchedJob.decision, DELIVERY_RECOVERY_DECISIONS.UNRESOLVED);
});

test('orchestrator claims, verifies, finishes and releases evidence with bounded concurrency', async () => {
  const verifier = createSyncDispatchRecoveryVerifier({
    inspectQueue: async () => 'ABSENT',
  });
  const finished = [];
  const repository = {
    async listRecoveryCandidates() {
      return [{dispatchId: baseClaim.dispatchId}];
    },
    async claimDeliveryRecovery({dispatchId}) {
      assert.equal(dispatchId, baseClaim.dispatchId);
      return baseClaim;
    },
    async finishDeliveryRecovery({claim, decision, evidenceId}) {
      assert.equal(
        await verifier.verifyRecoveryDecision({
          tx: txStub,
          delivery: matchingDelivery,
          run: matchingRun,
          decision,
          evidenceId,
        }),
        true,
      );
      finished.push({claim, decision, evidenceId});
      return {kind: 'RECORDED'};
    },
  };

  const recovery = createSyncDispatchRecovery({
    repository,
    verifier,
    logger: {info() {}, error() {}},
  });
  const summary = await recovery.recoverDueDeliveries();
  assert.equal(summary.kind, 'COMPLETED');
  assert.equal(summary.scanned, 1);
  assert.equal(summary.recorded, 1);
  assert.equal(summary.retryVerified, 1);
  assert.equal(finished.length, 1);

  // Receipt was released in finally after finishDeliveryRecovery settled.
  assert.equal(
    await verifier.verifyRecoveryDecision({
      tx: txStub,
      delivery: matchingDelivery,
      run: matchingRun,
      decision: finished[0].decision,
      evidenceId: finished[0].evidenceId,
    }),
    false,
  );
});

