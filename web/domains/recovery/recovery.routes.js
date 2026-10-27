import { Router } from "express";
import { prisma } from "../../db/client.js";
import { enqueueProductChange } from "../../queues/reconcile.queue.js";
import { enqueueInventoryChange } from "../../queues/inventory.queue.js";
import { shopHash } from "../lifecycle/lifecycle.repository.js";

// Mounted only after Shopify session validation. Shop identity never comes from
// a caller-supplied domain or query parameter.
export function createRecoveryRouter({
  db = prisma,
  resource = "product",
  enqueue = resource === "inventory"
    ? enqueueInventoryChange
    : enqueueProductChange,
} = {}) {
  const router = Router();
  const inventory = resource === "inventory";
  const idField = inventory ? "inventoryItemId" : "productId";
  const ledger = inventory ? db.inventoryChange : db.catalogChange;
  router.get("/dead-letters", async (_req, res, next) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const rows = await ledger.findMany({
        where: { shop, deadLetterAt: { not: null } },
        orderBy: [{ deadLetterAt: "asc" }, { [idField]: "asc" }],
        take: 100,
        select: {
          [idField]: true,
          revision: true,
          attempts: true,
          lastError: true,
          deadLetterAt: true,
        },
      });
      res.json({
        changes: rows.map((row) => ({
          ...row,
          revision: row.revision.toString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get("/privacy-requests", async (_req, res, next) => {
    try {
      const rows = await db.lifecycleReceipt.findMany({
        where: {
          shopHash: shopHash(res.locals.shopify.session.shop),
          topic: { in: ["customers/data_request", "customers/redact"] },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, topic: true, outcome: true, createdAt: true },
      });
      res.json({ requests: rows });
    } catch (error) {
      next(error);
    }
  });
  const retry = async (req, res, next) => {
    const shop = res.locals.shopify.session.shop;
    const productId = req.body?.[idField];
    const revision = req.body?.revision;
    if (
      typeof productId !== "string" ||
      !(
        inventory
          ? /^gid:\/\/shopify\/InventoryItem\/[1-9]\d{0,39}$/
          : /^gid:\/\/shopify\/Product\/[1-9]\d{0,39}$/
      ).test(productId) ||
      typeof revision !== "string" ||
      !/^[1-9]\d{0,18}$/.test(revision) ||
      BigInt(revision) > 9223372036854775807n
    )
      return res.sendStatus(400);
    try {
      const changed = await ledger.updateMany({
        where: {
          shop,
          [idField]: productId,
          revision: BigInt(revision),
          deadLetterAt: { not: null },
          merchant: { status: "ACTIVE" },
          OR: [
            { manualRetryAt: null },
            { manualRetryAt: { lte: new Date(Date.now() - 60000) } },
          ],
        },
        data: {
          attempts: 0,
          deadLetterAt: null,
          lastError: null,
          nextAttemptAt: new Date(),
          manualRetryAt: new Date(),
        },
      });
      if (changed.count !== 1)
        return res.status(409).json({
          error:
            "Change was superseded, already retried, or is cooling down. Refresh the list.",
        });
      // Committed eligibility is sufficient: the scanner recovers an unavailable queue.
      void enqueue(shop, productId, revision).catch((error) =>
        console.error("[recovery] Queue unavailable:", error.message)
      );
      return res
        .status(202)
        .json({ status: "scheduled", source: "authoritative-shopify-read" });
    } catch (error) {
      next(error);
    }
  };
  router.post("/retry", retry);
  // Manual repair always re-reads Shopify; it never accepts client-provided
  // product JSON or clears a dirty revision without a successful mirror write.
  router.post("/repair", retry);
  return router;
}
export default createRecoveryRouter();
