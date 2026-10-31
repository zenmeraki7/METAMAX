import express from "express";
import {
  EXPORT_LIMITS,
  EXPORT_ERROR_CODES,
  normalizeIdempotencyKey,
  ExportContractError,
} from "../export/export-contract.js";

function extractAuthenticatedShopKey(authContext) {
  if (!authContext || typeof authContext !== "object") {
    return null;
  }

  const candidate =
    authContext.shopId ??
    authContext.shop?.id ??
    (typeof authContext.shop === "string"
      ? authContext.shop
      : null);

  if (
    typeof candidate !== "string" ||
    candidate.trim() === ""
  ) {
    return null;
  }

  return candidate;
}

export function createExportRouter({
  authenticate,
  exportService,
  rateLimiter,
} = {}) {
  if (
    typeof authenticate !== "function" ||
    typeof exportService?.create !== "function"
  ) {
    throw new TypeError(
      "Authenticated Export Service required",
    );
  }

  if (
    rateLimiter !== undefined &&
    typeof rateLimiter?.consume !== "function"
  ) {
    throw new TypeError(
      "rateLimiter.consume() must be a function when provided",
    );
  }

  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post(
    "/",
    express.json({
      limit: `${EXPORT_LIMITS.MAX_REQUEST_BYTES}b`,
      strict: true,
      type: "application/json",
    }),
    async (req, res, next) => {
      try {
        const authContext = await authenticate(req, res);

        if (!authContext) {
          return res.status(401).json({
            error: {
              code: "EXPORT_UNAUTHENTICATED",
              message: "Authentication required",
              retryable: false,
            },
          });
        }

        // Rate limit strictly by server-authenticated shop identity,
        // NEVER by an untrusted client header such as X-Shop-Domain.
        if (rateLimiter) {
          const shopKey = extractAuthenticatedShopKey(authContext);
          if (!shopKey) {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.UNAUTHORIZED,
              "Authenticated shop identity required for rate limiting",
            );
          }

          const allowed = await rateLimiter.consume({
            shopId: shopKey,
            operation: "export",
          });

          if (!allowed) {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.RATE_LIMITED,
              "Export rate limit exceeded",
              { retryable: true },
            );
          }
        }

        const idempotencyKey = normalizeIdempotencyKey(
          req.get("Idempotency-Key"),
        );

        const result = await exportService.create({
          authContext,
          input: req.body,
          idempotencyKey,
        });

        return res.status(result.created ? 202 : 200).json({
          data: result.job,
        });
      } catch (error) {
        if (error instanceof ExportContractError) {
          return res
            .status(error.status)
            .json(error.toJSON());
        }

        return next(error);
      }
    },
  );

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);

    if (
      error.type === "entity.too.large" ||
      error.type === "entity.parse.failed"
    ) {
      return res
        .status(
          error.type === "entity.too.large" ? 413 : 400,
        )
        .json({
          error: {
            code: "EXPORT_INVALID_REQUEST",
            message: "Invalid export request body",
            retryable: false,
          },
        });
    }

    return next(error);
  });

  return router;
}

