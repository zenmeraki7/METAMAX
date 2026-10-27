import { readEnvironment } from "./env.js";

// Options only: queues/workers own and close their respective connections.
export function redisConnection({ worker = false } = {}) {
  const environment = readEnvironment(process.env, { requireDatabase: false });
  const url = new URL(environment.redis.url);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    connectTimeout: worker ? 10000 : 1500,
    enableOfflineQueue: worker,
    maxRetriesPerRequest: worker ? null : 1,
  };
}
