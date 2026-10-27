import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../db/client.js";
import { reserveCatalogSync } from "../sync/sync.request.js";

export const shopHash = (shop) =>
  createHash("sha256").update(shop).digest("hex");

export async function registerShopInTransaction(
  tx,
  shop,
  { recovery = false } = {}
) {
  const existing = await tx.shop.findUnique({ where: { domain: shop } });
  const marker = await tx.installationState.findUnique({
    where: { shopHash: shopHash(shop) },
  });
  if (
    recovery &&
    (existing?.status === "UNINSTALLED" ||
      ["UNINSTALLED", "REDACTED"].includes(marker?.status))
  )
    return null;
  const active = existing?.status === "ACTIVE";
  const generation = active
    ? existing.generation
    : recovery && marker?.status === "ACTIVE"
    ? marker.generation
    : randomUUID();
  const installedAt = active
    ? existing.installedAt
    : recovery && marker?.authenticatedAt
    ? marker.authenticatedAt
    : new Date();
  const merchant = await tx.shop.upsert({
    where: { domain: shop },
    create: {
      domain: shop,
      generation,
      installedAt,
      installationVerified: true,
    },
    update: active
      ? { installationVerified: true }
      : {
          status: "ACTIVE",
          installedAt,
          generation,
          installationVerified: true,
        },
  });
  // Never reset an existing sync's progress or replace its active generation.
  await tx.catalogSyncState.upsert({
    where: { shop },
    create: { shop, generation },
    update: {},
  });
  await tx.catalogSyncState.updateMany({
    where: { shop, generation: { not: generation } },
    data: { generation, status: "NOT_STARTED" },
  });
  await tx.installationState.upsert({
    where: { shopHash: shopHash(shop) },
    create: {
      shopHash: shopHash(shop),
      status: "ACTIVE",
      generation,
      authenticatedAt: installedAt,
    },
    update: { status: "ACTIVE", generation, authenticatedAt: installedAt },
  });
  await tx.catalogRepair.createMany({
    data: ["PRODUCT", "VARIANT", "INVENTORY_ITEM", "INVENTORY_LEVEL", "FULL"].map(
      (kind) => ({ shop, kind })
    ),
    skipDuplicates: true,
  });
  await tx.initialSyncRequest.upsert({
    where: { shop_generation: { shop, generation } },
    create: { shop, generation, snapshotId: merchant.activeRunId },
    update: {},
  });
  // The offline session and initial job commit together. A scanner delivers it
  // even when Redis is unavailable during installation.
  const sync = await tx.catalogSyncState.findUnique({ where: { shop } });
  if (!merchant.activeSnapshotId && !merchant.activeRunId && sync.status === "NOT_STARTED") {
    const run = await reserveCatalogSync(tx, merchant);
    return { ...merchant, activeRunId: run.id };
  }
  return merchant;
}

export async function registerShop(shop) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${shop}, 0))`;
    return registerShopInTransaction(tx, shop);
  });
}

export async function processLifecycle({
  id,
  shop,
  topic,
  payloadHash,
  triggeredAt,
}) {
  return prisma.$transaction(
    async (tx) => {
      // Same lock order as auth and tenant cleanup; receipt dedup also survives deletion.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${shop}, 0))`;
      const prior = await tx.lifecycleReceipt.findUnique({ where: { id } });
      if (prior) {
        if (
          prior.shopHash !== shopHash(shop) ||
          prior.topic !== topic ||
          prior.payloadHash !== payloadHash
        ) {
          const error = new Error("Lifecycle receipt ID collision");
          error.statusCode = 409;
          throw error;
        }
        return prior.outcome;
      }
      const rows =
        await tx.$queryRaw`SELECT "status", "installedAt", "installationVerified" FROM "Shop" WHERE "domain" = ${shop} FOR UPDATE`;
      const merchant = rows[0];
      const installation = await tx.installationState.findUnique({
        where: { shopHash: shopHash(shop) },
      });
      let outcome;
      if (topic === "app/uninstalled") {
        if (
          (!merchant ||
            !merchant.installationVerified ||
            triggeredAt >= merchant.installedAt) &&
          !(
            installation?.status === "ACTIVE" &&
            installation.authenticatedAt &&
            triggeredAt < installation.authenticatedAt
          )
        ) {
          // Rotate the generation while holding the publication barrier. An older
          // in-flight worker can never acknowledge a new installation's revision.
          const generation = randomUUID();
          await tx.shop.updateMany({
            where: { domain: shop },
            data: {
              status: "UNINSTALLED",
              activeRunId: null,
              activeSnapshotId: null,
              generation,
            },
          });
          await tx.snapshotRetentionPin.deleteMany({ where: { shop } });
          await tx.snapshotRun.deleteMany({ where: { shop } });
          await tx.catalogSyncState.deleteMany({ where: { shop } });
          await tx.productMirror.deleteMany({ where: { shop } });
          await tx.catalogChange.deleteMany({ where: { shop } });
          await tx.inventoryChange.deleteMany({ where: { shop } });
          await tx.webhookEvent.deleteMany({ where: { shop } });
          await tx.catalogRepair.deleteMany({ where: { shop } });
          await tx.initialSyncRequest.updateMany({
            where: { shop, status: { in: ["PENDING", "RUNNING"] } },
            data: { status: "CANCELLED", completedAt: new Date(), leaseToken: null, leasedUntil: null },
          });
          await tx.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop" = ${shop}`;
          await tx.installationState.upsert({
            where: { shopHash: shopHash(shop) },
            create: {
              shopHash: shopHash(shop),
              status: "UNINSTALLED",
              generation,
            },
            update: { status: "UNINSTALLED", generation },
          });
          outcome = "SHOP_DATA_DELETED_WORKERS_FENCED";
        } else outcome = "STALE_OR_UNKNOWN_INSTALLATION";
      } else if (topic === "shop/redact") {
        // Uninstall already deleted all previous installation data. A new active
        // installation belongs to a separate lifecycle and must remain intact.
        const uninstallWindowStart = new Date(
          triggeredAt.getTime() - 48 * 60 * 60 * 1000
        );
        if (
          merchant?.status === "ACTIVE" &&
          merchant.installationVerified &&
          merchant.installedAt > uninstallWindowStart
        )
          outcome = "NEW_INSTALLATION_PRESERVED";
        else {
          await tx.catalogRepair.deleteMany({ where: { shop } });
          await tx.snapshotRetentionPin.deleteMany({ where: { shop } });
          await tx.bulkQueryClaim.deleteMany({ where: { shop } });
          await tx.shop.deleteMany({ where: { domain: shop } });
          await tx.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop" = ${shop}`;
          await tx.installationState.upsert({
            where: { shopHash: shopHash(shop) },
            create: {
              shopHash: shopHash(shop),
              status: "REDACTED",
              generation: randomUUID(),
            },
            update: { status: "REDACTED" },
          });
          outcome = "SHOP_REDACTED";
        }
      } else {
        // The catalog mirror stores product fields only; receipts store hashes,
        // never webhook payloads. No customer records are collected by this app.
        outcome =
          topic === "customers/data_request"
            ? "NO_CUSTOMER_DATA_STORED"
            : "NO_CUSTOMER_DATA_TO_REDACT";
      }
      await tx.lifecycleReceipt.create({
        data: { id, shopHash: shopHash(shop), topic, payloadHash, outcome },
      });
      return outcome;
    },
    { maxWait: 750, timeout: 3000 }
  );
}
