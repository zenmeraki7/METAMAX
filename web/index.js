import {createCatalogMaintenance} from './services/catalog-maintenance.server.js';
import "dotenv/config";
import { fileURLToPath } from "node:url";
import shopify from "./shopify.js";
import { createApp } from "./app.js";
import { redis, connectRedis, closeRedis } from "./db/redis.js";
import { connectDatabase, closeDatabase, database,tenantReadPool,catalogWorkerDatabase } from "./db/postgres.js";
import { createInstalledFilterHttpRuntime } from "./services/filter-engine.server.js";
import { createReconciliationService } from "./mirror/index.js";
import { createCatalogImportService } from "./services/catalog-import.server.js";
import { createCatalogPhaseRuntime } from "./services/catalog-phase-runtime.server.js";
import {createExportRuntime,exportProductionConfig} from "./export/export-runtime.server.js";
import { createHistorySecurityRuntime } from './edit-history/history-security-runtime.server.js';
import { createOperationSupervisor } from "./workers/operation-supervisor.server.js";

const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid server port");
const staticPath = fileURLToPath(
  new URL(
    process.env.NODE_ENV === "production" ? "./frontend/dist/" : "./frontend/",
    import.meta.url,
  ),
);
if (process.env.DATABASE_URL) {
  await connectDatabase();
  console.log("Neon Postgres connected");
}
// Local development uses the Docker Compose service; hosting can set REDIS_URL.
if (
  process.env.REDIS_ENABLED !== "false" &&
  (process.env.REDIS_URL || process.env.NODE_ENV !== "production")
) {
  await connectRedis();
  console.log("Redis connected");
}

let filterRuntime = null;
if (database) {
  try {
    filterRuntime = await createInstalledFilterHttpRuntime({
      database,
      sessionStorage: shopify.config.sessionStorage,
      cursorSecret:
        process.env.FILTER_CURSOR_SECRET || process.env.SHOPIFY_API_SECRET,
    });
    console.log("Filter Engine initialized and verified");
  } catch (error) {
    console.warn(
      "[app] Filter Engine disabled pending dependency verification:",
      error.message || error,
    );
    filterRuntime = null;
  }
}

const reconciliationService = catalogWorkerDatabase
  ? createReconciliationService({ database:catalogWorkerDatabase })
  : null;
const catalogPhaseRuntime = catalogWorkerDatabase
  ? await createCatalogPhaseRuntime({
      database:catalogWorkerDatabase,
      shopify,
      redis: redis.isOpen ? redis : undefined,
    })
  : null;
const catalogImportService = catalogWorkerDatabase ? createCatalogImportService({ database:catalogWorkerDatabase, shopify, phaseRuntime: catalogPhaseRuntime }) : null;
const exportConfig=exportProductionConfig();
const exportRuntime=exportConfig?await createExportRuntime({database,sessionStorage:shopify.config.sessionStorage,
  cursorSecret:process.env.FILTER_CURSOR_SECRET||process.env.SHOPIFY_API_SECRET,config:exportConfig}):null;
const historySecurityRuntime=await createHistorySecurityRuntime();
if (catalogImportService) {
  // Fail startup clearly if the durable queue migration has not been applied.
  await catalogImportService.verifyStorage();
  catalogImportService.start();
}

const catalogMaintenance=catalogWorkerDatabase?createCatalogMaintenance({database:catalogWorkerDatabase}):null;
await catalogMaintenance?.verifyStorage();

const server = createApp({
  shopify,
  staticPath,
  filterRuntime,
  database,
  lifecycleDatabase:catalogWorkerDatabase,
  tenantReadPool,
  reconciliationService,
  catalogImportService,
  exportRuntime,
  historyPrivacyService:historySecurityRuntime?.privacyService,
}).listen(
  port,
  () => console.log(`Shopify Express app listening on port ${port}`),
);
catalogMaintenance?.start();
const operationSupervisor = database ? createOperationSupervisor({ database, logger: console }) : null;
exportRuntime?.start();
historySecurityRuntime?.start();
operationSupervisor?.start();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close(async () => {
      await catalogImportService?.stop();
      await exportRuntime?.stop();
      await historySecurityRuntime?.stop();
      await operationSupervisor?.stop();
      await catalogMaintenance?.stop();
      await Promise.all([closeRedis(), closeDatabase()]);
      process.exit(0);
    });
  });
