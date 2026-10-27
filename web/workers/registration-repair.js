import { prisma } from "../db/client.js";
import {
  registerShopInTransaction,
  shopHash,
} from "../domains/lifecycle/lifecycle.repository.js";

export async function repairShopRegistrations({
  db = prisma,
  batchSize = 100,
} = {}) {
  let cursor = "",
    repaired = 0;
  while (true) {
    const rows = await db.$queryRaw`
      SELECT s."shop" FROM "shopify_sessions" s
      LEFT JOIN "Shop" t ON t."domain"=s."shop"
      LEFT JOIN "CatalogSyncState" c ON c."shop"=s."shop"
      WHERE s."id"='offline_' || s."shop" AND NOT s."isOnline"
        AND s."accessToken" IS NOT NULL AND s."accessToken" <> ''
        AND (s."expires" IS NULL OR s."expires">EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))
        AND s."shop">${cursor}
        AND (t."domain" IS NULL OR (t."status"='ACTIVE' AND
          (c."shop" IS NULL OR (c."status"='NOT_STARTED' AND t."activeRunId" IS NULL AND t."activeSnapshotId" IS NULL))))
      ORDER BY s."shop" LIMIT ${batchSize}
    `;
    for (const { shop } of rows) {
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) continue;
      const result = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${shop}, 0))`;
          // Reread after the lifecycle lock; uninstall might have removed the
          // session while the scanner was waiting. Never resurrect terminal shops.
          const sessions =
            await tx.$queryRaw`SELECT "id" FROM "shopify_sessions" WHERE "id"=${`offline_${shop}`}
          AND "shop"=${shop} AND NOT "isOnline" AND "accessToken" IS NOT NULL AND "accessToken"<>''
          AND ("expires" IS NULL OR "expires">EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))`;
          if (!sessions.length) return null;
          return registerShopInTransaction(tx, shop, { recovery: true });
        },
        { maxWait: 1000, timeout: 4000 }
      );
      if (result) {
        repaired++;
        console.warn("[installation] Registration repaired", {
          shopHash: shopHash(shop),
          code: "SHOP_REGISTRATION_REPAIRED",
        });
      }
    }
    if (rows.length < batchSize) return repaired;
    cursor = rows.at(-1).shop;
  }
}
