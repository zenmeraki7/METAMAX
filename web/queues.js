import "./env.js";
import { Queue, Worker } from "bullmq";
import { redisConnection } from "./shared/redis.js";
export { redisConnection };

// Each queue/worker owns its connections. Close it when the process shuts down.
export function createQueue(name = "jobs", options = {}) {
  return new Queue(name, {
    prefix: "newmeta",
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      // Neon owns durable state and retry eligibility.
      // Remove terminal jobs so deterministic continuation/recovery job IDs
      // can be scheduled again without blocking.
      removeOnComplete: true,
      removeOnFail: true,
      ...options.defaultJobOptions,
    },
    ...options,
  });
}

export function createWorker(name, processor) {
  return new Worker(name, processor, {
    prefix: "newmeta",
    connection: redisConnection({ worker: true }),
  });
}
