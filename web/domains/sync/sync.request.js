import { randomUUID } from "node:crypto";

// Caller holds the Shop row lock. Reservation and webhook capture start before
// the first Shopify export request; Redis is only a delivery mechanism.
export async function reserveCatalogSync(tx, merchant) {
  if (merchant.activeRunId) return null;
  const run = await tx.snapshotRun.create({
    data: {
      id: randomUUID(),
      shop: merchant.domain,
      generation: merchant.generation,
      status: "PENDING",
    },
  });
  await tx.shop.update({
    where: { domain: merchant.domain },
    data: { activeRunId: run.id },
  });
  await tx.catalogSyncState.upsert({
    where: { shop: merchant.domain },
    create: {
      shop: merchant.domain,
      generation: merchant.generation,
      status: "PENDING",
    },
    update: { generation: merchant.generation, status: "PENDING" },
  });
  await tx.$executeRaw`INSERT INTO "SnapshotChange" ("runId","productId","revision","dirty")
    SELECT ${run.id},"productId","revision",true FROM "CatalogChange" WHERE "shop"=${merchant.domain} AND "dirty"
    ON CONFLICT ("runId","productId") DO NOTHING`;
  await tx.$executeRaw`INSERT INTO "SnapshotInventoryChange" ("runId","inventoryItemId","revision","dirty")
    SELECT ${run.id},"inventoryItemId","revision",true FROM "InventoryChange" WHERE "shop"=${merchant.domain} AND "dirty"
    ON CONFLICT ("runId","inventoryItemId") DO NOTHING`;
  return run;
}
