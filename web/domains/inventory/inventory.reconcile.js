import { randomUUID, randomInt } from "node:crypto";
import { prisma } from "../../db/client.js";
import { syncTransaction } from "../sync/sync.lease.js";
import {
  fetchInventoryItem,
  writeInventoryItemSnapshot,
} from "./inventory.service.js";

export const INVENTORY_LEASE_MS = 300000;
export const INVENTORY_MAX_ATTEMPTS = 8;
function identity(shop, item) {
  if (
    typeof shop !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shop) ||
    typeof item !== "string" ||
    !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/.test(item)
  )
    throw TypeError("Canonical shop and inventory item GID required");
}
async function lockShop(tx, shop) {
  const rows =
    await tx.$queryRaw`SELECT "status", "generation", "activeSnapshotId" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
  return rows[0];
}
async function release(shop, inventoryItemId, token) {
  await prisma.inventoryChange.updateMany({
    where: { shop, inventoryItemId, leaseToken: token },
    data: { leaseToken: null, leasedUntil: null },
  });
}
async function claim(shop, inventoryItemId, token) {
  return syncTransaction(async (tx) => {
    const merchant = await lockShop(tx, shop);
    if (merchant?.status !== "ACTIVE") return { reason: "inactive" };
    const rows =
      await tx.$queryRaw`UPDATE "InventoryChange" SET "leaseToken"=${token},
      "leasedUntil"=clock_timestamp()+(${INVENTORY_LEASE_MS} * interval '1 millisecond'), "updatedAt"=clock_timestamp()
      WHERE "shop"=${shop} AND "inventoryItemId"=${inventoryItemId} AND "dirty" AND "appliedRevision"<"revision"
      AND "deadLetterAt" IS NULL AND "nextAttemptAt"<=clock_timestamp()
      AND ("leasedUntil" IS NULL OR "leasedUntil"<=clock_timestamp()) RETURNING "revision", "attempts"`;
    if (!rows.length) {
      const row = await tx.inventoryChange.findUnique({
        where: { shop_inventoryItemId: { shop, inventoryItemId } },
      });
      return {
        reason:
          !row || !row.dirty || row.appliedRevision >= row.revision
            ? "clean"
            : "not_due_or_leased",
      };
    }
    if (!merchant.activeSnapshotId) {
      await tx.$executeRaw`UPDATE "InventoryChange" SET "leaseToken"=NULL,"leasedUntil"=NULL,"waitingForSnapshot"=true,
        "nextAttemptAt"=clock_timestamp()+interval '60 seconds' WHERE "shop"=${shop} AND "inventoryItemId"=${inventoryItemId} AND "leaseToken"=${token}`;
      return { waiting: true };
    }
    return {
      ...rows[0],
      generation: merchant.generation,
      snapshotId: merchant.activeSnapshotId,
    };
  });
}

export async function reconcileInventoryItem(
  shop,
  inventoryItemId,
  options = {}
) {
  identity(shop, inventoryItemId);
  const token = randomUUID();
  const observed = await claim(shop, inventoryItemId, token);
  if (observed.waiting) return { status: "waiting_for_snapshot" };
  if (observed.reason) return { status: "skipped", reason: observed.reason };
  const { revision, attempts, generation, snapshotId } = observed;
  try {
    // Capture the publication pointer before the network read. No queued state
    // or product/variant relationship participates in inventory ownership.
    const current = await (options.fetchInventory || fetchInventoryItem)(
      shop,
      inventoryItemId,
      { generation }
    );
    const outcome = await syncTransaction(async (tx) => {
      const merchant = await lockShop(tx, shop);
      if (merchant?.status !== "ACTIVE" || merchant.generation !== generation)
        return "superseded";
      if (merchant.activeSnapshotId !== snapshotId) return "snapshot_changed";
      const snapshot = await tx.snapshotRun.findUnique({
        where: { id: snapshotId },
      });
      if (
        snapshot?.shop !== shop ||
        snapshot.generation !== generation ||
        snapshot.status !== "COMPLETED"
      )
        throw Error(
          "Inventory target is not a published snapshot of this installation"
        );
      const accepted = await tx.inventoryChange.updateMany({
        where: {
          shop,
          inventoryItemId,
          revision,
          leaseToken: token,
          dirty: true,
          appliedRevision: { lt: revision },
        },
        data: {
          appliedRevision: revision,
          dirty: false,
          attempts: 0,
          lastError: null,
          deadLetterAt: null,
          waitingForSnapshot: false,
          leaseToken: null,
          leasedUntil: null,
        },
      });
      if (accepted.count !== 1) return "superseded";
      await (options.writeInventory || writeInventoryItemSnapshot)(
        tx,
        shop,
        snapshotId,
        inventoryItemId,
        current
      );
      return "reconciled";
    });
    if (outcome !== "reconciled") await release(shop, inventoryItemId, token);
    return { status: outcome, revision: revision.toString() };
  } catch (original) {
    try {
      const failed = await syncTransaction(async (tx) => {
        const merchant = await lockShop(tx, shop);
        if (merchant?.status !== "ACTIVE" || merchant.generation !== generation)
          return false;
        const dead = attempts + 1 >= INVENTORY_MAX_ATTEMPTS;
        const delay = Math.min(300000, 5000 * 2 ** attempts);
        const jitter = randomInt(
          Math.floor(delay * 0.8),
          Math.floor(delay * 1.2) + 1
        );
        const result = await tx.inventoryChange.updateMany({
          where: {
            shop,
            inventoryItemId,
            revision,
            leaseToken: token,
            attempts,
            dirty: true,
            appliedRevision: { lt: revision },
          },
          data: {
            attempts: { increment: 1 },
            lastError: (original?.message || String(original)).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + Math.min(jitter, 300000)),
            deadLetterAt: dead ? new Date() : null,
            leaseToken: null,
            leasedUntil: null,
          },
        });
        return result.count === 1;
      });
      if (!failed) {
        await release(shop, inventoryItemId, token);
        return { status: "superseded" };
      }
    } catch (persistError) {
      throw new AggregateError(
        [original, persistError],
        "Inventory reconciliation and retry persistence failed"
      );
    }
    throw original;
  }
}
