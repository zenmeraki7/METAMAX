import { FieldError, deepFreeze, isPlainRecord, ownValue } from "../fields/types.js";
import { CORE_DATASETS, buildDatasetCoverage, requireDataset, isDatasetAvailable } from "./datasets.js";
import { catalogIdentity, lockCatalogStaging, mirrorError } from "./ownership.js";
import { syncTransaction } from "../domains/sync/sync.lease.js";
import { isCompletedIngestion } from "../domains/sync/sync.importer.js";
const issuedCoverage = new WeakSet();
const transactionOptions = { maxWait: 5000, timeout: 30000, isolationLevel: "ReadCommitted" };
export function sourceCount(value) {
  if ((typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) &&
      !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0) &&
      !(typeof value === "bigint" && value >= 0n)) throw mirrorError("INVALID_SOURCE_COUNT", "An exact nonnegative source count is required");
  const count = BigInt(value);
  if (count > 9223372036854775807n) throw mirrorError("INVALID_SOURCE_COUNT", "Source count exceeds the supported range");
  return count;
}
// Internal importer adapter. A copied object, raw frontend counts or a parser
// result returned before its database writes finish cannot issue source evidence.
export function catalogSourceProof(operation, ingestion) {
  if (!isCompletedIngestion(ingestion) || operation?.status !== "COMPLETED" ||
      typeof operation.id !== "string" || !/^gid:\/\/shopify\/BulkOperation\/[1-9]\d*$/.test(operation.id))
    throw mirrorError("SOURCE_VERIFICATION_REQUIRED", "Completed Shopify and durable stream results are required");
  if (sourceCount(operation.rootObjectCount) !== BigInt(ingestion.roots) || sourceCount(operation.objectCount) !== BigInt(ingestion.objects))
    throw mirrorError("SOURCE_COUNT_MISMATCH", "Source manifest does not match completed ingestion");
  return deepFreeze({ operationId: operation.id, status: "COMPLETED", streamComplete: true,
    expectedProducts: String(operation.rootObjectCount), expectedObjects: String(operation.objectCount),
    importedProducts: String(ingestion.roots), importedVariants: String(ingestion.children),
    checksum: ingestion.checksum, checksumAlgorithm: ingestion.checksumAlgorithm });
}
function proofOf(run) {
  const proof = run.exportManifest?.products?.source;
  if (!isPlainRecord(proof) || proof.status !== "COMPLETED" || proof.streamComplete !== true ||
      typeof proof.operationId !== "string" || !/^gid:\/\/shopify\/BulkOperation\/[1-9]\d*$/.test(proof.operationId) ||
      typeof proof.checksum !== "string" || !/^[a-f0-9]{64}$/.test(proof.checksum) || proof.checksumAlgorithm !== "sha256-jsonl-lines-v1")
    throw mirrorError("SOURCE_VERIFICATION_REQUIRED", "Completed source and full-stream verification are missing");
  return proof;
}
function issue(context, products, variants, published) {
  const coverage = deepFreeze({ ready: true, publicationReady: published,
    shopId: context.shopId, generation: context.generation, snapshotId: context.runId,
    products: products.toString(), variants: variants.toString(),
    datasets: buildDatasetCoverage(CORE_DATASETS), definitions: {} });
  issuedCoverage.add(coverage);
  return coverage;
}
export async function verifyCatalogCoverage(db, input) {
  if (typeof db?.$transaction !== "function") throw new TypeError("The existing Prisma database client is required");
  const context = catalogIdentity(input);
  return syncTransaction(async tx => {
    const run = await lockCatalogStaging(tx, context), proof = proofOf(run);
    if (proof.operationId !== run.bulkOperationId) throw mirrorError("SOURCE_OPERATION_MISMATCH", "Source verification belongs to another operation");
    const [counts] = await tx.$queryRaw`SELECT
      (SELECT COUNT(*) FROM "SnapshotProduct" WHERE "runId"=${context.runId})::bigint AS products,
      (SELECT COUNT(*) FROM "Variant" WHERE "shop"=${context.shopId} AND "snapshotId"=${context.runId})::bigint AS variants`;
    const products = sourceCount(counts.products), variants = sourceCount(counts.variants);
    if (products !== sourceCount(run.importedProducts) || products !== sourceCount(run.expectedProducts) ||
        products !== sourceCount(proof.importedProducts) || variants !== sourceCount(proof.importedVariants) ||
        products !== sourceCount(proof.expectedProducts) || products + variants !== sourceCount(proof.expectedObjects))
      throw mirrorError("CATALOG_COVERAGE_MISMATCH", "Completed source counts do not match durable staging");
    for (const [name, count] of [["products", products], ["variants", variants]])
      await tx.snapshotDataset.upsert({ where: { runId_name: { runId: context.runId, name } },
        create: { runId: context.runId, name, expectedRecords: count, importedRecords: count },
        update: { expectedRecords: count, importedRecords: count, completedAt: new Date() } });
    const manifest = { ...run.exportManifest, products: { ...run.exportManifest.products, verified: true } };
    const updated = await tx.$executeRaw`UPDATE "SnapshotRun" SET "exportManifest"=${JSON.stringify(manifest)}::jsonb
      WHERE "id"=${context.runId} AND "shop"=${context.shopId} AND "generation"=${context.generation}
        AND "status"='INGESTING' AND "exportName"='products' AND "leaseToken"=${context.leaseToken} AND "leasedUntil">clock_timestamp()`;
    if (updated !== 1) throw mirrorError("SYNC_LEASE_LOST", "Catalogue lease expired during verification");
    // No overall READY/publication transition: auxiliary coverage and revision
    // reconciliation still belong to the existing coordinator/publication fence.
    return issue(context, products, variants, false);
  }, transactionOptions, db);
}
export async function readSnapshotCoverage(db, input) {
  if (typeof db?.$transaction !== "function") throw new TypeError("The existing Prisma database client is required");
  const context = catalogIdentity(input, { lease: false });
  return syncTransaction(async tx => {
    const shops = await tx.$queryRaw`SELECT "status","generation","activeSnapshotId","installationVerified" FROM "Shop" WHERE "domain"=${context.shopId} FOR SHARE`;
    if (shops[0]?.status !== "ACTIVE" || shops[0].installationVerified !== true || shops[0].generation !== context.generation || shops[0].activeSnapshotId !== context.runId)
      throw mirrorError("COVERAGE_CONTEXT_MISMATCH", "A current verified publication context is required");
    const run = await tx.snapshotRun.findUnique({ where: { id: context.runId } });
    if (run?.shop !== context.shopId || run.generation !== context.generation || run.status !== "COMPLETED" || run.exportManifest?.products?.verified !== true)
      throw mirrorError("CORE_COVERAGE_NOT_VERIFIED", "Published core coverage has not been verified");
    const proof = proofOf(run);
    const records = await tx.snapshotDataset.findMany({ where: { runId: context.runId, name: { in: CORE_DATASETS } } });
    for (const name of CORE_DATASETS) {
      const record = records.find(row => row.name === name);
      const expected = sourceCount(name === "products" ? proof.expectedProducts : proof.importedVariants);
      if (!record || sourceCount(record.expectedRecords) !== expected || sourceCount(record.importedRecords) !== expected)
        throw mirrorError("CORE_COVERAGE_NOT_VERIFIED", "A verified core dataset record is required");
    }
    return issue(context, sourceCount(proof.expectedProducts), sourceCount(proof.importedVariants), true);
  }, transactionOptions, db);
}
// Compatibility name now accepts only evidence issued by the database verifier.
export function createSnapshotCoverage(coverage) {
  if (!issuedCoverage.has(coverage)) throw new TypeError("Database-verified coverage is required; caller flags are not accepted");
  return coverage;
}
export function checkDatasetCoverage(coverage, requiredDatasets = [], expectedContext) {
  if (!issuedCoverage.has(coverage)) throw new TypeError("Database-verified coverage is required");
  const expected = catalogIdentity(expectedContext, { lease: false });
  if (coverage.shopId !== expected.shopId || coverage.generation !== expected.generation || coverage.snapshotId !== expected.runId)
    throw new FieldError("COVERAGE_CONTEXT_MISMATCH", "Coverage belongs to another shop, generation or snapshot");
  if (!Array.isArray(requiredDatasets) || requiredDatasets.length > 100) throw new TypeError("A bounded required dataset array is required");
  const required = [];
  for (let i = 0; i < requiredDatasets.length; i++) required.push(requireDataset(ownValue(requiredDatasets, String(i))));
  const missing = [...new Set(required)].filter(name => !isDatasetAvailable(name) || coverage.datasets[name] !== true);
  return deepFreeze({ ready: missing.length === 0, required, missing });
}
