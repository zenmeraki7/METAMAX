/**
 * METAMAX — Product Catalog Express Routes
 *
 * Exposes /products, /status, and /count over authenticated HTTP sessions,
 * using the shared catalogQueryService without ad-hoc SQL.
 */

import express from "express";
import { describeFilterFailure } from "../filters/errors.js";

export function createCatalogRouter({
  catalogQueryService = null,
  authentication = null,
  logger = console,
} = {}) {
  if (typeof authentication?.authenticate !== "function") {
    throw new TypeError("Catalog authentication is required");
  }
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  const unavailable = (_req, res) =>
    res.status(503).json({
      error: "FILTER_COVERAGE_UNAVAILABLE",
      message: "Catalog query service is currently unavailable",
      retryable: true,
    });

  // GET /products: Paginated catalog with projections and counts
  router.get(
    "/products",
    catalogQueryService
      ? async (req, res, next) => {
          try {
            const authContext = await authentication.authenticate(req);
            if (!authContext) {
              return res.status(401).json({ error: "UNAUTHENTICATED" });
            }
            const payload = await catalogQueryService.queryProducts({
              authContext,
              params: req.query,
            });
            return res.json(payload);
          } catch (error) {
            const failure = describeFilterFailure(error);
            logger.error?.(
              { code: failure.code, cause: error },
              "Catalog products query failed",
            );
            if (res.headersSent) return next(error);
            return res.status(failure.status).json({
              error: failure.code,
              message: failure.message,
              retryable: failure.retryable,
            });
          }
        }
      : unavailable,
  );

  // GET /status: Sync and generation publication status
  router.get(
    "/status",
    catalogQueryService
      ? async (req, res, next) => {
          try {
            const authContext = await authentication.authenticate(req);
            if (!authContext) {
              return res.status(401).json({ error: "UNAUTHENTICATED" });
            }
            const payload = await catalogQueryService.queryStatus({
              authContext,
            });
            return res.json(payload);
          } catch (error) {
            const failure = describeFilterFailure(error);
            logger.error?.(
              { code: failure.code, cause: error },
              "Catalog status query failed",
            );
            if (res.headersSent) return next(error);
            return res.status(failure.status).json({
              error: failure.code,
              message: failure.message,
              retryable: failure.retryable,
            });
          }
        }
      : unavailable,
  );

  // GET /count: Filtered product count
  router.get(
    "/count",
    catalogQueryService
      ? async (req, res, next) => {
          try {
            const authContext = await authentication.authenticate(req);
            if (!authContext) {
              return res.status(401).json({ error: "UNAUTHENTICATED" });
            }
            const payload = await catalogQueryService.queryCount({
              authContext,
              params: req.query,
            });
            return res.json(payload);
          } catch (error) {
            const failure = describeFilterFailure(error);
            logger.error?.(
              { code: failure.code, cause: error },
              "Catalog count query failed",
            );
            if (res.headersSent) return next(error);
            return res.status(failure.status).json({
              error: failure.code,
              message: failure.message,
              retryable: failure.retryable,
            });
          }
        }
      : unavailable,
  );

  router.get('/capabilities',async(req,res,next)=>{
    try {
      const authContext=await authentication.authenticate(req);
      if(!authContext)return res.status(401).json({error:'UNAUTHENTICATED'});
      if(Object.keys(req.query).length)return res.status(400).json({error:'INVALID_CAPABILITY_QUERY'});
      if(!catalogQueryService?.queryCapabilities)return unavailable(req,res);
      return res.json(await catalogQueryService.queryCapabilities({authContext}));
    } catch(error) {
      if(res.headersSent)return next(error);
      const failure=describeFilterFailure(error);
      return res.status(failure.status).json({error:failure.code,retryable:failure.retryable});
    }
  });
  return router;
}
