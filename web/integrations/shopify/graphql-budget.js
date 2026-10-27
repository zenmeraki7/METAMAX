import "../../env.js";
import Redis from "ioredis";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { redisConnection } from "../../queues.js";

// Every process reserves both a concurrency slot and cost in one Redis script.
// Redis TIME avoids clock skew. Uncertain/crashed requests receive no refund.
const ACQUIRE = `
local time = redis.call('TIME')
local now = time[1]*1000 + math.floor(time[2]/1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _,id in ipairs(expired) do redis.call('HDEL',KEYS[3],id) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local cap = math.min(tonumber(ARGV[3]), tonumber(redis.call('HGET',KEYS[1],'cap') or ARGV[3]))
local rate = math.min(tonumber(ARGV[4]), tonumber(redis.call('HGET',KEYS[1],'rate') or ARGV[4]))
local last = tonumber(redis.call('HGET',KEYS[1],'at') or now)
local tokens = math.min(cap, tonumber(redis.call('HGET',KEYS[1],'tokens') or cap) + math.max(0,now-last)*rate/1000)
local blocked = tonumber(redis.call('HGET',KEYS[1],'blocked') or '0')
redis.call('HSET',KEYS[1],'tokens',tokens,'at',now)
redis.call('PEXPIRE',KEYS[1],86400000)
if blocked > now then return {0, math.ceil(blocked-now)} end
if redis.call('ZCARD',KEYS[2]) >= tonumber(ARGV[2]) then return {0,100} end
if tokens < tonumber(ARGV[5]) then return {0, math.ceil((tonumber(ARGV[5])-tokens)*1000/math.max(rate,1))} end
redis.call('HSET',KEYS[1],'tokens',tokens-tonumber(ARGV[5]))
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[6]),ARGV[1])
redis.call('HSET',KEYS[3],ARGV[1],ARGV[5])
redis.call('PEXPIRE',KEYS[2],tonumber(ARGV[6])*2)
redis.call('PEXPIRE',KEYS[3],tonumber(ARGV[6])*2)
return {1,0}
`;
const RELEASE = `
local time = redis.call('TIME')
local now = time[1]*1000 + math.floor(time[2]/1000)
local held = redis.call('ZREM',KEYS[2],ARGV[1])
redis.call('HDEL',KEYS[3],ARGV[1])
local cap = math.min(tonumber(ARGV[3]),tonumber(ARGV[6]),tonumber(redis.call('HGET',KEYS[1],'cap') or ARGV[3]))
local rate = math.min(tonumber(ARGV[4]),tonumber(ARGV[7]),tonumber(redis.call('HGET',KEYS[1],'rate') or ARGV[4]))
local last = tonumber(redis.call('HGET',KEYS[1],'at') or now)
local tokens = tonumber(redis.call('HGET',KEYS[1],'tokens') or '0') + math.max(0,now-last)*rate/1000
if held == 1 and tonumber(ARGV[2]) >= 0 then tokens = tokens + tonumber(ARGV[5])-tonumber(ARGV[2]) end
tokens = math.max(0,math.min(cap,tokens))
local outstanding = 0
for _,id in ipairs(redis.call('ZRANGE',KEYS[2],0,-1)) do outstanding=outstanding+tonumber(redis.call('HGET',KEYS[3],id) or ARGV[5]) end
if tonumber(ARGV[8]) >= 0 then tokens=math.min(tokens,math.max(0,tonumber(ARGV[8])-outstanding)) end
if tonumber(ARGV[9]) > 0 then
  tokens=0
  local blocked=math.max(tonumber(redis.call('HGET',KEYS[1],'blocked') or '0'),now+tonumber(ARGV[9]))
  redis.call('HSET',KEYS[1],'blocked',blocked)
end
redis.call('HSET',KEYS[1],'tokens',tokens,'at',now,'cap',cap,'rate',rate)
redis.call('PEXPIRE',KEYS[1],86400000)
return 1
`;

let redis;
let connecting;
async function connection() {
  if (!redis || redis.status === "end") {
    redis = new Redis({
      ...redisConnection(),
      lazyConnect: true,
      commandTimeout: 3000,
      retryStrategy: (attempt) => (attempt > 2 ? null : 100),
    });
    redis.on("error", () => {}); // Callers receive failures; never fall back to ungoverned requests.
    // Initial connection is explicit because producer commands do not buffer.
    // Concurrent first requests share the same bounded connection attempt.
    connecting = redis.connect().finally(() => {
      connecting = null;
    });
  }
  if (connecting) await connecting;
  return redis;
}

export function createGraphqlBudget({
  client = connection,
  namespace = "newmeta-gql",
  concurrency = 2,
  capacity = 500,
  restoreRate = 50,
  reservedCost = 50,
  leaseMs = 30000,
  waitMs = 60000,
} = {}) {
  return async function withBudget(
    shop,
    request,
    { requestedCost = reservedCost, signal } = {}
  ) {
    if (
      !Number.isSafeInteger(requestedCost) ||
      requestedCost < 1 ||
      requestedCost > capacity
    ) {
      throw new Error(
        "Requested GraphQL cost cannot fit the configured request budget"
      );
    }
    // All replicas use a stable app namespace, even if OAuth env vars differ.
    const hash = createHash("sha256").update(shop).digest("hex");
    const keys = [
      `${namespace}:{${hash}}:budget`,
      `${namespace}:{${hash}}:leases`,
      `${namespace}:{${hash}}:reservationCosts`,
    ];
    const token = randomUUID();
    const db = typeof client === "function" ? await client() : client;
    const deadline = Date.now() + waitMs;
    while (true) {
      signal?.throwIfAborted();
      const [acquired, wait] = await db.eval(
        ACQUIRE,
        3,
        ...keys,
        token,
        concurrency,
        capacity,
        restoreRate,
        requestedCost,
        leaseMs
      );
      if (acquired) break;
      if (Date.now() >= deadline)
        throw new Error("Shopify per-shop request budget is busy");
      await delay(Math.min(Math.max(wait, 25), 250), undefined, { signal });
    }
    let actual = -1,
      maximum = capacity,
      rate = restoreRate,
      available = -1,
      blocked = 0;
    try {
      const response = await request();
      const cost = response.extensions?.cost;
      const throttle = cost?.throttleStatus;
      if (Number.isFinite(cost?.actualQueryCost)) actual = cost.actualQueryCost;
      if (Number.isFinite(throttle?.maximumAvailable))
        maximum = throttle.maximumAvailable;
      if (Number.isFinite(throttle?.restoreRate)) rate = throttle.restoreRate;
      if (Number.isFinite(throttle?.currentlyAvailable))
        available = throttle.currentlyAvailable;
      return response;
    } catch (error) {
      if (error.throttled) blocked = error.retryAfterMs || 1000;
      throw error;
    } finally {
      // An expired lease is not evidence that the remote query did not execute.
      // Failure to release is safe: reservation is spent and lease expires.
      await db
        .eval(
          RELEASE,
          3,
          ...keys,
          token,
          actual,
          capacity,
          restoreRate,
          requestedCost,
          maximum,
          rate,
          available,
          blocked
        )
        .catch((error) =>
          console.error("[graphql-budget] Release failed:", error.message)
        );
    }
  };
}
export const withGraphqlBudget = createGraphqlBudget();
export async function closeGraphqlBudget() {
  if (redis) await redis.quit();
}
