import express from "express";
import serveStatic from "serve-static";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWebhookHandlers } from "./privacy.js";
import productCreator from "./product-creator.js";
import { createShopifyAuthMiddleware } from "./middleware/shopify-auth.js";
import { createFilterAuthentication } from "./middleware/filter-auth.server.js";
import { createFiltersRouter } from "./routes/filters.routes.js";
import { createCatalogRouter } from "./routes/catalog.routes.js";
import { createCatalogImportRouter } from "./routes/catalog-import.routes.js";
import {createExportRouter} from "./routes/export.routes.js";
import {createExportControlRouter} from "./export/export-control.routes.js";
import { createHistoryRouter } from "./edit-history/history.routes.js";

export function createApp({ shopify, staticPath, filterRuntime = null, catalogImportService = null, exportRuntime = null, apiKey = process.env.SHOPIFY_API_KEY || "", development = process.env.NODE_ENV === "development", database = null, reconciliationService = null,historyPrivacyService=null }) {
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
        database,
        reconciliationService,
        historyPrivacyService,
      }),
    }),
  );
  // Both routers require the same opaque request authentication contract even
  // when the mirror query runtime is unavailable. Capture only after Shopify
  // has verified the request; res.locals alone is never route authority.
  const authentication = filterRuntime?.authentication ?? createFilterAuthentication({
    sessionStorage: shopify.config.sessionStorage,
  });
  const capture = filterRuntime?.capture ?? authentication.capture;
  app.use("/api", createShopifyAuthMiddleware({ shopify }));
  if(exportRuntime) {
    app.use("/api/exports",exportRuntime.authentication.capture,createExportRouter({authenticate:exportRuntime.authentication.authenticate,exportService:exportRuntime.service}));
    app.use("/api/exports",createExportControlRouter({...exportRuntime,database}));
  } else {
    app.use("/api/exports",(_req,res)=>res.status(503).json({error:"EXPORT_UNAVAILABLE"}));
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
  app.get("/api/shopify-data/sources", capture, async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      shopTimeZone: "UTC",
      sources: [
        { id: "products", name: "Products & Variants", icon: "bag", syncType: "automatic", status: "healthy", lastFullSyncAt: new Date().toISOString() },
        { id: "collections", name: "Collections", icon: "layers", syncType: "automatic", status: "healthy", lastFullSyncAt: new Date().toISOString() },
        { id: "inventory", name: "Inventory Levels", icon: "box", syncType: "automatic", status: "healthy", lastFullSyncAt: new Date().toISOString() },
        { id: "metafields", name: "Metafield Definitions", icon: "receipt", syncType: "automatic", status: "healthy", lastFullSyncAt: new Date().toISOString() },
      ],
    });
  });
  app.post("/api/shopify-data/refresh", capture, async (req, res, next) => {
    try {
      const session = res.locals.shopify?.session;
      if (!session) return res.status(401).json({ error: "UNAUTHENTICATED" });
      const job = await catalogImportService?.enqueue(session);
      return res.status(202).json({ jobId: job?.id || "sync-queued" });
    } catch (err) { next(err); }
  });
  app.post("/api/products", async (_req, res) => {
    try {
      await productCreator(shopify, res.locals.shopify.session);
      res.status(200).json({ success: true, error: null });
    } catch (error) {
      console.error("[app] Failed to create sample products:", error.name || "Error");
      res.status(500).json({ success: false, error: "Failed to create sample products" });
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
