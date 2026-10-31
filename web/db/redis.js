import "dotenv/config";
import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6380",
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: retries => retries >= 5
      ? new Error("Redis reconnect limit reached")
      : Math.min(200 * 2 ** retries, 3000),
  },
});

redis.on("error", error => console.error("[redis] Connection error:", error.code || error.name));

export async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
  return redis;
}

export async function closeRedis() {
  if (redis.isOpen) await redis.close();
}
