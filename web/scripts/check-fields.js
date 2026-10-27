import { prisma, disconnectDatabase } from "../shared/db.js";
import { listFields, resolveFieldValue, INVENTORY_FIELD_QUANTITIES, FieldError } from "../fields/index.js";

// Read-only compatibility check against one explicitly named installation.
const args = process.argv.slice(2);
const shop = args[0] === "--shop" && args.length === 2 ? args[1] : null;
if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  console.error("Usage: node scripts/check-fields.js --shop STORE.myshopify.com");
  process.exitCode = 1;
} else {
  try {
    const result = await prisma.$transaction(async tx => {
      const merchant = await tx.shop.findUnique({ where: { domain: shop } });
      if (!merchant?.activeSnapshotId || merchant.status !== "ACTIVE" || !merchant.installationVerified)
        throw new FieldError("PUBLISHED_SNAPSHOT_REQUIRED", "An active verified installation with a published snapshot is required");
      const snapshot = await tx.snapshotRun.findUnique({ where: { id: merchant.activeSnapshotId } });
      if (snapshot?.shop !== shop || snapshot.generation !== merchant.generation || snapshot.status !== "COMPLETED")
        throw new FieldError("PUBLISHED_SNAPSHOT_REQUIRED", "Published snapshot ownership did not match");
      const where = { shop, snapshotId: snapshot.id };
      const product = await tx.snapshotProduct.findFirst({ where: { runId: snapshot.id }, orderBy: { productId: "asc" } });
      const item = await tx.inventoryItem.findFirst({ where });
      const location = await tx.inventoryLocation.findFirst({ where });
      const level = await tx.inventoryLevel.findFirst({ where });
      const checked = [], skipped = [];
      for (const [entity, record] of [["product", product], ["variant", product], ["inventoryItem", item], ["location", location], ["inventoryLevel", level]]) {
        for (const field of listFields({ entity })) {
          if (field.sources.mirror.quantityName) continue;
          const variantId = product?.data?.variants?.[0]?.id;
          if (!record || (entity === "variant" && !variantId)) { skipped.push(field.id); continue; }
          resolveFieldValue(field.id, record, entity === "variant" ? { variantId } : undefined);
          checked.push(field.id);
        }
      }
      for (const name of INVENTORY_FIELD_QUANTITIES) {
        const record = await tx.inventoryQuantity.findFirst({ where: { ...where, name } });
        const field = `inventoryLevel.${name}`;
        if (!record) { skipped.push(field); continue; }
        resolveFieldValue(field, record);
        checked.push(field);
      }
      return { checkedFields: checked.length, skippedFields: skipped, snapshotStatus: snapshot.status };
    }, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 30000 });
    console.log(JSON.stringify({ ...result, readOnly: true }));
    // An empty catalogue is valid but cannot certify mappings against real rows.
    if (result.skippedFields.length) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || "FIELD_COMPATIBILITY_CHECK_FAILED", field: error.field ?? null }));
    process.exitCode = 1;
  }
}
await disconnectDatabase();
