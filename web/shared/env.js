import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "./errors.js";

// Preserve deployment/Shopify CLI values; local settings only fill missing keys.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

function connectionUrl(source, name, protocols, required, database = false) {
  const value = source[name]?.trim();
  if (!value) {
    if (required) throw new ConfigurationError(name, "is required");
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
    // Catch malformed credential encoding without leaking the URL.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new ConfigurationError(name, "must be a valid connection URL");
  }
  if (!protocols.includes(url.protocol) || !url.hostname ||
      (database && (!url.username || url.pathname.length <= 1))) {
    throw new ConfigurationError(name, database
      ? "must contain a PostgreSQL hostname, username and database name"
      : "must contain a Redis hostname and use redis:// or rediss://");
  }
  if (!database) {
    const index = url.pathname.slice(1) || "0";
    if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) {
      throw new ConfigurationError(name, "must specify a non-negative integer database number");
    }
  }
  return value;
}

// Validate only the services needed by the caller. Migration and queue-only
// scripts need not supply Shopify credentials or unrelated service settings.
export function readEnvironment(source = process.env, {
  requireDatabase = true,
  requireRedis = true,
} = {}) {
  return Object.freeze({
    database: Object.freeze({
      url: connectionUrl(source, "DATABASE_URL", ["postgres:", "postgresql:"], requireDatabase, true),
      directUrl: connectionUrl(source, "DIRECT_URL", ["postgres:", "postgresql:"], false, true),
    }),
    redis: Object.freeze({
      url: connectionUrl(source, "REDIS_URL", ["redis:", "rediss:"], requireRedis),
    }),
  });
}
