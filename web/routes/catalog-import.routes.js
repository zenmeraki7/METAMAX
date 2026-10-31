import express from "express";
import { FieldError, FIELD_ERROR_CODES } from "../fields/types.js";
import { CatalogImportError, IMPORT_ERROR_CODES as C, describeImportFailure } from "../services/catalog-import-errors.server.js";
import { isCatalogImportId } from "../services/catalog-import-id.server.js";

export function createCatalogImportRouter({ service, authentication } = {}) {
  const hasSessionAuth = typeof authentication?.authenticateSession === "function"; const hasContextAuth = typeof authentication?.authenticate === "function" && typeof authentication?.resolveSession === "function"; if (!hasSessionAuth && !hasContextAuth) {
    throw new TypeError("Catalog import authentication is required");
  }
  const router = express.Router();
  const sessions = new WeakMap();
  const fail = (res, error) => {
    const failure = describeImportFailure(error);
    return res.status(failure.status).json({ error: failure.error });
  };
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  router.use(async (req, res, next) => {
    try {
      const session = hasSessionAuth ? await authentication.authenticateSession(req) : await (async () => { const ctx = await authentication.authenticate(req); return ctx ? authentication.resolveSession(ctx) : null; })();
      if (!session) return res.status(401).json({ error: "UNAUTHENTICATED" });
      sessions.set(req, session);
    } catch (error) {
      return fail(res, error instanceof FieldError && error.code === FIELD_ERROR_CODES.PERMISSION_DENIED
        ? new CatalogImportError(C.UNAUTHENTICATED, { cause: error }) : error);
    }
    return next();
  });
  router.use((req, res, next) => {
    const hasBody = req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
    if (hasBody && !req.is("application/json")) {
      return fail(res, new CatalogImportError(C.UNSUPPORTED_MEDIA_TYPE));
    }
    next();
  });
  // Schema: optional body, or { type: "object", additionalProperties: false }.
  // No import options are supported. Add named, validated properties here
  // together with service support when introducing options.
  router.use(express.json({ limit: "4kb", strict: true, inflate: false }));
  const handle = action => async (req, res) => {
    const session = sessions.get(req);
    if ((req.params.id !== undefined && !isCatalogImportId(req.params.id)) ||
        (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))) {
      return res.status(400).json({ error: "INVALID_IMPORT_REQUEST" });
    }
    if (!service) return res.status(503).json({ error: "CATALOG_IMPORT_UNAVAILABLE" });
    try {
      const result = action === "enqueue" ? await service.enqueue(session) : await service[action](session, req.params.id);
      switch (action) {
        case "current":
          // No current import is a successful lookup with an explicit null.
          return res.status(200).json({ data: result ?? null });
        case "enqueue":
          if (result == null) return fail(res, new CatalogImportError(C.INTERNAL));
          return res.status(202).json({ data: result });
        case "status":
        case "cancel":
          if (result == null) return fail(res, new CatalogImportError(C.NOT_FOUND));
          return res.status(200).json({ data: result });
      }
    } catch (error) {
      return fail(res, error);
    }
  };
  router.post("/", handle("enqueue"));
  router.get("/", handle("current"));
  router.get("/:id", handle("status"));
  router.post("/:id/cancel", handle("cancel"));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large") return fail(res, new CatalogImportError(C.BODY_TOO_LARGE));
    if (["encoding.unsupported", "charset.unsupported"].includes(error.type)) {
      return fail(res, new CatalogImportError(C.UNSUPPORTED_MEDIA_TYPE));
    }
    if (["entity.parse.failed", "request.aborted", "request.size.invalid"].includes(error.type)) {
      return fail(res, new CatalogImportError(C.INVALID_REQUEST));
    }
    return fail(res, error);
  });
  return router;
}
