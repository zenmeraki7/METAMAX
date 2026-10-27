// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import catalogWebhooks from "./domains/webhooks/webhooks.routes.js";
import inventoryWebhooks from "./domains/inventory/inventory.routes.js";
import { prisma, connectDatabase, disconnectDatabase } from "./db/client.js";
import lifecycleRouter from "./domains/lifecycle/lifecycle.routes.js";
import recoveryRouter from "./domains/recovery/recovery.routes.js";
import { createRecoveryRouter } from "./domains/recovery/recovery.routes.js";
import syncRouter from "./domains/sync/sync.routes.js";

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

// Catalog webhooks must receive the original bytes, without embedded-app auth.
// Mount this specific route BEFORE the broader /api/webhooks lifecycle handler.
app.use("/api/webhooks/catalog", catalogWebhooks);
app.use("/api/webhooks/inventory", inventoryWebhooks);
app.use("/webhooks/lifecycle", lifecycleRouter);
// Preserve existing compliance and app lifecycle processing.
app.use("/api/webhooks", lifecycleRouter);

// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

app.use("/api", shopify.validateAuthenticatedSession());

app.use(express.json({ limit: "1mb" }));
app.use("/api/reconciliation", recoveryRouter);
app.use(
  "/api/reconciliation/inventory",
  createRecoveryRouter({ resource: "inventory" })
);
app.use("/api/mirror", syncRouter);

app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });

  const countData = await client.request(`
    query shopifyProductCount {
      productsCount {
        count
      }
    }
  `);

  res.status(200).send({ count: countData.data.productsCount.count });
});

app.post("/api/products", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`Failed to process products/create: ${message}`);
    status = 500;
    error = message;
  }
  res.status(status).send({ success: status === 200, error });
});

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

await connectDatabase();
await prisma.shop.count();
await Promise.all([
  prisma.shop.findFirst({ select: { activeSnapshotId: true } }),
  prisma.snapshotRun.findFirst({
    select: { leaseToken: true, leasedUntil: true },
  }),
  prisma.snapshotChange.findFirst({ select: { appliedRevision: true } }),
  prisma.catalogSyncState.findFirst({ select: { shop: true } }),
  prisma.installationState.findFirst({ select: { shopHash: true } }),
]);
const server = app.listen(PORT);

async function shutdown() {
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 5000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  await disconnectDatabase().catch(() => {});
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
