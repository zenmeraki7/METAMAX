import { catalogIdentity, lockCatalogStaging, mirrorError } from "./ownership.js";
import { syncTransaction } from "../domains/sync/sync.lease.js";
// Reset is one owned transaction. Replay reuses the same durable lease and every
// batch renews/checks it; there are no session locks or arbitrary byte offsets.
export async function resetCatalogStaging(db, input) {
  if (typeof db?.$transaction !== "function") throw new TypeError("The existing Prisma database client is required");
  const context = catalogIdentity(input);
  return syncTransaction(async tx => {
    const run = await lockCatalogStaging(tx, context);
    if (await tx.snapshotRetentionPin.count({ where: { shop: context.shopId, snapshotId: context.runId } }))
      throw mirrorError("SNAPSHOT_PINNED", "A referenced snapshot cannot be reset");
    await tx.snapshotDataset.deleteMany({ where: { runId: context.runId, name: { in: ["products", "variants"] } } });
    // Variant projection rows cascade from the complete product envelopes.
    await tx.snapshotProduct.deleteMany({ where: { runId: context.runId } });
    const manifest = { ...run.exportManifest }; delete manifest.products;
    const updated = await tx.$executeRaw`UPDATE "SnapshotRun" SET "importedProducts"=0, "exportManifest"=${JSON.stringify(manifest)}::jsonb
      WHERE "id"=${context.runId} AND "shop"=${context.shopId} AND "generation"=${context.generation}
        AND "status"='INGESTING' AND "exportName"='products' AND "leaseToken"=${context.leaseToken} AND "leasedUntil">clock_timestamp()`;
    if (updated !== 1) throw mirrorError("SYNC_LEASE_LOST", "Catalogue lease expired during reset");
    // SnapshotChange invalidations remain durable across replay.
    return Object.freeze({ reset: true, runId: context.runId });
  }, { maxWait: 5000, timeout: 30000 }, db);
}
