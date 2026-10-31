/**
 * BullMQ-compatible Redis transport for METAMAX catalog sync & recovery queues.
 *
 * Uses atomic Lua scripts over the Node Redis client (web/db/redis.js) so
 * deterministic jobId deduplication, active-job leases, stalled-job recovery,
 * and external queue state inspection operate without external npm packages.
 *
 * All Redis operations run strictly outside PostgreSQL transactions.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  SYNC_QUEUE_NAME,
  RECOVERY_QUEUE_NAME,
} from "./sync.worker.js";

const ID_RE = /^[A-Za-z0-9_-]{1,192}$/;
const QUEUE_RE = /^[A-Za-z0-9:_-]{1,128}$/;

export class SyncRedisTransportError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "SyncRedisTransportError";
    this.code = code;
  }
}

function positiveInt(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${label}`);
  }
  return value;
}

function requireQueueName(value, label = "queueName") {
  if (typeof value !== "string" || !QUEUE_RE.test(value)) {
    throw new SyncRedisTransportError("INVALID_QUEUE", `Invalid ${label}`);
  }
  return value;
}

function requireJobId(value, label = "jobId") {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new SyncRedisTransportError("INVALID_JOB_ID", `Invalid ${label}`);
  }
  return value;
}

function validateJobPayload(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
    Reflect.ownKeys(data).length !== 1 ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(data, "runId") ?? {}, "value") ||
    typeof data.runId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.runId)
  ) {
    throw new SyncRedisTransportError(
      "INVALID_JOB_DATA",
      "Transport job payload must be a plain object containing only { runId }",
    );
  }
  return data.runId;
}

function assertRedisClient(redis) {
  if (!redis || typeof redis.eval !== "function") {
    throw new TypeError("Redis client with eval() is required");
  }
  if (Object.hasOwn(redis, "isOpen") && redis.isOpen === false) {
    throw new SyncRedisTransportError(
      "REDIS_NOT_CONNECTED",
      "Redis client is not connected",
    );
  }
}

function queueKeys(prefix, queueName) {
  const base = `${prefix}:${queueName}`;
  return Object.freeze({
    wait: `${base}:wait`,
    active: `${base}:active`,
    jobPrefix: `${base}:job:`,
    job: (jobId) => `${base}:job:${jobId}`,
  });
}

const ENQUEUE_LUA = `
local waitKey = KEYS[1]
local activeKey = KEYS[2]
local jobKey = KEYS[3]

local jobId = ARGV[1]
local name = ARGV[2]
local runId = ARGV[3]
local nowMs = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])
local removeOnComplete = ARGV[6]
local removeOnFail = ARGV[7]
local maxAttempts = ARGV[8]

if redis.call('EXISTS', jobKey) == 1 then
  local state = redis.call('HGET', jobKey, 'state')
  local existingRunId = redis.call('HGET', jobKey, 'runId')
  if existingRunId ~= runId then
    return {'CONFLICT', state or 'unknown'}
  end
  if state == 'waiting' or state == 'active' then
    return {'DUPLICATE', state}
  end
  redis.call('DEL', jobKey)
end

redis.call('HSET', jobKey,
  'id', jobId,
  'name', name,
  'runId', runId,
  'state', 'waiting',
  'createdAtMs', tostring(nowMs),
  'leaseToken', '',
  'leaseUntilMs', '0',
  'attemptsMade', '0',
  'stalledCount', '0',
  'maxAttempts', tostring(maxAttempts),
  'removeOnComplete', removeOnComplete,
  'removeOnFail', removeOnFail
)
redis.call('EXPIRE', jobKey, ttlSeconds)
redis.call('RPUSH', waitKey, jobId)
return {'ENQUEUED', 'waiting'}
`;

const INSPECT_JOB_LUA = `
local waitKey = KEYS[1]
local activeKey = KEYS[2]
local jobKey = KEYS[3]
local jobId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local maxStalledCount = tonumber(ARGV[3])

if redis.call('EXISTS', jobKey) == 0 then
  redis.call('SREM', activeKey, jobId)
  return nil
end

local id = redis.call('HGET', jobKey, 'id') or jobId
local name = redis.call('HGET', jobKey, 'name') or ''
local runId = redis.call('HGET', jobKey, 'runId') or ''
local state = redis.call('HGET', jobKey, 'state') or 'unknown'
local leaseUntilMs = tonumber(redis.call('HGET', jobKey, 'leaseUntilMs') or '0')
local stalledCount = tonumber(redis.call('HGET', jobKey, 'stalledCount') or '0')
local removeOnFail = redis.call('HGET', jobKey, 'removeOnFail') or '1'

if state == 'active' and leaseUntilMs > 0 and leaseUntilMs <= nowMs then
  if stalledCount >= maxStalledCount then
    redis.call('SREM', activeKey, jobId)
    if removeOnFail == '1' then
      redis.call('DEL', jobKey)
      return nil
    else
      state = 'failed'
      redis.call('HSET', jobKey, 'state', 'failed', 'leaseToken', '', 'leaseUntilMs', '0')
    end
  end
end

return {id, name, runId, state}
`;

const REMOVE_JOB_LUA = `
local waitKey = KEYS[1]
local activeKey = KEYS[2]
local jobKey = KEYS[3]
local jobId = ARGV[1]

redis.call('LREM', waitKey, 0, jobId)
redis.call('SREM', activeKey, jobId)
return redis.call('DEL', jobKey)
`;

const RECOVER_STALLED_LUA = `
local waitKey = KEYS[1]
local activeKey = KEYS[2]
local jobPrefix = ARGV[1]
local nowMs = tonumber(ARGV[2])
local maxStalledCount = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])

local activeIds = redis.call('SMEMBERS', activeKey)
local requeued = {}
local failed = {}

for _, jobId in ipairs(activeIds) do
  local jobKey = jobPrefix .. jobId
  if redis.call('EXISTS', jobKey) == 0 then
    redis.call('SREM', activeKey, jobId)
  else
    local state = redis.call('HGET', jobKey, 'state')
    local leaseUntilMs = tonumber(redis.call('HGET', jobKey, 'leaseUntilMs') or '0')
    if state ~= 'active' then
      redis.call('SREM', activeKey, jobId)
    elseif leaseUntilMs <= nowMs then
      local stalledCount = tonumber(redis.call('HGET', jobKey, 'stalledCount') or '0') + 1
      redis.call('SREM', activeKey, jobId)
      if stalledCount > maxStalledCount then
        local runId = redis.call('HGET', jobKey, 'runId') or ''
        local removeOnFail = redis.call('HGET', jobKey, 'removeOnFail') or '1'
        if removeOnFail == '1' then
          redis.call('DEL', jobKey)
        else
          redis.call('HSET', jobKey,
            'state', 'failed',
            'stalledCount', tostring(stalledCount),
            'leaseToken', '',
            'leaseUntilMs', '0'
          )
          redis.call('EXPIRE', jobKey, ttlSeconds)
        end
        table.insert(failed, jobId .. '\\0' .. runId)
      else
        redis.call('HSET', jobKey,
          'state', 'waiting',
          'stalledCount', tostring(stalledCount),
          'leaseToken', '',
          'leaseUntilMs', '0'
        )
        redis.call('EXPIRE', jobKey, ttlSeconds)
        redis.call('LREM', waitKey, 0, jobId)
        redis.call('LPUSH', waitKey, jobId)
        table.insert(requeued, jobId)
      end
    end
  end
end

return {requeued, failed}
`;

const CLAIM_JOB_LUA = `
local waitKey = KEYS[1]
local activeKey = KEYS[2]
local jobPrefix = ARGV[1]
local leaseToken = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

for _ = 1, 32 do
  local jobId = redis.call('LPOP', waitKey)
  if not jobId then
    return nil
  end
  local jobKey = jobPrefix .. jobId
  if redis.call('EXISTS', jobKey) == 1 then
    local state = redis.call('HGET', jobKey, 'state')
    if state == 'waiting' then
      local attemptsMade = tonumber(redis.call('HGET', jobKey, 'attemptsMade') or '0') + 1
      local leaseUntilMs = nowMs + leaseMs
      redis.call('HSET', jobKey,
        'state', 'active',
        'leaseToken', leaseToken,
        'leaseUntilMs', tostring(leaseUntilMs),
        'attemptsMade', tostring(attemptsMade)
      )
      redis.call('EXPIRE', jobKey, ttlSeconds)
      redis.call('SADD', activeKey, jobId)
      local name = redis.call('HGET', jobKey, 'name') or ''
      local runId = redis.call('HGET', jobKey, 'runId') or ''
      local removeOnComplete = redis.call('HGET', jobKey, 'removeOnComplete') or '1'
      local removeOnFail = redis.call('HGET', jobKey, 'removeOnFail') or '1'
      return {jobId, name, runId, tostring(attemptsMade), removeOnComplete, removeOnFail}
    end
  end
end

return nil
`;

const RENEW_JOB_LUA = `
local activeKey = KEYS[1]
local jobKey = KEYS[2]
local jobId = ARGV[1]
local leaseToken = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

if redis.call('EXISTS', jobKey) == 0 then
  redis.call('SREM', activeKey, jobId)
  return 0
end

local state = redis.call('HGET', jobKey, 'state')
local currentToken = redis.call('HGET', jobKey, 'leaseToken')
local leaseUntilMs = tonumber(redis.call('HGET', jobKey, 'leaseUntilMs') or '0')

if state ~= 'active' or currentToken ~= leaseToken or leaseUntilMs <= nowMs then
  return 0
end

redis.call('HSET', jobKey, 'leaseUntilMs', tostring(nowMs + leaseMs))
redis.call('EXPIRE', jobKey, ttlSeconds)
return 1
`;

const FINISH_JOB_LUA = `
local activeKey = KEYS[1]
local jobKey = KEYS[2]
local jobId = ARGV[1]
local leaseToken = ARGV[2]
local finalState = ARGV[3]
local shouldRemove = ARGV[4]
local ttlSeconds = tonumber(ARGV[5])

if redis.call('EXISTS', jobKey) == 0 then
  redis.call('SREM', activeKey, jobId)
  return 0
end

local state = redis.call('HGET', jobKey, 'state')
local currentToken = redis.call('HGET', jobKey, 'leaseToken')

if state ~= 'active' or currentToken ~= leaseToken then
  return 0
end

redis.call('SREM', activeKey, jobId)
if shouldRemove == '1' then
  redis.call('DEL', jobKey)
else
  redis.call('HSET', jobKey,
    'state', finalState,
    'leaseToken', '',
    'leaseUntilMs', '0'
  )
  redis.call('EXPIRE', jobKey, ttlSeconds)
end
return 1
`;

export function createSyncRedisQueue({
  redis,
  queueName,
  prefix = "metamax:bull",
  jobTtlSeconds = 86_400,
  maxStalledCount = 2,
} = {}) {
  if (!redis || typeof redis.eval !== "function") {
    throw new TypeError("Redis client with eval() is required");
  }
  requireQueueName(queueName, "queueName");
  requireQueueName(prefix, "prefix");
  positiveInt(jobTtlSeconds, 60, 604_800, "jobTtlSeconds");
  positiveInt(maxStalledCount, 1, 10, "maxStalledCount");

  const keys = queueKeys(prefix, queueName);

  async function add(name, data, options = {}) {
    assertRedisClient(redis);
    requireQueueName(name, "job name");
    const runId = validateJobPayload(data);
    const jobId = requireJobId(options?.jobId, "jobId");
    const attempts = options?.attempts === undefined
      ? 1
      : positiveInt(options.attempts, 1, 10, "attempts");
    const removeOnComplete = options?.removeOnComplete !== false ? "1" : "0";
    const removeOnFail = options?.removeOnFail !== false ? "1" : "0";

    const reply = await redis.eval(ENQUEUE_LUA, {
      keys: [keys.wait, keys.active, keys.job(jobId)],
      arguments: [
        jobId,
        name,
        runId,
        String(Date.now()),
        String(jobTtlSeconds),
        removeOnComplete,
        removeOnFail,
        String(attempts),
      ],
    });

    if (!Array.isArray(reply) || reply[0] === "CONFLICT") {
      throw new SyncRedisTransportError(
        "JOB_ID_CONFLICT",
        "Deterministic jobId already bound to a different runId",
      );
    }

    return Object.freeze({
      id: jobId,
      name,
      data: Object.freeze({ runId }),
    });
  }

  async function getJob(jobId) {
    assertRedisClient(redis);
    requireJobId(jobId, "jobId");

    const reply = await redis.eval(INSPECT_JOB_LUA, {
      keys: [keys.wait, keys.active, keys.job(jobId)],
      arguments: [jobId, String(Date.now()), String(maxStalledCount)],
    });

    if (!Array.isArray(reply) || reply.length < 4) {
      return null;
    }

    const [id, name, runId, initialState] = reply;
    return Object.freeze({
      id,
      name,
      data: Object.freeze({ runId }),
      async getState() {
        assertRedisClient(redis);
        const current = await redis.eval(INSPECT_JOB_LUA, {
          keys: [keys.wait, keys.active, keys.job(jobId)],
          arguments: [jobId, String(Date.now()), String(maxStalledCount)],
        });
        if (!Array.isArray(current) || current.length < 4) {
          return "completed";
        }
        return current[3];
      },
      async remove() {
        assertRedisClient(redis);
        await redis.eval(REMOVE_JOB_LUA, {
          keys: [keys.wait, keys.active, keys.job(jobId)],
          arguments: [jobId],
        });
      },
    });
  }

  return Object.freeze({
    name: queueName,
    add,
    getJob,
  });
}

export function createSyncRedisWorkerClass({
  redis: defaultRedis,
  prefix = "metamax:bull",
  activeLeaseMs = 60_000,
  pollIntervalMs = 250,
  jobTtlSeconds = 86_400,
} = {}) {
  requireQueueName(prefix, "prefix");
  positiveInt(activeLeaseMs, 2_000, 600_000, "activeLeaseMs");
  positiveInt(pollIntervalMs, 20, 60_000, "pollIntervalMs");
  positiveInt(jobTtlSeconds, 60, 604_800, "jobTtlSeconds");

  return class SyncRedisWorker extends EventEmitter {
    constructor(queueName, processor, options = {}) {
      super();
      requireQueueName(queueName, "queueName");
      if (typeof processor !== "function") {
        throw new TypeError("Worker processor function required");
      }
      const client = options.connection?.redis ?? options.connection ?? defaultRedis;
      if (!client || typeof client.eval !== "function") {
        throw new TypeError("Redis connection with eval() required");
      }

      this.name = queueName;
      this.#processor = processor;
      this.#redis = client;
      this.#concurrency = options.concurrency === undefined
        ? 2
        : positiveInt(options.concurrency, 1, 32, "concurrency");
      this.#maxStalledCount = options.maxStalledCount === undefined
        ? 2
        : positiveInt(options.maxStalledCount, 1, 10, "maxStalledCount");
      this.#keys = queueKeys(prefix, queueName);

      if (options.autorun !== false) {
        this.run();
      }
    }

    #processor;
    #redis;
    #concurrency;
    #maxStalledCount;
    #keys;
    #running = false;
    #closing = false;
    #pollTimer = null;
    #inFlight = new Set();

    isRunning() {
      return this.#running && !this.#closing;
    }

    async recoverStalled() {
      assertRedisClient(this.#redis);
      const reply = await this.#redis.eval(RECOVER_STALLED_LUA, {
        keys: [this.#keys.wait, this.#keys.active],
        arguments: [
          this.#keys.jobPrefix,
          String(Date.now()),
          String(this.#maxStalledCount),
          String(jobTtlSeconds),
        ],
      });
      if (!Array.isArray(reply)) return { requeued: [], failed: [] };
      const [requeued = [], failed = []] = reply;
      for (const jobId of requeued) {
        this.emit("stalled", jobId);
      }
      for (const entry of failed) {
        const [jobId, runId = ""] = String(entry).split("\0");
        this.emit("stalled", jobId);
        const stalledError = new SyncRedisTransportError(
          "JOB_STALLED_EXHAUSTED",
          "Job exceeded maximum stalled count",
        );
        this.emit(
          "failed",
          Object.freeze({ id: jobId, name: this.name, data: Object.freeze({ runId }) }),
          stalledError,
        );
      }
      return { requeued, failed };
    }

    async processNext() {
      if (this.#closing) return null;
      assertRedisClient(this.#redis);
      await this.recoverStalled();

      const leaseToken = randomUUID();
      const claimed = await this.#redis.eval(CLAIM_JOB_LUA, {
        keys: [this.#keys.wait, this.#keys.active],
        arguments: [
          this.#keys.jobPrefix,
          leaseToken,
          String(Date.now()),
          String(activeLeaseMs),
          String(jobTtlSeconds),
        ],
      });

      if (!Array.isArray(claimed) || claimed.length < 6) {
        return null;
      }

      const [jobId, jobName, runId, attemptsMade, removeOnComplete, removeOnFail] = claimed;
      const job = Object.freeze({
        id: jobId,
        name: jobName || this.name,
        attemptsMade: Number(attemptsMade),
        data: Object.freeze({ runId }),
      });

      const heartbeatIntervalMs = Math.max(500, Math.floor(activeLeaseMs / 3));
      const heartbeat = setInterval(() => {
        void this.#redis
          .eval(RENEW_JOB_LUA, {
            keys: [this.#keys.active, this.#keys.job(jobId)],
            arguments: [
              jobId,
              leaseToken,
              String(Date.now()),
              String(activeLeaseMs),
              String(jobTtlSeconds),
            ],
          })
          .catch((error) => {
            this.emit("error", error);
          });
      }, heartbeatIntervalMs);
      heartbeat.unref?.();

      try {
        const result = await this.#processor(job);
        await this.#redis.eval(FINISH_JOB_LUA, {
          keys: [this.#keys.active, this.#keys.job(jobId)],
          arguments: [
            jobId,
            leaseToken,
            "completed",
            removeOnComplete,
            String(jobTtlSeconds),
          ],
        });
        this.emit("completed", job, result);
        return { job, result };
      } catch (error) {
        try {
          await this.#redis.eval(FINISH_JOB_LUA, {
            keys: [this.#keys.active, this.#keys.job(jobId)],
            arguments: [
              jobId,
              leaseToken,
              "failed",
              removeOnFail,
              String(jobTtlSeconds),
            ],
          });
        } catch (finishError) {
          this.emit("error", finishError);
        }
        this.emit("failed", job, error);
        return { job, error };
      } finally {
        clearInterval(heartbeat);
      }
    }

    #schedulePoll() {
      if (!this.#running || this.#closing || this.#pollTimer) return;
      this.#pollTimer = setTimeout(() => {
        this.#pollTimer = null;
        void this.#pump();
      }, pollIntervalMs);
      this.#pollTimer.unref?.();
    }

    async #pump() {
      if (!this.#running || this.#closing) return;
      while (
        this.#running &&
        !this.#closing &&
        this.#inFlight.size < this.#concurrency
      ) {
        let dispatched = false;
        const task = (async () => {
          try {
            const outcome = await this.processNext();
            if (outcome !== null) {
              dispatched = true;
            }
          } catch (error) {
            this.emit("error", error);
          }
        })();
        this.#inFlight.add(task);
        void task.finally(() => {
          this.#inFlight.delete(task);
          if (this.#running && !this.#closing && dispatched) {
            void this.#pump();
          }
        });
        await task;
        if (!dispatched) break;
      }
      this.#schedulePoll();
    }

    run() {
      if (this.#running) return this;
      this.#closing = false;
      this.#running = true;
      void this.#pump();
      return this;
    }

    async close() {
      this.#closing = true;
      this.#running = false;
      if (this.#pollTimer) {
        clearTimeout(this.#pollTimer);
        this.#pollTimer = null;
      }
      await Promise.allSettled([...this.#inFlight]);
    }
  };
}

export function createSyncRedisTransport({
  redis,
  prefix = "metamax:bull",
  jobTtlSeconds = 86_400,
  activeLeaseMs = 60_000,
  pollIntervalMs = 250,
  maxStalledCount = 2,
} = {}) {
  if (!redis || typeof redis.eval !== "function") {
    throw new TypeError("Redis client with eval() is required");
  }

  const syncQueue = createSyncRedisQueue({
    redis,
    queueName: SYNC_QUEUE_NAME,
    prefix,
    jobTtlSeconds,
    maxStalledCount,
  });

  const recoveryQueue = createSyncRedisQueue({
    redis,
    queueName: RECOVERY_QUEUE_NAME,
    prefix,
    jobTtlSeconds,
    maxStalledCount,
  });

  const Worker = createSyncRedisWorkerClass({
    redis,
    prefix,
    activeLeaseMs,
    pollIntervalMs,
    jobTtlSeconds,
  });

  const connection = Object.freeze({ redis, prefix });

  return Object.freeze({
    connection,
    syncQueue,
    recoveryQueue,
    Worker,
  });
}

