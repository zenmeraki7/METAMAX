import "../env.js";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// --------------------------------------------------
// Configuration
// --------------------------------------------------

function readInteger(name, fallback, min, max) {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const normalized = raw.trim();

  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}`
    );
  }

  const value = Number(normalized);

  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}`
    );
  }

  return value;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();

  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new Error(
    `${name} must be exactly true or false`
  );
}

function databaseUrl() {
  const raw = process.env.DATABASE_URL?.trim();

  if (!raw) {
    throw new Error("DATABASE_URL is required");
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL URL"
    );
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length <= 1
  ) {
    throw new Error(
      "DATABASE_URL must contain a PostgreSQL " +
      "hostname, username and database name"
    );
  }

  const requireNeonPooler = databaseSettings.requireNeonPooler;

  if (requireNeonPooler) {
    const hostname = url.hostname.toLowerCase();

    if (
      !hostname.endsWith(".neon.tech") ||
      !hostname.includes("-pooler.")
    ) {
      throw new Error(
        "DATABASE_URL must use a Neon pooled endpoint"
      );
    }
  }

  return raw;
}

export const databaseSettings = Object.freeze({
  requireNeonPooler: readBoolean(
    "DATABASE_REQUIRE_NEON_POOLER",
    false
  ),

  poolMax: readInteger(
    "DATABASE_POOL_MAX", 5, 1, 50
  ),

  connectionTimeoutMs: readInteger(
    "DATABASE_CONNECTION_TIMEOUT_MS",
    10000, 1000, 120000
  ),

  idleTimeoutMs: readInteger(
    "DATABASE_IDLE_TIMEOUT_MS",
    30000, 1000, 300000
  ),

  connectionLifetimeSeconds: readInteger(
    "DATABASE_CONNECTION_LIFETIME_SECONDS",
    1800, 0, 86400
  ),

  transactionMaxWaitMs: readInteger(
    "DATABASE_TRANSACTION_MAX_WAIT_MS",
    10000, 1000, 120000
  ),

  transactionTimeoutMs: readInteger(
    "DATABASE_TRANSACTION_TIMEOUT_MS",
    15000, 1000, 120000
  ),
});

// --------------------------------------------------
// Adapter
// --------------------------------------------------

const adapter = new PrismaPg({
  connectionString: databaseUrl(),

  max: databaseSettings.poolMax,

  connectionTimeoutMillis:
    databaseSettings.connectionTimeoutMs,

  idleTimeoutMillis:
    databaseSettings.idleTimeoutMs,

  maxLifetimeSeconds:
    databaseSettings.connectionLifetimeSeconds,
});

// --------------------------------------------------
// Prisma client
// --------------------------------------------------

export const prisma = new PrismaClient({
  adapter,

  log: [
    { emit: "stdout", level: "error" },
    { emit: "stdout", level: "warn" },
  ],

  transactionOptions: {
    maxWait: databaseSettings.transactionMaxWaitMs,
    timeout: databaseSettings.transactionTimeoutMs,
  },
});

// --------------------------------------------------
// Lifecycle state
// --------------------------------------------------

const STATE = Object.freeze({
  IDLE: "IDLE",
  STARTING: "STARTING",
  READY: "READY",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
});

let state = STATE.IDLE;

let startupPromise = null;
let healthPromise = null;
let shutdownPromise = null;

function isStopping() {
  return (
    state === STATE.STOPPING ||
    state === STATE.STOPPED
  );
}

function assertRunning() {
  if (isStopping()) {
    throw new Error(
      "Database shutdown is in progress or complete"
    );
  }
}

// --------------------------------------------------
// Startup readiness
// --------------------------------------------------

export function connectDatabase() {
  if (isStopping()) {
    return Promise.reject(
      new Error(
        "Database shutdown is in progress or complete"
      )
    );
  }

  if (startupPromise) {
    return startupPromise;
  }

  // Already initialized successfully.
  // Ongoing connectivity belongs to health probes.
  if (state === STATE.READY) {
    return Promise.resolve(true);
  }

  state = STATE.STARTING;

  const operation = (async () => {
    try {
      await prisma.$connect();

      assertRunning();

      await prisma.$queryRaw`SELECT 1`;

      assertRunning();

      state = STATE.READY;

      return true;
    } catch (error) {
      if (state === STATE.STARTING) {
        state = STATE.IDLE;
      }

      throw error;
    }
  })();

  startupPromise = operation;

  void operation.then(
    () => {
      if (startupPromise === operation) {
        startupPromise = null;
      }
    },
    () => {
      if (startupPromise === operation) {
        startupPromise = null;
      }
    }
  );

  return operation;
}

// --------------------------------------------------
// Database health
// --------------------------------------------------

export function checkDatabaseHealth() {
  if (isStopping()) {
    return Promise.resolve(false);
  }

  // Share an ongoing probe rather than creating
  // a SQL query for every concurrent health request.
  if (healthPromise) {
    return healthPromise;
  }

  const operation = (async () => {
    try {
      if (isStopping()) {
        return false;
      }

      await prisma.$queryRaw`SELECT 1`;

      return !isStopping();
    } catch {
      return false;
    }
  })();

  healthPromise = operation;

  void operation.then(
    () => {
      if (healthPromise === operation) {
        healthPromise = null;
      }
    },
    () => {
      if (healthPromise === operation) {
        healthPromise = null;
      }
    }
  );

  return operation;
}

// --------------------------------------------------
// Lifecycle status
// --------------------------------------------------

export function databaseStatus() {
  return Object.freeze({
    state,
    disconnecting: isStopping(),
  });
}

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

export function disconnectDatabase() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  // Immediately reject new lifecycle operations.
  state = STATE.STOPPING;

  shutdownPromise = (async () => {
    try {
      // Drain startup and health operations.
      // Other application queries must already
      // have been drained by the caller.
      const pending = [
        startupPromise,
        healthPromise,
      ].filter(Boolean);

      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }

      await prisma.$disconnect();
    } finally {
      state = STATE.STOPPED;
    }
  })();

  return shutdownPromise;
}

export default prisma;
