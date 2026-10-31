import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";
import {
  createSyncRedisQueue,
  createSyncRedisWorkerClass,
  createSyncRedisTransport,
} from "./sync-redis-transport.server.js";
import {
  createBullMQSyncWorker,
  createBullMQRecoveryWorker,
  SYNC_QUEUE_NAME,
  RECOVERY_QUEUE_NAME,
} from "./sync.worker.js";

const quiet = { info() {}, warn() {}, error() {} };

async function connectOptionalRedis() {
  const client = createClient({
    url: process.env.REDIS_URL || "redis://127.0.0.1:6380",
    disableOfflineQueue: true,
    socket: { connectTimeout: 1000, reconnectStrategy: false },
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

test("sync Redis transport validates inputs and rejects untrusted job payloads", async () => {
  assert.throws(() => createSyncRedisTransport(), /Redis client/);
  assert.throws(() => createSyncRedisQueue({ redis: null, queueName: SYNC_QUEUE_NAME }), /Redis client/);
  const fakeRedis = { isOpen: true, async eval() { return ["ENQUEUED", "waiting"]; } };
  assert.throws(() => createSyncRedisQueue({ redis: fakeRedis, queueName: "bad queue!" }), /Invalid queueName/);
  const queue = createSyncRedisQueue({ redis: fakeRedis, queueName: SYNC_QUEUE_NAME });
  await assert.rejects(
    () => queue.add(SYNC_QUEUE_NAME, { runId: "run-1", shopId: "evil.myshopify.com" }, { jobId: "job-1" }),
    /only \{ runId \}/,
  );
  await assert.rejects(
    () => queue.add(SYNC_QUEUE_NAME, { runId: "run-1" }, { jobId: "bad job id" }),
    /Invalid jobId/,
  );
  assert.throws(() => createSyncRedisWorkerClass({ prefix: "bad prefix!" }), /Invalid prefix/);
});

test("Redis transport deduplicates deterministic jobIds, inspects states, and drives BullMQ sync & recovery workers", async (t) => {
  const client = await connectOptionalRedis();
  if (!client) {
    t.skip("Local Redis is not reachable");
    return;
  }
  t.after(async () => {
    if (client.isOpen) await client.close();
  });

  const prefix = `metamax:test:${randomUUID().slice(0, 8)}`;
  const transport = createSyncRedisTransport({
    redis: client,
    prefix,
    activeLeaseMs: 2_000,
    pollIntervalMs: 30,
  });

  const added1 = await transport.syncQueue.add(
    SYNC_QUEUE_NAME,
    { runId: "run-alpha" },
    { jobId: "metamax-sync-alpha", removeOnComplete: true, removeOnFail: true },
  );
  const added2 = await transport.syncQueue.add(
    SYNC_QUEUE_NAME,
    { runId: "run-alpha" },
    { jobId: "metamax-sync-alpha", removeOnComplete: true, removeOnFail: true },
  );
  assert.equal(added1.id, "metamax-sync-alpha");
  assert.equal(added2.id, "metamax-sync-alpha");

  await assert.rejects(
    () =>
      transport.syncQueue.add(
        SYNC_QUEUE_NAME,
        { runId: "run-other" },
        { jobId: "metamax-sync-alpha" },
      ),
    { code: "JOB_ID_CONFLICT" },
  );

  const waitingJob = await transport.syncQueue.getJob("metamax-sync-alpha");
  assert.ok(waitingJob);
  assert.equal(await waitingJob.getState(), "waiting");

  const processedSync = [];
  const syncWorker = createBullMQSyncWorker({
    Worker: transport.Worker,
    connection: transport.connection,
    processor: {
      async processRun(runId) {
        const activeJob = await transport.syncQueue.getJob("metamax-sync-alpha");
        assert.equal(await activeJob?.getState(), "active");
        processedSync.push(runId);
        return { kind: "ADVANCE", runId };
      },
    },
    logger: quiet,
  });

  const firstOutcome = await syncWorker.processNext();
  assert.equal(firstOutcome?.result?.kind, "ADVANCE");
  assert.deepEqual(processedSync, ["run-alpha"]);
  assert.equal(await transport.syncQueue.getJob("metamax-sync-alpha"), null);
  assert.equal(await syncWorker.processNext(), null);

  await transport.recoveryQueue.add(
    RECOVERY_QUEUE_NAME,
    { runId: "run-recover-1" },
    { jobId: "metamax-recovery-1", removeOnComplete: true, removeOnFail: true },
  );
  const processedRecovery = [];
  const recoveryWorker = createBullMQRecoveryWorker({
    Worker: transport.Worker,
    connection: transport.connection,
    recovery: {
      async recoverRun(runId) {
        processedRecovery.push(runId);
        return { kind: "RESUMED", runId };
      },
    },
    logger: quiet,
  });
  recoveryWorker.run();
  for (let i = 0; i < 20 && processedRecovery.length === 0; i++) {
    await delay(25);
  }
  await recoveryWorker.close();
  assert.deepEqual(processedRecovery, ["run-recover-1"]);
  assert.equal(await transport.recoveryQueue.getJob("metamax-recovery-1"), null);
});

test("Redis worker recovers expired active leases up to maxStalledCount and then removes exhausted jobs", async (t) => {
  const client = await connectOptionalRedis();
  if (!client) {
    t.skip("Local Redis is not reachable");
    return;
  }
  t.after(async () => {
    if (client.isOpen) await client.close();
  });

  const prefix = `metamax:stalled:${randomUUID().slice(0, 8)}`;
  const queue = createSyncRedisQueue({
    redis: client,
    queueName: SYNC_QUEUE_NAME,
    prefix,
    maxStalledCount: 1,
  });
  const jobId = "metamax-sync-stalled";
  await queue.add(SYNC_QUEUE_NAME, { runId: "run-stalled" }, { jobId });

  const jobKey = `${prefix}:${SYNC_QUEUE_NAME}:job:${jobId}`;
  const waitKey = `${prefix}:${SYNC_QUEUE_NAME}:wait`;
  const activeKey = `${prefix}:${SYNC_QUEUE_NAME}:active`;
  await client.lPop(waitKey);
  await client.sAdd(activeKey, jobId);
  await client.hSet(jobKey, {
    state: "active",
    leaseToken: "crashed-worker",
    leaseUntilMs: String(Date.now() - 1_000),
    stalledCount: "0",
  });

  const Worker = createSyncRedisWorkerClass({
    redis: client,
    prefix,
    activeLeaseMs: 2_000,
    pollIntervalMs: 50,
  });
  const stalledEvents = [];
  const runs = [];
  const worker = new Worker(
    SYNC_QUEUE_NAME,
    async (job) => {
      runs.push(job.data.runId);
      return { kind: "ADVANCE" };
    },
    { connection: client, autorun: false, maxStalledCount: 1 },
  );
  worker.on("stalled", (id) => stalledEvents.push(id));

  const recovered = await worker.processNext();
  assert.equal(recovered?.job?.id, jobId);
  assert.deepEqual(stalledEvents, [jobId]);
  assert.deepEqual(runs, ["run-stalled"]);
  assert.equal(await queue.getJob(jobId), null);
});

