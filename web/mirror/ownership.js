// Shared staging guard for coverage verification and replay reset.
import { FieldError, isPlainRecord, isCoverageToken, ownValue } from "../fields/types.js";
export const mirrorError = (code, message) => new FieldError(code, message);
export function catalogIdentity(input, { lease = true } = {}) {
  if (!isPlainRecord(input)) throw new TypeError("Trusted catalogue context is required");
  const allowed = ["shopId", "generation", "generationId", "runId", "snapshotId", "leaseToken"];
  for (const key of Reflect.ownKeys(input)) {
    if (!allowed.includes(key)) throw new TypeError("Unsupported catalogue context property");
    ownValue(input, key);
  }
  const shopId = ownValue(input, "shopId");
  const generation = ownValue(input, "generation") ?? ownValue(input, "generationId");
  const runId = ownValue(input, "runId") ?? ownValue(input, "snapshotId");
  const leaseToken = ownValue(input, "leaseToken");
  if (typeof shopId !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId) ||
      !isCoverageToken(generation) || !isCoverageToken(runId) || (lease && !isCoverageToken(leaseToken)))
    throw new TypeError("Shop, installation generation, snapshot run and owning lease are required");
  if ((ownValue(input, "generation") !== undefined && ownValue(input, "generationId") !== undefined && ownValue(input, "generation") !== ownValue(input, "generationId")) ||
      (ownValue(input, "runId") !== undefined && ownValue(input, "snapshotId") !== undefined && ownValue(input, "runId") !== ownValue(input, "snapshotId")))
    throw new TypeError("Conflicting catalogue context aliases");
  return { shopId, generation, runId, leaseToken };
}
export async function lockCatalogStaging(tx, context) {
  const { shopId, generation, runId, leaseToken } = context;
  const shops = await tx.$queryRaw`SELECT "status","generation","activeRunId","activeSnapshotId","installationVerified" FROM "Shop" WHERE "domain"=${shopId} FOR SHARE`;
  const shop = shops[0];
  if (shop?.status !== "ACTIVE" || shop.generation !== generation || shop.installationVerified !== true || shop.activeRunId !== runId || shop.activeSnapshotId === runId)
    throw mirrorError("SYNC_RUN_NOT_ACTIVE", "An owned unpublished staging run is required");
  const runs = await tx.$queryRaw`SELECT * FROM "SnapshotRun" WHERE "id"=${runId} AND "shop"=${shopId} AND "generation"=${generation} FOR UPDATE`;
  const run = runs[0];
  if (run?.status !== "INGESTING" || run.exportName !== "products" || run.leaseToken !== leaseToken)
    throw mirrorError("INVALID_VERIFICATION_STATE", "Core catalogue ingestion must own the active lease");
  const [clock] = await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM "SnapshotRun" WHERE "id"=${runId} AND "leaseToken"=${leaseToken} AND "leasedUntil">clock_timestamp()) AS owned`;
  if (!clock?.owned) throw mirrorError("SYNC_LEASE_LOST", "Catalogue lease expired");
  return run;
}
