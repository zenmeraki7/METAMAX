
import "dotenv/config";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";

// Configure SSL for remote PostgreSQL connections.
if (process.env.DATABASE_URL && !process.env.PGSSLMODE) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    const sslmode = url.searchParams.get("sslmode");

    if (sslmode) {
      process.env.PGSSLMODE = sslmode;
    } else if (
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      process.env.PGSSLMODE = "require";
    }
  } catch {
    process.env.PGSSLMODE = "require";
  }
}

// Resolve the public application URL.
const rawAppUrl =
  process.env.SHOPIFY_APP_URL || process.env.HOST;

if (!rawAppUrl) {
  throw new Error(
    "Missing SHOPIFY_APP_URL or HOST environment variable"
  );
}

const appUrl = new URL(
  /^https?:\/\//i.test(rawAppUrl)
    ? rawAppUrl
    : `https://${rawAppUrl}`
);

if (
  process.env.NODE_ENV === "production" &&
  appUrl.protocol !== "https:"
) {
  throw new Error(
    "Shopify application URL must use HTTPS in production"
  );
}

const hostName = appUrl.host;

// Resolve the session database connection.
const sessionDatabaseUrl =
  process.env.SHOPIFY_SESSION_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!sessionDatabaseUrl) {
  throw new Error(
    "Missing SHOPIFY_SESSION_DATABASE_URL or DATABASE_URL"
  );
}

const sessionStorage = new PostgreSQLSessionStorage(
  sessionDatabaseUrl
);

const shopify = shopifyApp({
  api: {
    apiVersion: "2026-10",
    hostName,
    billing: undefined,
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage,
});

export default shopify;
