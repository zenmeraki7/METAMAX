import { Router, raw } from "express";
import { createHash } from "node:crypto";
import { verifyHmac } from "../webhooks/webhooks.routes.js";
import { processLifecycle } from "./lifecycle.repository.js";

const topics = new Set([
  "app/uninstalled",
  "shop/redact",
  "customers/redact",
  "customers/data_request",
]);
export function createLifecycleRouter({
  process: handle = processLifecycle,
} = {}) {
  const router = Router();
  router.post(
    "/",
    raw({ type: "application/json", limit: "1mb", inflate: false }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
      if (!process.env.SHOPIFY_API_SECRET) return res.sendStatus(503);
      if (!verifyHmac(req.body, req.get("x-shopify-hmac-sha256")))
        return res.sendStatus(401);
      const shop = req.get("x-shopify-shop-domain")?.trim().toLowerCase();
      const topic = req.get("x-shopify-topic");
      const deliveryId = req.get("x-shopify-webhook-id");
      const timestamp = req.get("x-shopify-triggered-at");
      const triggeredAt = new Date(timestamp);
      if (
        !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "") ||
        !topics.has(topic) ||
        !/^[\x21-\x7e]{1,255}$/.test(deliveryId || "") ||
        !timestamp ||
        !Number.isFinite(triggeredAt.getTime())
      )
        return res.sendStatus(400);
      try {
        const payload = JSON.parse(req.body.toString("utf8"));
        if (!payload || Array.isArray(payload) || typeof payload !== "object")
          return res.sendStatus(400);
      } catch {
        return res.sendStatus(400);
      }
      try {
        await handle({
          id: deliveryId,
          shop,
          topic,
          triggeredAt,
          payloadHash: createHash("sha256").update(req.body).digest("hex"),
        });
        return res.sendStatus(200);
      } catch (error) {
        console.error(
          "[lifecycle] Processing failed",
          error.code || error.name
        );
        return res.sendStatus(error.statusCode === 409 ? 409 : 503);
      }
    }
  );
  router.use((error, _req, res, next) => {
    if (error.type === "entity.too.large") return res.sendStatus(413);
    if ([400, 415].includes(error.status)) return res.sendStatus(error.status);
    return next(error);
  });
  return router;
}
export default createLifecycleRouter();
