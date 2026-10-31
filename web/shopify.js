import "dotenv/config";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";

// Ensure SSL mode is enabled for remote PostgreSQL connections (e.g. Neon)
if (process.env.DATABASE_URL && !process.env.PGSSLMODE) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode) {
      process.env.PGSSLMODE = sslmode;
    } else if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      process.env.PGSSLMODE = "require";
    }
  } catch {
    process.env.PGSSLMODE = "require";
  }
}

const sessionStorage = new PostgreSQLSessionStorage(process.env.DATABASE_URL);

const shopify = shopifyApp({
  api: { apiVersion: "2026-10", billing: undefined },
  auth: { path: "/api/auth", callbackPath: "/api/auth/callback" },
  webhooks: { path: "/api/webhooks" },
  sessionStorage,
});

export default shopify;
