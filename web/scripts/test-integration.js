import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const path = fileURLToPath(new URL("../.env.integration", import.meta.url));
const parsed = config({ path, override: true }).parsed;
if (!parsed?.DATABASE_URL)
  throw new Error(
    "Configure a disposable Neon test branch in web/.env.integration",
  );
// Require an explicit separate URL, never silently fall back to the app database.
const production = config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
}).parsed;
if (
  new URL(parsed.DATABASE_URL).hostname ===
  new URL(production.DATABASE_URL).hostname
) {
  throw new Error(
    "Integration tests must use a different database branch than the app",
  );
}
const defaultTests = [
  "tests/foundation-env.test.js",
  "tests/fields/fields.test.js",
  "tests/fields/type-validation.test.js",
  "tests/fields/sources-resolver.test.js",
  "tests/fields/capabilities-operations.test.js",
  "tests/fields/dynamic-coverage.test.js",
  "tests/fields/dynamic-validation.test.js",
  "tests/fields/metafield-contracts.test.js",
  "tests/query/compiler.test.js",
  "tests/bulk-query-coordinator.test.js",
  "tests/webhooks.test.js",
  "tests/webhook-boundary.test.js",
  "tests/operations.test.js",
  "tests/installation.test.js",
  "tests/install-dispatch.test.js",
  "tests/products.test.js",
  "tests/inventory.test.js",
  "tests/inventory-integration.test.js",
  "tests/inventory-reconciliation.test.js",
  "tests/reconciliation.test.js",
  "tests/reconciliation-guarantees.integration.test.js",
  "tests/scanner.test.js",
  "tests/snapshots.test.js",
  "tests/sync-changes.test.js",
  "tests/publish-run.test.js",
  "tests/bulk-importer.test.js",
  "tests/batched-staging.test.js",
  "tests/automatic-import.test.js",
  "tests/integrity-initial-sync.test.js",
  "tests/background-consumers.test.js",
  "tests/products-catalog.test.js",
];
const requestedTests = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--import",
    "./tests/setup.js",
    "--test-concurrency=1",
    ...(requestedTests.length ? requestedTests : defaultTests),
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      RUN_INTEGRATION_TESTS: "1",
      QUEUE_PREFIX: `newmeta-test-${randomUUID()}`,
    },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
