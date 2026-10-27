import "../env.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import { prisma } from "../db/client.js";
import { consumerRedis } from "../integrations/redis/connection.js";
import {
  SYNC_QUEUE,
  SYNC_PREFIX,
} from "../queues/sync.queue.js";
import {
  claimSnapshotLease,
  releaseSnapshotLease,
} from "../domains/sync/sync.lease.js";
import { processCatalogImport, recordSyncFailure } from "../domains/sync/sync.import.js";
import { processSync } from "../domains/sync/sync.worker.js";
import { ACTIVE } from "../domains/sync/sync.repository.js";

/**
 * Process a single sync run job.
 * Claims Neon lease and dispatches to processSync.
 */
export async function processSyncJob(jobData, options = {}) {
  const { runId, shop } = jobData || {};
  if (!runId || typeof runId !== "string") {
    throw new TypeError("Job missing required runId");
  }

  const syncRun = prisma.syncRun || prisma.snapshotRun;
  let run = await syncRun.findUnique({
    where: { id: runId },
  });

  if (!run) {
    return { status: "not_found", runId };
  }

  if (shop && run.shop !== shop) {
    throw new Error("Job shop domain does not match database record");
  }

  if (!ACTIVE.includes(run.status)) {
    return { status: "not_active", runId, currentStatus: run.status };
  }

  let token;
  try {
    const claim = await claimSnapshotLease(run, { includeIngestion: true });
    token = claim.token;
  } catch (err) {
    if (err?.code === "SYNC_LEASE_UNAVAILABLE" || err?.code === "SYNC_RUN_NOT_ACTIVE") {
      return { status: "lease_unavailable", reason: err.code };
    }
    throw err;
  }

  try {
    // A previous worker may have advanced the phase between our initial read
    // and this claim. Dispatch from the owned durable state, never the job's
    // scheduling token or a pre-claim phase/export name.
    const current = await syncRun.findUnique({ where: { id: runId } });
    if (!current || current.leaseToken !== token)
      return { status: "lease_unavailable", reason: "SYNC_LEASE_LOST" };
    run = current;
    if (run.status !== "RECONCILING")
      return await processCatalogImport(run, token, options);
    return await processSync(run, token, { ...options, releaseLeaseOnFinish: false });
  } catch (error) {
    // A lost lease/changed installation must never be acknowledged as our failure.
    if (!["SYNC_LEASE_LOST", "SYNC_RUN_NOT_ACTIVE", "INSTALLATION_CHANGED"].includes(error.code)) {
      try { await recordSyncFailure(run, token, error); }
      catch (persistenceError) {
        if (!["SYNC_LEASE_LOST", "SYNC_RUN_NOT_ACTIVE"].includes(persistenceError.code))
          throw new AggregateError([error, persistenceError], "Sync failed and retry persistence failed");
      }
    }
    throw error;
  } finally {
    await releaseSnapshotLease(run, token);
  }
}

/**
 * Create BullMQ Worker for the full catalog sync queue.
 */
export function createSyncWorker(options = {}) {
  const worker = new Worker(
    SYNC_QUEUE,
    (job) => processSyncJob(job.data, options),
    {
      prefix: SYNC_PREFIX,
      connection: consumerRedis,
      concurrency: options.concurrency ?? 2,
    }
  );

  worker.on("error", (error) => {
    console.error("[catalog-sync] Worker error:", error);
  });

  worker.on("failed", (job, error) => {
    console.error("[catalog-sync] Job failed:", job?.id, error.message);
  });

  return worker;
}

// Imports expose processor for tests; direct execution starts the worker process.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prisma.$connect();
  const worker = createSyncWorker();
  console.log("Full catalog sync worker started.");

  async function shutdown() {
    console.log("Shutting down full catalog sync worker...");
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
