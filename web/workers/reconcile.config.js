import "../env.js";

export function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647)
    throw new TypeError(
      `${name} must be a positive integer no greater than 2147483647`
    );
  return parsed;
}

export function readWorkerConfig(env = process.env) {
  return Object.freeze({
    concurrency: positiveInteger(
      env.RECONCILE_CONCURRENCY,
      "RECONCILE_CONCURRENCY",
      5
    ),
    scanIntervalMs: positiveInteger(
      env.RECONCILE_SCAN_INTERVAL_MS,
      "RECONCILE_SCAN_INTERVAL_MS",
      5000
    ),
    shopsPerScan: positiveInteger(
      env.RECONCILE_SHOPS_PER_SCAN,
      "RECONCILE_SHOPS_PER_SCAN",
      20
    ),
    productsPerShop: positiveInteger(
      env.RECONCILE_PRODUCTS_PER_SHOP,
      "RECONCILE_PRODUCTS_PER_SHOP",
      5
    ),
    scanLimit: positiveInteger(
      env.RECONCILE_SCAN_LIMIT,
      "RECONCILE_SCAN_LIMIT",
      100
    ),
    maxQueuedJobs: positiveInteger(
      env.RECONCILE_MAX_BACKLOG ?? env.RECONCILE_MAX_QUEUED_JOBS,
      "RECONCILE_MAX_BACKLOG",
      2000
    ),
    shutdownTimeoutMs: positiveInteger(
      env.RECONCILE_SHUTDOWN_TIMEOUT_MS,
      "RECONCILE_SHUTDOWN_TIMEOUT_MS",
      360000
    ),
  });
}
