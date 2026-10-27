import { prisma } from "../../db/client.js";

import {
  processRepairStep,
} from "./repair.service.js";

const POLL_MS = 60_000;
const BATCH_SIZE = 20;
const CONCURRENCY = 2;

export function startCatalogRepairScheduler({
  requestFullSnapshot,
  logger = console,
}) {
  if (typeof requestFullSnapshot !== "function") {
    throw new TypeError(
      "requestFullSnapshot callback is required"
    );
  }

  let stopping = false;
  let timer = null;
  let active = null;

  async function runBatch() {
    const now = new Date();

    const due = await prisma.catalogRepair.findMany({
      where: {
        kind: { in: ["PRODUCT", "VARIANT", "INVENTORY_ITEM", "INVENTORY_LEVEL", "FULL"] },
        attempts: { gte: 0, lt: 8 },
        merchant: { status: "ACTIVE", installationVerified: true },
        nextCheckAt: { lte: now },
        OR: [
          { leasedUntil: null },
          { leasedUntil: { lte: now } },
        ],
      },

      orderBy: [
        { nextCheckAt: "asc" },
        { shop: "asc" },
        { kind: "asc" },
      ],

      select: {
        shop: true,
        kind: true,
      },

      take: BATCH_SIZE,
    });

    for (
      let offset = 0;
      offset < due.length && !stopping;
      offset += CONCURRENCY
    ) {
      const batch = due.slice(
        offset,
        offset + CONCURRENCY
      );

      await Promise.all(
        batch.map(async ({ shop, kind }) => {
          try {
            await processRepairStep(
              shop,
              kind,
              { requestFullSnapshot }
            );
          } catch (error) {
            logger.error(
              "[repair] Step failed",
              {
                shop,
                kind,
                message: error?.message,
              }
            );
          }
        })
      );
    }
  }

  async function tick() {
    if (stopping || active) return;

    active = runBatch()
      .catch((error) => {
        logger.error(
          "[repair] Scheduler failed",
          error
        );
      })
      .finally(() => {
        active = null;
      });

    await active;
  }

  function schedule() {
    if (stopping) return;

    timer = setTimeout(
      async () => {
        await tick();
        schedule();
      },
      POLL_MS
    );
  }

  void tick().finally(schedule);

  // Wait for this scheduler's own operations
  // before closing Prisma during shutdown.
  return async function stop() {
    stopping = true;
    clearTimeout(timer);

    if (active) {
      await active;
    }
  };
}
