import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readEnvironment } from "../shared/env.js";
import { ConfigurationError } from "../shared/errors.js";
import { redisConnection } from "../shared/redis.js";
import { redisConnection as legacyRedisConnection } from "../queues.js";

const valid = {
  DATABASE_URL: "postgresql://test:example@localhost/test",
  DIRECT_URL: "postgresql://test:example@localhost/test",
  REDIS_URL: "redis://localhost:6379/0",
};

test("validates database and Redis configuration without requiring Shopify credentials", () => {
  const environment = readEnvironment(valid);
  assert.equal(environment.database.url, valid.DATABASE_URL);
  assert.equal(environment.database.directUrl, valid.DIRECT_URL);
  assert.equal(environment.redis.url, valid.REDIS_URL);
  assert.ok(Object.isFrozen(environment.database));
  assert.ok(Object.isFrozen(environment.redis));
});

test("reports missing required configuration by variable name", () => {
  for (const variable of ["DATABASE_URL", "REDIS_URL"]) {
    assert.throws(() => readEnvironment({ ...valid, [variable]: " " }), error =>
      error instanceof ConfigurationError && error.variable === variable &&
      error.code === "INVALID_ENVIRONMENT");
  }
});

test("rejects invalid connection URLs without including their values in errors", () => {
  for (const [variable, value] of [
    ["DATABASE_URL", "https://private-user:private-password@example.com/db"],
    ["DATABASE_URL", "postgresql://private-user:private-password@example.com/"],
    ["DIRECT_URL", "private-password"],
    ["REDIS_URL", "https://private-user:private-password@example.com/0"],
    ["REDIS_URL", "redis://private-user:private-password@example.com/-1"],
    ["REDIS_URL", "redis://private-user:private-password@example.com/1.5"],
    ["REDIS_URL", "redis://private-user:private-password@example.com/9007199254740993"],
    ["REDIS_URL", "redis://private-user:%ZZ@example.com/0"],
  ]) {
    assert.throws(() => readEnvironment({ ...valid, [variable]: value }), error => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.variable, variable);
      assert.ok(!error.message.includes("private-password"));
      assert.ok(!error.message.includes("private-user"));
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test("queue-only consumers do not require database credentials", () => {
  assert.equal(readEnvironment({ REDIS_URL: valid.REDIS_URL }, {
    requireDatabase: false,
  }).redis.url, valid.REDIS_URL);
});

test("database-only consumers do not require Redis credentials", () => {
  assert.equal(readEnvironment({ DATABASE_URL: valid.DATABASE_URL }, {
    requireRedis: false,
  }).database.url, valid.DATABASE_URL);
});

test("Redis options preserve TLS, credentials and worker retry behavior", () => {
  const previous = process.env.REDIS_URL;
  try {
    process.env.REDIS_URL = "rediss://test%40user:example%3Apassword@localhost:6380/2";
    assert.equal(legacyRedisConnection, redisConnection);
    const producer = redisConnection();
    const worker = redisConnection({ worker: true });
    assert.equal(producer.username, "test@user");
    assert.equal(producer.password, "example:password");
    assert.equal(producer.port, 6380);
    assert.equal(producer.db, 2);
    assert.deepEqual(producer.tls, {});
    assert.equal(producer.enableOfflineQueue, false);
    assert.equal(producer.maxRetriesPerRequest, 1);
    assert.equal(worker.enableOfflineQueue, true);
    assert.equal(worker.maxRetriesPerRequest, null);
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});

test("loading local settings preserves deployment or CLI environment values", () => {
  const script = `
    process.env.REDIS_URL = 'redis://localhost:6399/3';
    const { readEnvironment } = await import('./shared/env.js');
    if (readEnvironment(process.env, { requireDatabase: false }).redis.url !==
        'redis://localhost:6399/3') process.exit(1);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
  });
  assert.equal(child.status, 0, "Runtime environment value was not preserved");
});

test("shared database entry point reuses the existing Prisma client", async () => {
  const shared = await import("../shared/db.js");
  const existing = await import("../db/client.js");
  assert.equal(shared.prisma, existing.prisma);
  assert.equal(shared.default, existing.default);
  assert.equal(shared.disconnectDatabase, existing.disconnectDatabase);
  assert.equal(shared.databaseSettings, existing.databaseSettings);
});
