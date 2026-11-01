import "dotenv/config";
import pg from "pg";
import {createVerifiedRuntimePool} from '../security/runtime-database.server.js';

// Keep a single bounded pool per backend process. Credentials stay server-side.
const poolMax = Number(process.env.DATABASE_POOL_MAX || (process.env.NODE_ENV === "production" ? 20 : 10));
const applicationPool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
      enableChannelBinding: true,
    })
  : null;
export const database=applicationPool?createVerifiedRuntimePool(applicationPool):null;
const workerPool=variable=>process.env[variable]?new pg.Pool({connectionString:process.env[variable],max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:15000,query_timeout:15000,enableChannelBinding:true}):null;
const catalogPool=workerPool('CATALOG_WORKER_DATABASE_URL'),operationPool=workerPool('OPERATION_WORKER_DATABASE_URL');
export const catalogWorkerDatabase=catalogPool?createVerifiedRuntimePool(catalogPool,{profile:'catalogWorker'}):null;
export const operationWorkerDatabase=operationPool?createVerifiedRuntimePool(operationPool,{profile:'operationWorker'}):null;
for(const pool of [catalogPool,operationPool])pool?.on('error',error=>console.error('[worker-postgres] Idle connection error:',error.code||error.name));

// Dedicated restricted login for gateway reads. Never fall back to the owner
// connection when its credentials or RLS policies have not been provisioned.
export const tenantReadPool=process.env.TENANT_DATABASE_URL?new pg.Pool({
  connectionString:process.env.TENANT_DATABASE_URL,max:5,idleTimeoutMillis:30000,
  connectionTimeoutMillis:5000,query_timeout:15000,enableChannelBinding:true,
}):null;
tenantReadPool?.on('error',error=>console.error('[tenant-postgres] Idle connection error:',error.code||error.name));

applicationPool?.on("error", error => {
  console.error("[postgres] Idle connection error:", error.code || error.name);
});

export async function connectDatabase() {
  if (!database) throw new Error("DATABASE_URL is required to connect to Postgres");
  if(!catalogWorkerDatabase)throw Error('CATALOG_WORKER_DATABASE_URL is required for install/uninstall and catalog workers');
  await database.query("SELECT 1");
  for(const worker of [catalogWorkerDatabase,operationWorkerDatabase])if(worker)await worker.query('SELECT 1');
  return database;
}

export async function closeDatabase() {
  await Promise.all([applicationPool?.end(),tenantReadPool?.end(),catalogPool?.end(),operationPool?.end()]);
}
