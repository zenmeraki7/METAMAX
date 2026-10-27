import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const migrationPath = resolve(
  __dirname,
  "../../prisma/migrations/202610260002_catalog_sync/migration.sql"
);

test("migration.sql defines mirror_catalog_runs with exact columns and constraints", () => {
  const sql = readFileSync(migrationPath, "utf8");

  // Table creation
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS mirror_catalog_runs"));
  assert.ok(sql.includes("id UUID PRIMARY KEY DEFAULT gen_random_uuid()"));
  assert.ok(sql.includes("shop_id TEXT NOT NULL"));
  assert.ok(sql.includes("generation_id UUID NOT NULL"));
  assert.ok(sql.includes("state TEXT NOT NULL DEFAULT 'REQUESTED'"));
  assert.ok(sql.includes("bulk_operation_id TEXT"));
  assert.ok(sql.includes("result_url TEXT"));
  assert.ok(sql.includes("expected_objects BIGINT"));
  assert.ok(sql.includes("expected_products BIGINT"));
  assert.ok(sql.includes("imported_products BIGINT NOT NULL DEFAULT 0"));
  assert.ok(sql.includes("imported_variants BIGINT NOT NULL DEFAULT 0"));
  assert.ok(sql.includes("checksum TEXT"));
  assert.ok(sql.includes("error_message TEXT"));
  assert.ok(sql.includes("created_at TIMESTAMPTZ NOT NULL DEFAULT now()"));
  assert.ok(sql.includes("updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"));
  assert.ok(sql.includes("completed_at TIMESTAMPTZ"));

  // Key constraints
  assert.ok(sql.includes("UNIQUE (shop_id, generation_id)"));
  assert.ok(sql.includes("FOREIGN KEY (shop_id, generation_id)"));
  assert.ok(sql.includes("REFERENCES mirror_generations(shop_id, id)"));

  // State check constraint contains all 8 required states
  const requiredStates = [
    "REQUESTED",
    "STARTING",
    "RUNNING",
    "INGESTING",
    "VERIFYING",
    "PUBLISHED",
    "FAILED",
    "NEEDS_REVIEW",
  ];
  for (const st of requiredStates) {
    assert.ok(sql.includes(`'${st}'`));
  }
});

test("migration.sql defines active shop constraint and recovery index excluding STARTING", () => {
  const sql = readFileSync(migrationPath, "utf8");

  // mirror_catalog_active_shop enforces max 1 active rebuild per shop
  assert.ok(sql.includes("INDEX IF NOT EXISTS mirror_catalog_active_shop"));
  assert.ok(sql.includes("ON mirror_catalog_runs(shop_id)"));

  // mirror_catalog_bulk_operation enforces unique bulk op per shop
  assert.ok(sql.includes("INDEX IF NOT EXISTS mirror_catalog_bulk_operation"));
  assert.ok(sql.includes("ON mirror_catalog_runs(shop_id, bulk_operation_id)"));

  // mirror_catalog_pending: STARTING must be excluded from automatic recovery
  assert.ok(sql.includes("INDEX IF NOT EXISTS mirror_catalog_pending"));
  assert.ok(sql.includes("ON mirror_catalog_runs(updated_at)"));

  // Check pending WHERE clause
  const pendingIndexMatch = sql.match(
    /mirror_catalog_pending[\s\S]*?WHERE\s+state\s+IN\s*\(([\s\S]*?)\);/
  );
  assert.ok(pendingIndexMatch, "mirror_catalog_pending index must have WHERE state IN clause");
  const indexedStates = pendingIndexMatch[1];
  assert.ok(indexedStates.includes("'REQUESTED'"));
  assert.ok(indexedStates.includes("'RUNNING'"));
  assert.ok(indexedStates.includes("'INGESTING'"));
  assert.ok(indexedStates.includes("'VERIFYING'"));
  // Invariant: STARTING is deliberately excluded
  assert.ok(
    !indexedStates.includes("'STARTING'"),
    "STARTING must be excluded from mirror_catalog_pending automatic recovery"
  );
});
