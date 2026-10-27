import assert from "node:assert/strict";
import { QueueEvents } from "bullmq";
import { createQueue, createWorker, redisConnection } from "../queues.js";

const name = `connection-check-${crypto.randomUUID()}`;
const queue = createQueue(name);
const events = new QueueEvents(name, {
  prefix: "newmeta",
  connection: redisConnection({ worker: true }),
});
const worker = createWorker(name, async (job) => ({ message: job.data.message }));
let job;
const timeout = setTimeout(() => {
  console.error("BullMQ verification timed out. Check Docker Desktop and REDIS_URL.");
  process.exit(1);
}, 30000);

for (const resource of [queue, events, worker]) {
  resource.on("error", (error) => console.error("Redis connection error:", error.message));
}

try {
  await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
  job = await queue.add("check", { message: "newmeta-bullmq-ok" });
  const result = await job.waitUntilFinished(events, 10000);
  assert.equal(result.message, "newmeta-bullmq-ok");
  console.log("PASS: BullMQ enqueued and processed a job using Docker Redis.");
} catch (error) {
  console.error("BullMQ verification failed:", error.message);
  process.exitCode = 1;
} finally {
  await worker.close();
  if (job) await job.remove();
  await queue.obliterate();
  await Promise.all([events.close(), queue.close()]);
  clearTimeout(timeout);
}
