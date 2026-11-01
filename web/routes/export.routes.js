import express from "express";
import {
  EXPORT_LIMITS,
  normalizeIdempotencyKey,
  ExportContractError,
} from "../export/export-contract.js";

/** HTTP export admission: authenticate, bound/parse JSON and normalize the
 * idempotency key; delegate durable creation/replay and return its receipt.
 * The production Export Service owns current authorization, persistent replay
 * lookup and the single new-admission limiter. A route limiter is forbidden
 * because it could charge or reject a replay before durable lookup.
 */
export function createExportRouter({
  authenticate,
  exportService,
  ...unsupported
} = {}) {
  if (
    typeof authenticate !== "function" ||
    typeof exportService?.create !== "function"
  ) {
    throw new TypeError(
      "Authenticated Export Service required",
    );
  }

  if (Object.hasOwn(unsupported, 'rateLimiter')) {
    throw new TypeError('Configure export admission rateLimiter on the Export Service, not the HTTP router');
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

