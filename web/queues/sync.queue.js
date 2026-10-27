import { Queue } from "bullmq";
import { producerRedis } from "../integrations/redis/connection.js";

export const SYNC_QUEUE = "catalog-sync";
export const SYNC_JOB = "sync-run";
export const SYNC_PREFIX = process.env.QUEUE_PREFIX || "newmeta";

/**
 * BullMQ provides scheduling and execution, not durable state.
 * Neon owns the authoritative sync run status, leases, and retry eligibility.
 *
 * Terminal jobs must be removed after completion (removeOnComplete: true,
 * removeOnFail: true) so a completed continuation job can be scheduled again
 * using deterministic job IDs (e.g. `sync-${runId}`) when Neon says the run is due.
 */
export const syncQueue = new Queue(SYNC_QUEUE, {
  prefix: SYNC_PREFIX,
  connection: producerRedis,

  defaultJobOptions: {
    // Durable retries and continuation are controlled by Neon.
    attempts: 1,

    // Do not retain terminal jobs that could block scheduling
    // a continuation or recovery job with the same deterministic ID.
    removeOnComplete: true,
    removeOnFail: true,
  },
});

syncQueue.on("error", (error) => {
  console.error("[catalog-sync] Queue error:", error);
});

/**
 * Enqueue a sync run for processing.
 *
 * Multiple calls for the same runId deduplicate while the job remains active in Redis.
 * Because removeOnComplete: true and removeOnFail: true are set, once a job completes,
 * subsequent continuation iterations can be scheduled with the same deterministic ID.
 */
export async function enqueueSyncRun(shop, runId, status) {
  if (typeof runId !== "string" || !runId.trim()) {
    throw new TypeError("runId must be a non-empty string");
  }

  const normalizedRunId = runId.trim();
  const jobId = `sync-${normalizedRunId}`;

  return syncQueue.add(
    SYNC_JOB,
    {
      shop,
      runId: normalizedRunId,
      status,
    },
    {
      jobId,
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}
