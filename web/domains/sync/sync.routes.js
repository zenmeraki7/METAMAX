import { Router } from "express";
import { prisma } from "../../db/client.js";
import { readProductCatalog } from "../products/products.catalog.js";

// Counts and pointer share a repeatable read snapshot. The canonical catalog is
// SnapshotProduct JSON; there are no relational Product/Variant tables here.
export async function readActiveCatalogCounts(shop, { db = prisma } = {}) {
  return db.$transaction(
    async (tx) => {
      const store = await tx.shop.findUnique({
        where: { domain: shop },
        select: { activeSnapshotId: true, status: true, generation: true },
      });
      if (!store || store.status !== "ACTIVE") return null;
      const state = await tx.catalogSyncState.findUnique({
        where: { shop },
        select: { status: true },
      });
      const snapshotId = store.activeSnapshotId;
      if (!snapshotId)
        return {
          snapshotId: null,
          syncStatus: state?.status || "NOT_STARTED",
          productCount: 0,
          variantCount: 0,
        };
      const published = await tx.snapshotRun.findUnique({
        where: { id: snapshotId },
        select: {
          completedAt: true,
          status: true,
          shop: true,
          generation: true,
        },
      });
      if (
        published?.status !== "COMPLETED" ||
        published.shop !== shop ||
        published.generation !== store.generation
      )
        return null;
      const [counts] = await tx.$queryRaw`SELECT COUNT(*)::bigint AS products,
      COALESCE(SUM(jsonb_array_length(CASE WHEN jsonb_typeof("data"->'variants')='array'
        THEN "data"->'variants' ELSE '[]'::jsonb END)),0)::bigint AS variants
      FROM "SnapshotProduct" WHERE "runId"=${snapshotId}`;
      return {
        snapshotId,
        syncStatus: state?.status || "READY",
        productCount: Number(counts.products),
        variantCount: Number(counts.variants),
        lastSyncedAt: published.completedAt,
      };
    },
    { isolationLevel: "RepeatableRead", maxWait: 2000, timeout: 10000 }
  );
}

export function createSyncRouter({ db = prisma } = {}) {
  const router = Router();
  router.get("/products", async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const shop = res.locals?.shopify?.session?.shop;
      if (typeof shop !== "string" || !shop)
        return res.status(401).json({ error: "AUTHENTICATED_SHOP_REQUIRED" });
      const catalog = await readProductCatalog(shop, req.query, { db });
      if (!catalog)
        return res.status(404).json({ error: "SHOP_NOT_REGISTERED" });
      return res.json(catalog);
    } catch (error) {
      if (error.status)
        return res.status(error.status).json({ error: error.code });
      next(error);
    }
  });
  const handler = async (_req, res, next) => {
    try {
      // Never derive tenant identity from a query parameter or webhook header.
      const shop = res.locals?.shopify?.session?.shop;
      if (typeof shop !== "string" || !shop)
        return res.status(401).json({ error: "AUTHENTICATED_SHOP_REQUIRED" });
      const counts = await readActiveCatalogCounts(shop, { db });
      if (!counts)
        return res.status(404).json({ error: "SHOP_NOT_REGISTERED" });
      return res.json({ shop, activeSnapshotId: counts.snapshotId, ...counts });
    } catch (error) {
      next(error);
    }
  };
  router.get("/status", handler);
  router.get("/mirror/status", handler);
  router.get("/api/mirror/status", handler);
  return router;
}
export default createSyncRouter();
