import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "../../db/client.js";

export const SYNC_LEASE_MS = 120000;
export const SYNC_HEARTBEAT_MS = 30000;
export const SYNC_TRANSACTION = Object.freeze({
  maxWait: 5000,
  timeout: 30000,
  isolationLevel: "ReadCommitted",
});
export const syncError = (code, message) =>
  Object.assign(new Error(message), { code });

export function validateRun(run) {
  if (
    !run ||
    typeof run.id !== "string" ||
    !run.id.trim() ||
    typeof run.shop !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(run.shop)
  )
    throw TypeError("A valid sync run id and canonical shop are required");
}
export function validateToken(token) {
  if (typeof token !== "string" || !token.trim())
    throw TypeError("A sync lease token is required");
}

export async function syncTransaction(fn, options = SYNC_TRANSACTION, db = prisma) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, options);
    } catch (error) {
      const conflict =
        ["P2034", "P2002"].includes(error?.code) ||
        (error?.code === "P2010" &&
          ["40001", "40P01"].includes(error.meta?.code));
      if (!conflict || attempt >= 1) throw error;
      await sleep(30 * (attempt + 1));
    }
  }
}

export async function lockSyncShop(tx, run) {
  const shops =
    await tx.$queryRaw`SELECT "generation", "status", "activeRunId" FROM "Shop"
    WHERE "domain"=${run.shop} FOR SHARE`;
  if (
    shops[0]?.status !== "ACTIVE" ||
    shops[0].activeRunId !== run.id ||
    (run.generation !== undefined && run.generation !== shops[0].generation)
  )
    throw syncError(
      "SYNC_RUN_NOT_ACTIVE",
      "Installation changed or shop no longer owns this staging run"
    );
  return shops[0];
}

// Caller holds Shop before updating SnapshotRun. All expiration checks use the
// database clock; GREATEST prevents this policy from shortening a longer lease.
export async function renewSnapshotLeaseTx(
  tx,
  run,
  token,
  generation,
  { includeIngestion = false } = {}
) {
  const rows = await tx.$queryRaw`UPDATE "SnapshotRun"
    SET "leasedUntil"=GREATEST("leasedUntil", clock_timestamp() + (${SYNC_LEASE_MS} * interval '1 millisecond'))
    WHERE "id"=${run.id} AND "shop"=${run.shop} AND "generation"=${generation}
      AND ("status"='RECONCILING' OR (${includeIngestion} AND "status" IN ('PENDING','STARTING','WAITING','INGESTING')))
      AND "leaseToken"=${token} AND "leasedUntil">clock_timestamp()
    RETURNING "generation", "leasedUntil"`;
  if (rows.length !== 1)
    throw syncError(
      "SYNC_LEASE_LOST",
      "Sync run lease expired or ownership changed"
    );
  return rows[0];
}

export async function renewSnapshotLease(run, token, options = {}) {
  validateRun(run);
  validateToken(token);
  return syncTransaction(async (tx) => {
    const merchant = await lockSyncShop(tx, run);
    return renewSnapshotLeaseTx(tx, run, token, merchant.generation, options);
  });
}

export async function claimSnapshotLease(
  run,
  { includeIngestion = false } = {}
) {
  validateRun(run);
  const token = randomUUID();
  return syncTransaction(async (tx) => {
    const merchant = await lockSyncShop(tx, run);
    const rows = await tx.$queryRaw`UPDATE "SnapshotRun"
      SET "leaseToken"=${token}, "leasedUntil"=clock_timestamp() + (${SYNC_LEASE_MS} * interval '1 millisecond')
      WHERE "id"=${run.id} AND "shop"=${run.shop} AND "generation"=${merchant.generation}
        AND ("status"='RECONCILING' OR (${includeIngestion} AND "status" IN ('PENDING','STARTING','WAITING','INGESTING')))
        AND "nextCheckAt"<=clock_timestamp() AND ("leasedUntil" IS NULL OR "leasedUntil"<=clock_timestamp())
      RETURNING "leasedUntil", "generation"`;
    if (rows.length !== 1)
      throw syncError(
        "SYNC_LEASE_UNAVAILABLE",
        "Sync run is not due, inactive, or already leased"
      );
    return { token, ...rows[0] };
  });
}

export async function releaseSnapshotLease(run, token) {
  validateRun(run);
  validateToken(token);
  await prisma.snapshotRun.updateMany({
    where: { id: run.id, shop: run.shop, leaseToken: token },
    data: { leaseToken: null, leasedUntil: null },
  });
}
