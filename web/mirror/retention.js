import { prisma } from "../shared/db.js";
import { isCoverageToken } from "../fields/types.js";
const kinds = new Set(["SELECTION", "EXPORT", "EXECUTION", "READ"]);
function identity({ shop, generation, snapshotId, kind, ownerId }) {
  if (typeof shop !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
      ![generation, snapshotId, ownerId].every(isCoverageToken) || !kinds.has(kind))
    throw new TypeError("A trusted snapshot owner and retention consumer are required");
}
export async function pinSnapshot(input, db = prisma) {
  identity(input);
  const { shop, generation, snapshotId, kind, ownerId } = input;
  return db.$transaction(async tx => {
    const shops = await tx.$queryRaw`SELECT "generation", "status", "installationVerified" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
    if (shops[0]?.generation !== generation || shops[0].status !== "ACTIVE" || !shops[0].installationVerified)
      throw Error("Snapshot installation is not active and verified");
    const runs = await tx.$queryRaw`SELECT "id" FROM "SnapshotRun" WHERE "shop"=${shop} AND "id"=${snapshotId} AND "generation"=${generation} AND "status"='COMPLETED' FOR SHARE`;
    if (runs.length !== 1) throw Error("A complete owned snapshot is required");
    const data = { shop, snapshotId, kind, ownerId };
    return tx.snapshotRetentionPin.upsert({ where: { shop_snapshotId_kind_ownerId: data }, create: data, update: {} });
  });
}
export async function releaseSnapshotPin(input, db = prisma) {
  identity(input);
  const { shop, snapshotId, kind, ownerId } = input;
  return db.snapshotRetentionPin.deleteMany({ where: { shop, snapshotId, kind, ownerId } });
}
// Only completed, unreferenced snapshots are eligible. Staging/failure retention
// remains with the sync engine. Bounded deletion avoids large cleanup transactions.
export async function pruneRetiredSnapshots({ shop, generation, before, limit = 10 }, db = prisma) {
  if (typeof shop !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
      !isCoverageToken(generation) || !(before instanceof Date) || !Number.isFinite(before.getTime()) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid snapshot retention policy");
  return db.$transaction(async tx => {
    const shops = await tx.$queryRaw`SELECT "generation", "status", "activeSnapshotId", "activeRunId" FROM "Shop" WHERE "domain"=${shop} FOR UPDATE`;
    const merchant = shops[0];
    if (merchant?.generation !== generation || merchant.status !== "ACTIVE") throw Error("Snapshot installation changed");
    const candidates = await tx.snapshotRun.findMany({ where: { shop, status: "COMPLETED", completedAt: { lt: before },
      id: { notIn: [merchant.activeSnapshotId, merchant.activeRunId].filter(Boolean) }, retentionPins: { none: {} } },
      orderBy: [{ completedAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } });
    return tx.snapshotRun.deleteMany({ where: { shop, id: { in: candidates.map(row => row.id) }, retentionPins: { none: {} } } });
  });
}
