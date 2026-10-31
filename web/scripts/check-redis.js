import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectRedis, closeRedis } from "../db/redis.js";

try {
  const redis = await connectRedis();
  assert.equal(await redis.ping(), "PONG");
  const key = `newmeta:connection-check:${randomUUID()}`;
  try {
    await redis.set(key, "connected", { EX: 30 });
    assert.equal(await redis.get(key), "connected");
  } finally {
    await redis.del(key);
  }
  console.log("Redis connection verified: PING and SET/GET passed.");
} finally {
  await closeRedis();
}
