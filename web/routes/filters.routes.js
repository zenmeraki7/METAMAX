import express from "express";
import { requireVerifiedShopifySession } from "../middleware/shopify-auth.js";

export function createFiltersRouter({ runtime } = {}) {
  if (runtime && (typeof runtime.capture !== "function" || typeof runtime.search !== "function")) {
    throw new TypeError("Bootstrapped filter HTTP runtime required");
  }
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  // Fail closed even if mounted before, or without, Shopify authentication.
  router.use(requireVerifiedShopifySession);
  router.post("/search", express.json({ limit: "128kb" }),
    runtime?.capture ?? ((_req, _res, next) => next()),
    runtime?.search ?? ((_req, res) => res.status(503).json({ error: {
      code: "FILTER_COVERAGE_UNAVAILABLE", message: "Required filter data or services are unavailable", retryable: true,
    } })));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large" || error.type === "entity.parse.failed") {
      return res.status(error.type === "entity.too.large" ? 413 : 400).json({
        error: { code: "FILTER_INVALID_INPUT", message: "Invalid filter request", retryable: false },
      });
    }
    next(error);
  });
  return router;
}
