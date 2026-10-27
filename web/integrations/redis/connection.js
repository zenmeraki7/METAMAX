import "../../env.js";
import { redisConnection } from "../../queues.js";

export const producerRedis = redisConnection({ worker: false });
export const consumerRedis = redisConnection({ worker: true });
