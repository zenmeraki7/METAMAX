import { prisma } from "../../db/client.js";
import { ACTIVE } from "./sync.repository.js";
import { enqueueSyncRun, syncQueue } from "./sync.queue.js";

export { ACTIVE };

/**
 * Sync recovery scanner eligibility query.
 * Supports released or expired leases and due nextCheckAt across all ACTIVE run states.
 */
export async function findDueSyncRuns(options = {}) {
  const { db = prisma, limit = 100 } = options;
  const now = new Date();
  const syncRun = db.syncRun || db.snapshotRun;
  const syncRunFields = syncRun?.fields;
  const hasNextCheckAt = syncRunFields ? "nextCheckAt" in syncRunFields : true;

  return syncRun.findMany({
    where: {
      status: {
        in: ACTIVE,
      },

      AND: [
        ...(hasNextCheckAt
          ? [
              {
                nextCheckAt: { lte: now },
              },
            ]
          : []),

        {
          OR: [
            { leasedUntil: null },
            { leasedUntil: { lte: now } },
          ],
        },
      ],
    },

    orderBy: [
      ...(hasNextCheckAt ? [{ nextCheckAt: "asc" }] : []),
      { id: "asc" },
    ],

    take: limit,

    select: {
      id: true,
      shop: true,
      status: true,
    },
  });
}

/**
 * Create a recovery scanner for active sync runs.
 *
 * Merges the eligibility query into queue capacity checks, cursor pagination,
 * and deterministic job dispatch.
 */
export function createSyncScanner(defaults = {}) {
  let afterId = "";

  return async function scan(options = {}) {
    const {
      db = prisma,
      enqueue = enqueueSyncRun,
      queue = syncQueue,
      limit = 100,
      maxQueuedJobs = 1000,
    } = { ...defaults, ...options };

    let capacity = limit;
    if (queue && typeof queue.getJobCounts === "function") {
      try {
        const counts = await queue.getJobCounts(
          "wait",
          "active",
          "delayed",
          "prioritized",
          "waiting-children",
          "paused"
        );
        const depth = Object.values(counts).reduce((sum, count) => sum + count, 0);
        capacity = Math.min(limit, Math.max(0, maxQueuedJobs - depth));
        if (!capacity) return 0;
      } catch (err) {
        // Fall back to limit if queue depth check fails
      }
    }

    const now = new Date();
    const syncRun = db.syncRun || db.snapshotRun;
    const syncRunFields = syncRun?.fields;
    const hasNextCheckAt = syncRunFields ? "nextCheckAt" in syncRunFields : true;

    const baseWhere = {
      status: {
        in: ACTIVE,
      },

      AND: [
        ...(hasNextCheckAt
          ? [
              {
                nextCheckAt: { lte: now },
              },
            ]
          : []),

        {
          OR: [
            { leasedUntil: null },
            { leasedUntil: { lte: now } },
          ],
        },
      ],
    };

    let runs = [];
    if (afterId) {
      runs = await syncRun.findMany({
        where: {
          ...baseWhere,
          id: { gt: afterId },
        },
        orderBy: [
          ...(hasNextCheckAt ? [{ nextCheckAt: "asc" }] : []),
          { id: "asc" },
        ],
        take: capacity,
        select: {
          id: true,
          shop: true,
          status: true,
        },
      });
    }

    if (runs.length < capacity) {
      const wrapped = await syncRun.findMany({
        where: afterId
          ? { ...baseWhere, id: { lte: afterId } }
          : baseWhere,
        orderBy: [
          ...(hasNextCheckAt ? [{ nextCheckAt: "asc" }] : []),
          { id: "asc" },
        ],
        take: capacity - runs.length,
        select: {
          id: true,
          shop: true,
          status: true,
        },
      });
      runs.push(...wrapped);
    }

    let scheduled = 0;
    for (const run of runs) {
      if (typeof enqueue === "function") {
        await enqueue(run.shop, run.id, run.status);
        scheduled++;
        afterId = run.id;
      }
    }

    if (!runs.length) {
      afterId = "";
    }

    return scheduled;
  };
}

export const scanDueSyncRuns = createSyncScanner();
