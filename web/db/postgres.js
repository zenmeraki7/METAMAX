import "dotenv/config";
import pg from "pg";

// Keep a single bounded pool per backend process. Credentials stay server-side.
export const database = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
      enableChannelBinding: true,
    })
  : null;

database?.on("error", error => {
  console.error("[postgres] Idle connection error:", error.code || error.name);
});

export async function connectDatabase() {
  if (!database) throw new Error("DATABASE_URL is required to connect to Postgres");
  await database.query("SELECT 1");
  return database;
}

export async function closeDatabase() {
  await database?.end();
}
