import {
  validateItem,
  validateLevel,
  requireTransaction,
} from "./inventory.service.js";

// Staging-only writer. The caller must hold the current ingestion lease and
// publication fence; reconciliation continues to use its revision-safe writer.
export async function writeInventorySnapshotBatch(
  tx,
  shop,
  snapshotId,
  observations,
) {
  if (
    !tx ||
    typeof tx.$executeRaw !== "function" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "") ||
    typeof snapshotId !== "string" ||
    !snapshotId
  )
    throw new TypeError(
      "A scoped inventory snapshot and existing transaction are required",
    );
  const items = [],
    levels = [],
    quantities = [],
    locations = new Map(),
    ids = new Set();
  for (const current of observations) {
    const item = current?.item;
    if (
      !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/.test(item?.id || "") ||
      ids.has(item.id) ||
      !Array.isArray(current.levels) ||
      current.levels.length > 10000
    )
      throw new TypeError("Invalid or repeated inventory batch item");
    ids.add(item.id);
    validateItem(item, item.id);
    items.push({
      shop,
      snapshotId,
      id: item.id,
      sku: item.sku,
      tracked: item.tracked,
      requiresShipping: item.requiresShipping,
      sourceUpdatedAt: new Date(item.updatedAt),
    });
    const itemLocations = new Set(),
      itemLevels = new Set();
    for (const level of current.levels) {
      validateLevel(level);
      const location = level.location;
      if (itemLocations.has(location.id) || itemLevels.has(level.id))
        throw new TypeError("Repeated inventory location or level");
      itemLocations.add(location.id);
      itemLevels.add(level.id);
      const locationRow = {
        shop,
        snapshotId,
        id: location.id,
        name: location.name,
        isActive: location.isActive,
        fulfillsOnlineOrders: location.fulfillsOnlineOrders,
        sourceUpdatedAt: new Date(location.updatedAt),
      };
      if (
        !locations.has(location.id) ||
        locations.get(location.id).sourceUpdatedAt <=
          locationRow.sourceUpdatedAt
      )
        locations.set(location.id, locationRow);
      levels.push({
        shop,
        snapshotId,
        inventoryItemId: item.id,
        locationId: location.id,
        shopifyLevelId: level.id,
        isActive: level.isActive,
        sourceUpdatedAt: new Date(level.updatedAt),
      });
      for (const quantity of level.quantities)
        quantities.push({
          shop,
          snapshotId,
          inventoryItemId: item.id,
          locationId: location.id,
          name: quantity.name,
          quantity: quantity.quantity,
          sourceUpdatedAt:
            quantity.updatedAt == null ? null : new Date(quantity.updatedAt),
        });
    }
  }
  // Replays replace only these items in unpublished staging. Cascades remove
  // their old levels/quantities, and any failed write rolls back the whole batch.
  await requireTransaction(tx);
  await tx.inventoryItem.deleteMany({
    where: { shop, snapshotId, id: { in: [...ids] } },
  });
  await tx.inventoryItem.createMany({ data: items });
  if (locations.size) {
    const rows = [...locations.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    await tx.$executeRaw`INSERT INTO "InventoryLocation"
      ("shop","snapshotId","id","name","isActive","fulfillsOnlineOrders","sourceUpdatedAt")
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        "shop" text,"snapshotId" text,"id" text,"name" text,"isActive" boolean,
        "fulfillsOnlineOrders" boolean,"sourceUpdatedAt" timestamp)
      ON CONFLICT ("shop","snapshotId","id") DO UPDATE SET
        "name"=EXCLUDED."name", "isActive"=EXCLUDED."isActive",
        "fulfillsOnlineOrders"=EXCLUDED."fulfillsOnlineOrders", "sourceUpdatedAt"=EXCLUDED."sourceUpdatedAt"
      WHERE "InventoryLocation"."sourceUpdatedAt"<=EXCLUDED."sourceUpdatedAt"`;
  }
  for (let i = 0; i < levels.length; i += 2000)
    await tx.inventoryLevel.createMany({ data: levels.slice(i, i + 2000) });
  for (let i = 0; i < quantities.length; i += 2000)
    await tx.inventoryQuantity.createMany({
      data: quantities.slice(i, i + 2000),
    });
}
