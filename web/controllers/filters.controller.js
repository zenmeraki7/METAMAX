/**
 * METAMAX — Filter HTTP Controller
 *
 * controllers/filters.controller.js
 */

import { describeFilterFailure } from "../filters/errors.js";
import { normalizePageSize } from "../filters/execute.js";

const MAX_BODY_BYTES = 128 * 1024;

export function createFiltersController({
  authenticate,
  compiler,
  executor,
  resolveDatasets,
  logger = console,
}) {
  if (
    typeof authenticate !== "function" ||
    typeof compiler?.validateFilter !== "function" ||
    typeof compiler?.compileFilter !== "function" ||
    typeof executor?.execute !== "function" ||
    typeof resolveDatasets !== "function"
  ) {
    throw new TypeError("Trusted filter controller dependencies required");
  }

  async function search(req, res, next) {
    res.setHeader("Cache-Control", "private, no-store");

    try {
      const authContext = await authenticate(req);
      if (!authContext) {
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      }

      const body = req.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !["filter", "pageSize", "cursor"].includes(key),
        )
      ) {
        return res.status(400).json({
          error: {
            code: "FILTER_INVALID_INPUT",
            message: "Invalid filter request",
          },
        });
      }

      if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
        return res.status(413).json({
          error: {
            code: "FILTER_INVALID_INPUT",
            message: "Filter request too large",
          },
        });
      }

      const pageSize = normalizePageSize(
        body.pageSize === undefined ? undefined : body.pageSize,
      );
      if (
        body.cursor !== undefined &&
        (typeof body.cursor !== "string" ||
          !body.cursor ||
          body.cursor.length > 4096)
      ) {
        return res.status(400).json({
          error: {
            code: "FILTER_INVALID_INPUT",
            message: "Invalid pagination cursor",
          },
        });
      }

      // Preparation resolves only the current published execution context.
      // The executor obtains required datasets from the issuing compiler plan.
      const context = await resolveDatasets({
        authContext,
        filter: body.filter,
        ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
      });
      const validated = await compiler.validateFilter(body.filter, {
        authContext,
        operation: "filter",
        executionContext: context.executionContext,
      });
      const query = await compiler.compileFilter(validated, {
        authContext,
        pageSize,
        ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
      });
      const result = await executor.execute({ query, authContext });
      return res.status(200).json({ data: result });
    } catch (error) {
      const failure = describeFilterFailure(error);
      logger.error?.(
        { code: failure.code, cause: error },
        "Filter request failed",
      );
      if (res.headersSent) return next(error);
      return res.status(failure.status).json({
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      });
    }
  }

  return Object.freeze({ search });
}
