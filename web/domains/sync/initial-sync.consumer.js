import { randomUUID, createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { syncTransaction } from "./sync.lease.js";
import { reserveCatalogSync } from "./sync.request.js";
import { ACTIVE } from "./sync.repository.js";

export const INITIAL_SYNC_MAX_ATTEMPTS = 8;
const POLL_MS = 5000;
const LEASE_MS = 60000;
const key = (shop, generation) => ({ shop_generation: { shop, generation } });
const hash = (shop) => createHash("sha256").update(shop).digest("hex");

// A request drives reservation and observes publication; the existing sync worker
// owns export/ingestion/reconciliation. No Shopify calls or Redis dependency here.
export async function consumeInitialSyncRequest(
  shop,
  generation,
  { db = prisma, reserve = reserveCatalogSync } = {}
) {
  const token = randomUUID();
  const transaction = (fn) => syncTransaction(fn, undefined, db);
  const claimed = await transaction(async (tx) => {
    // Consistent lock order with installation and publication: Shop first.
    await tx.$queryRaw`SELECT "domain" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
    const rows =
      await tx.$queryRaw`UPDATE "InitialSyncRequest" SET "leaseToken"=${token},
      "leasedUntil"=clock_timestamp()+(${LEASE_MS} * interval '1 millisecond'), "updatedAt"=clock_timestamp()
      WHERE "shop"=${shop} AND "generation"=${generation} AND "status" IN ('PENDING','RUNNING')
      AND "attempts"<${INITIAL_SYNC_MAX_ATTEMPTS} AND "nextCheckAt"<=clock_timestamp()
      AND ("leasedUntil" IS NULL OR "leasedUntil"<=clock_timestamp()) RETURNING *`;
    return rows[0];
  });
  if (!claimed) return { status: "not_due_or_leased" };
  try {
    return await transaction(async (tx) => {
      const [merchant] =
        await tx.$queryRaw`SELECT * FROM "Shop" WHERE "domain"=${shop} FOR UPDATE`;
      const [owned] =
        await tx.$queryRaw`SELECT *,"leasedUntil">clock_timestamp() AS owned
        FROM "InitialSyncRequest" WHERE "shop"=${shop} AND "generation"=${generation} FOR UPDATE`;
      if (owned?.leaseToken !== token || !owned.owned)
        return { status: "superseded" };
      const marker = await tx.installationState.findUnique({
        where: { shopHash: hash(shop) },
      });
      let data;
      if (
        merchant?.status !== "ACTIVE" ||
        !merchant.installationVerified ||
        merchant.generation !== generation ||
        marker?.status !== "ACTIVE" ||
        marker.generation !== generation
      ) {
        data = {
          status: "CANCELLED",
          completedAt: new Date(),
          lastError: "Installation changed or is inactive",
        };
      } else {
        // A published catalog wins over scheduling tokens, including requests
        // backfilled after an older version had already reserved the import.
        const id =
          merchant.activeSnapshotId || merchant.activeRunId || owned.snapshotId;
        let run = id
          ? await tx.snapshotRun.findUnique({ where: { id } })
          : null;
        if (id && (!run || run.shop !== shop || run.generation !== generation))
          throw Error(
            "Initial sync snapshot does not belong to this installation"
          );
        if (!run) run = await reserve(tx, merchant);
        if (!run) throw Error("Initial sync reservation did not return a run");
        if (run.status === "COMPLETED") {
          if (!run.completedAt)
            throw Error("Completed snapshot has no publication time");
          data = {
            status: "COMPLETED",
            snapshotId: run.id,
            completedAt: run.completedAt,
            lastError: null,
            attempts: 0,
          };
        } else if (
          ACTIVE.includes(run.status) &&
          (merchant.activeRunId === run.id || !id)
        ) {
          data = {
            status: "RUNNING",
            snapshotId: run.id,
            startedAt: owned.startedAt ?? new Date(),
            nextCheckAt: new Date(Date.now() + POLL_MS),
            lastError: null,
            attempts: 0,
          };
        } else {
          data = {
            status: "FAILED",
            snapshotId: run.id,
            completedAt: new Date(),
            lastError: run.lastError || `Import ended in ${run.status}`,
          };
        }
      }
      await tx.initialSyncRequest.update({
        where: key(shop, generation),
        data,
      });
      const acknowledged =
        await tx.$executeRaw`UPDATE "InitialSyncRequest" SET "leaseToken"=NULL,"leasedUntil"=NULL
        WHERE "shop"=${shop} AND "generation"=${generation} AND "leaseToken"=${token} AND "leasedUntil">clock_timestamp()`;
      if (acknowledged !== 1)
        throw Error("Initial sync request lease lost before completion");
      return { status: data.status, snapshotId: data.snapshotId ?? null };
    });
  } catch (error) {
    await transaction(async (tx) => {
      await tx.$queryRaw`SELECT "domain" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
      const attempts = claimed.attempts + 1;
      await tx.$executeRaw`UPDATE "InitialSyncRequest" SET "attempts"=${attempts},
        "status"=${
          attempts >= INITIAL_SYNC_MAX_ATTEMPTS ? "FAILED" : claimed.status
        },
        "completedAt"=${
          attempts >= INITIAL_SYNC_MAX_ATTEMPTS ? new Date() : null
        },
        "lastError"=${String(error.message ?? error).slice(0, 500)},
        "nextCheckAt"=clock_timestamp()+(${Math.min(
          300000,
          5000 * 2 ** (attempts - 1)
        )} * interval '1 millisecond'),
        "leaseToken"=NULL,"leasedUntil"=NULL,"updatedAt"=clock_timestamp()
        WHERE "shop"=${shop} AND "generation"=${generation} AND "leaseToken"=${token}
        AND "leasedUntil">clock_timestamp() AND "status" IN ('PENDING','RUNNING')`;
    });
    throw error;
  }
}

export async function scanInitialSyncRequests({
  db = prisma,
  limit = 20,
  consume = consumeInitialSyncRequest,
  logger = console,
} = {}) {
  const now = new Date();
  const requests = await db.initialSyncRequest.findMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      attempts: { lt: INITIAL_SYNC_MAX_ATTEMPTS },
      nextCheckAt: { lte: now },
      OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }],
    },
    orderBy: [{ nextCheckAt: "asc" }, { shop: "asc" }, { generation: "asc" }],
    take: limit,
    select: { shop: true, generation: true },
  });
  for (const request of requests) {
    try {
      await consume(request.shop, request.generation, { db });
    } catch (error) {
      logger.error("[initial-sync] Request failed:", error.message);
    }
  }
  return requests.length;
}
