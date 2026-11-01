import express from "express";
import { createSyncSourcesService } from './services/sync-sources.server.js';
import { createTenantSourcesRepository } from './security/repositories/sync-sources.server.js';
import { TenantSecurityError } from './security/tenant.server.js';
import { TenantDatabaseError } from './security/tenant-db.server.js';
import { describeFilterFailure } from './filters/errors.js';
import serveStatic from "serve-static";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWebhookHandlers } from "./privacy.js";
import productCreator from "./product-creator.js";
import { createShopifyAuthMiddleware, createInstallationGuard } from "./middleware/shopify-auth.js";
import { createDatabaseInstallationResolver } from "./security/installation-lifecycle.server.js";
import { createFilterAuthentication } from "./middleware/filter-auth.server.js";
import { createFiltersRouter } from "./routes/filters.routes.js";
import { createCatalogRouter } from "./routes/catalog.routes.js";
import { createCatalogImportRouter } from "./routes/catalog-import.routes.js";
import { createExportRouter } from "./routes/export.routes.js";
import { createExportControlRouter } from "./export/export-control.routes.js";
import { createHistoryRouter } from "./edit-history/history.routes.js";
import {hasCurrentProductWrite} from './middleware/product-permission.server.js';

export function createApp({ shopify, staticPath, filterRuntime = null, catalogImportService = null, exportRuntime = null, apiKey = process.env.SHOPIFY_API_KEY || "", development = process.env.NODE_ENV === "development", database = null, lifecycleDatabase = null, installationDatabase = database, tenantReadPool = null, reconciliationService = null, historyPrivacyService = null }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(shopify.cspHeaders());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get(shopify.config.auth.path, shopify.auth.begin());
  app.get(shopify.config.auth.callbackPath, shopify.auth.callback(), async (_req, res, next) => {
    if (!catalogImportService) return res.status(503).json({ error: "CATALOG_IMPORT_UNAVAILABLE", retryable: true });
    try {
      // The official callback has verified OAuth and persisted the session.
      // Commit scheduling before redirecting; Shopify work runs in the worker.
      await catalogImportService.onInstall(res.locals.shopify?.session);
      next();
    } catch (error) { next(error); }
  }, shopify.redirectToShopifyOrAppRoot());
  // Must precede JSON parsing: Shopify verifies webhook signatures over raw bytes.
  app.post(
    shopify.config.webhooks.path,
    shopify.processWebhooks({
      webhookHandlers: createWebhookHandlers(shopify.config.sessionStorage, {
        database:lifecycleDatabase,
        reconciliationService,
        historyPrivacyService,
      }),
    }),
  );
  // No nested webhook URL may fall through to merchant session authentication.
  app.use(shopify.config.webhooks.path,(_req,res)=>res.status(404).json({error:'WEBHOOK_ROUTE_NOT_FOUND'}));
  // Both routers require the same opaque request authentication contract even
  // when the mirror query runtime is unavailable. Capture only after Shopify
  // has verified the request; res.locals alone is never route authority.
  const resolveInstallation = installationDatabase?.connect
    ? createDatabaseInstallationResolver({ database: installationDatabase })
    : null;
  const authentication = filterRuntime?.authentication ?? createFilterAuthentication({
    sessionStorage: shopify.config.sessionStorage,
    resolveInstallation,
  });
  const capture = filterRuntime?.capture ?? authentication.capture;
  app.use("/api", createShopifyAuthMiddleware({ shopify }));
  app.use("/api", createInstallationGuard({ database: installationDatabase, sessionStorage: shopify.config.sessionStorage }));
  if (exportRuntime) {
    app.use("/api/exports", exportRuntime.authentication.capture, createExportRouter({ authenticate: exportRuntime.authentication.authenticate, exportService: exportRuntime.service }));
    app.use("/api/exports", createExportControlRouter({ ...exportRuntime, database }));
  } else {
    app.use("/api/exports", (_req, res) => res.status(503).json({ error: "EXPORT_UNAVAILABLE" }));
  }
  app.use("/api/filters", createFiltersRouter({ runtime: filterRuntime }));
  app.use(
    "/api/catalog",
    capture,
    createCatalogRouter({
      catalogQueryService: filterRuntime?.catalogQuery,
      authentication,
    }),
  );
  app.use("/api/mirror/sync", capture, createCatalogImportRouter({ service: catalogImportService, authentication }));
  app.use("/api/history", capture, createHistoryRouter({ database, authentication }));
  app.use("/api", express.json({ limit: "1mb" }));
  const unavailable = (_req, res) => res.status(503).json({ error: "FILTER_COVERAGE_UNAVAILABLE", retryable: true });
  app.get("/api/mirror/products", capture, filterRuntime?.catalog ?? unavailable);
  app.get("/api/mirror/status", async (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    // App opening can repair an interrupted first-install scheduling commit.
    try { await catalogImportService?.ensureInitialSync(res.locals.shopify?.session); next(); }
    catch (error) { next(error); }
  }, capture, filterRuntime?.catalogStatus ?? unavailable);
  app.get("/api/products/count", capture, filterRuntime?.catalogCount ?? unavailable);
  app.get("/api/mirror/count", capture, filterRuntime?.catalogCount ?? unavailable);
  const syncSources = tenantReadPool ? createSyncSourcesService({ repository: createTenantSourcesRepository({ pool: tenantReadPool, authentication }), authentication }) : null;
  app.get("/api/shopify-data/sources", capture, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const authContext = await authentication.authenticate(req);
      if (!authContext) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      if (Object.keys(req.query).length) return res.status(400).json({ error: 'INVALID_SOURCE_QUERY' });
      if (!syncSources) return res.status(503).json({ error: 'SOURCES_UNAVAILABLE' });
      return res.json(await syncSources.read({ authContext }));
    } catch (error) {
      if (error instanceof TenantSecurityError && [401, 403].includes(error.status) || error instanceof TenantDatabaseError && ['INSTALLATION_NOT_ACTIVE', 'WORKER_CLAIM_REVOKED'].includes(error.code))
        return res.status(403).json({ error: 'FILTER_PERMISSION_DENIED', retryable: false });
      const failure = describeFilterFailure(error); return res.status(failure.status === 500 ? 503 : failure.status).json({ error: failure.status === 500 ? 'SOURCES_UNAVAILABLE' : failure.code, retryable: failure.status === 500 || failure.retryable });
    }
  });
  app.post("/api/products", capture, async (req, res) => {
    try {
      const session=await authentication.authenticateSession(req);
      if(!session)return res.status(401).json({error:'UNAUTHENTICATED'});
      if(!hasCurrentProductWrite(session))return res.status(403).json({error:'PRODUCT_WRITE_PERMISSION_DENIED'});
      if(!catalogImportService?.withEditingLock)return res.status(503).json({success:false,error:'CATALOG_EDITING_LOCKED'});
      await catalogImportService.withEditingLock(session,()=>productCreator(shopify, session));
      res.status(200).json({ success: true, error: null });
    } catch (error) {
      console.error("[app] Failed to create sample products:", error.name || "Error");
      const status=error.code==='UNAUTHENTICATED'?401:error.code==='IMPORT_PERMISSION_DENIED'?403:error.code==='CATALOG_IMPORT_UNAVAILABLE'?503:500;
      res.status(status).json({success:false,error:status===503?'CATALOG_EDITING_LOCKED':status===401?'UNAUTHENTICATED':status===403?'PRODUCT_WRITE_PERMISSION_DENIED':'Failed to create sample products'});
    }
  });
  // Removed engine APIs must never receive an HTML SPA response or fake records.
  app.use("/api", (_req, res) => res.status(404).json({ error: "API_NOT_IMPLEMENTED", message: "This endpoint is not part of the Shopify Express template." }));
  app.use(serveStatic(staticPath, { index: false }));
  app.get("*", shopify.ensureInstalledOnShop(), (_req, res, next) => {
    try {
      let html = readFileSync(join(staticPath, "index.html"), "utf8");
      if (development) {
        // Express serves this HTML without Vite's transformIndexHtml hook.
        // Static imports guarantee React Refresh initializes before React modules.
        html = html.replace(
          '<script type="module" src="/main.jsx"></script>',
          '<script type="module">import "/dev_embed.js"; import "/main.jsx";</script>',
        );
      }
      const escapedKey = apiKey.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
      res.type("html").send(html.replaceAll("%VITE_SHOPIFY_API_KEY%", escapedKey));
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "INVALID_JSON" });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
    }
    console.error("[app] Request failed:", error.name || "Error");
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  });
  return app;
}
