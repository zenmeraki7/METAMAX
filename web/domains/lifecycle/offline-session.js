import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { registerShopInTransaction } from "./lifecycle.repository.js";

const columns = new Set([
  "id",
  "shop",
  "state",
  "isOnline",
  "scope",
  "expires",
  "onlineAccessInfo",
  "accessToken",
]);

async function enqueueInitialSync(...args) {
  const { enqueueSyncRun } = await import("../../queues/sync.queue.js");
  return enqueueSyncRun(...args);
}

export function validateOfflineSession(session) {
  if (
    !session ||
    session.isOnline !== false ||
    typeof session.shop !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(session.shop) ||
    session.id !== `offline_${session.shop}` ||
    typeof session.accessToken !== "string" ||
    !session.accessToken.trim() ||
    typeof session.toPropertyArray !== "function" ||
    (session.expires &&
      (typeof session.expires.getTime !== "function" ||
        !Number.isFinite(session.expires.getTime()) ||
        session.expires <= new Date()))
  ) {
    throw new TypeError(
      "A valid authenticated offline session is required for installation registration",
    );
  }
}

// Only call after Shopify has authenticated the OAuth/token-exchange response.
// Credentials, registration, and the initial sync state commit atomically.
export async function persistOfflineInstallation(
  session,
  {
    db = prisma,
    initialize = registerShopInTransaction,
    enqueue = enqueueInitialSync,
    logger = console,
  } = {},
) {
  validateOfflineSession(session);
  const entries = session.toPropertyArray().map(([key, value]) => {
    if (!columns.has(key))
      throw new TypeError("Unsupported offline session storage field");
    return [key, key === "expires" ? Math.floor(value / 1000) : value];
  });
  let initialRun;
  const stored = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${session.shop}, 0))`;
      const names = entries.map(([key]) => Prisma.raw(`"${key}"`));
      const values = entries.map(([, value]) => value);
      const updates = entries.map(
        ([key]) =>
          Prisma.sql`${Prisma.raw(`"${key}"`)} = EXCLUDED.${Prisma.raw(
            `"${key}"`,
          )}`,
      );
      await tx.$executeRaw(Prisma.sql`INSERT INTO "shopify_sessions" (${Prisma.join(
        names,
      )}) VALUES (${Prisma.join(values)})
      ON CONFLICT ("id") DO UPDATE SET ${Prisma.join(updates)}`);
      const merchant = await initialize(tx, session.shop);
      // Only wake an owned, due initial import. Reauthentication must not
      // restart a completed catalogue or bypass an existing run's backoff.
      if (merchant?.activeRunId && !merchant.activeSnapshotId) {
        initialRun = await tx.snapshotRun.findFirst({
          where: {
            id: merchant.activeRunId,
            shop: session.shop,
            generation: merchant.generation,
            status: "PENDING",
            nextCheckAt: { lte: new Date() },
          },
          select: { id: true, shop: true, status: true },
        });
      }
      return true;
    },
    // Remote database round trips can exceed four seconds even without lock
    // contention. Keep registration atomic with a bounded, realistic budget.
    { maxWait: 5000, timeout: 15000 },
  );

  if (initialRun) {
    // Dispatch only after credentials and the durable reservation commit.
    // Redis and the import must never delay or fail successful authorization.
    void Promise.resolve()
      .then(() => enqueue(initialRun.shop, initialRun.id, initialRun.status))
      .catch((error) =>
        logger.error(
          "[initial-sync] Immediate dispatch failed; durable scanner will retry:",
          error?.code ?? "QUEUE_UNAVAILABLE",
        ),
      );
  }
  return stored;
}

// Composition preserves the installed adapter's public SessionStorage contract.
// Every flow that saves a validated offline session (not just OAuth callbacks)
// gets installation registration before storeSession reports success.
export function installationSessionStorage(
  base,
  persist = persistOfflineInstallation,
) {
  return {
    async storeSession(session) {
      if (session.isOnline === true) return base.storeSession(session);
      validateOfflineSession(session);
      await base.loadSession(session.id); // Wait for the base adapter's schema initialization.
      return persist(session);
    },
    loadSession: (...args) => base.loadSession(...args),
    deleteSession: (...args) => base.deleteSession(...args),
    deleteSessions: (...args) => base.deleteSessions(...args),
    findSessionsByShop: (...args) => base.findSessionsByShop(...args),
    disconnect: (...args) => base.disconnect(...args),
  };
}
