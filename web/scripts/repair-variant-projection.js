import "../env.js";
import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Controlled replacement for the backfill in already-applied migration 008.
// Audit the entire snapshot before writing anything. Never infer ingestion
// completeness or publish a snapshot from a successful projection repair.
export async function repairVariantProjection(client, { shop, runId, apply = false }) {
  await client.query("BEGIN");
  try {
    const merchant = (await client.query(
      'SELECT "status", "generation" FROM "Shop" WHERE "domain"=$1 FOR UPDATE', [shop]
    )).rows[0];
    const run = (await client.query(
      'SELECT "shop", "generation" FROM "SnapshotRun" WHERE "id"=$1 FOR UPDATE', [runId]
    )).rows[0];
    if (!merchant || merchant.status !== "ACTIVE" || run?.shop !== shop || run.generation !== merchant.generation)
      throw Error("An active installation and matching snapshot generation are required");

    // A transaction-local table avoids re-reading changing JSON between audit
    // and insert, and keeps repeated IDs visible to the diagnostics.
    await client.query(`CREATE TEMP TABLE variant_repair_candidates ON COMMIT DROP AS
      SELECT p."runId" AS "snapshotId", p."productId", v.data->>'id' AS id,
        COALESCE(NULLIF(v.data->>'inventoryItemId',''), NULLIF(v.data#>>'{inventoryItem,id}','')) AS "inventoryItemId",
        jsonb_typeof(v.data)='object' AND NULLIF(v.data->>'id','') IS NOT NULL AS valid
      FROM "SnapshotProduct" p CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.data->'variants')='array' THEN p.data->'variants' ELSE '[]'::jsonb END
      ) AS v(data) WHERE p."runId"=$1`, [runId]);
    const report = (await client.query(`SELECT
      (SELECT COUNT(*)::int FROM "SnapshotProduct" WHERE "runId"=$1
        AND jsonb_typeof(data->'variants') IS DISTINCT FROM 'array') AS "malformedProducts",
      (SELECT COUNT(*)::int FROM variant_repair_candidates WHERE valid IS NOT TRUE) AS "invalidVariants",
      (SELECT COUNT(*)::int FROM (SELECT id FROM variant_repair_candidates WHERE valid GROUP BY id HAVING COUNT(*)>1) d) AS "duplicateIds",
      (SELECT COUNT(*)::int FROM variant_repair_candidates c JOIN "Variant" v
        ON v.shop=$2 AND v."snapshotId"=c."snapshotId" AND v.id=c.id
        WHERE c.valid AND (v."productId" IS DISTINCT FROM c."productId"
          OR v."inventoryItemId" IS DISTINCT FROM c."inventoryItemId")) AS "conflictingRows"`, [runId, shop])).rows[0];
    const needsReconciliation = Object.values(report).some((value) => value > 0);
    let inserted = 0;
    if (apply && !needsReconciliation) {
      const result = await client.query(`INSERT INTO "Variant" (shop,"snapshotId",id,"productId","inventoryItemId")
        SELECT $1,"snapshotId",id,"productId","inventoryItemId" FROM variant_repair_candidates WHERE valid
        ON CONFLICT (shop,"snapshotId",id) DO NOTHING`, [shop]);
      inserted = result.rowCount;
    }
    await client.query(apply && !needsReconciliation ? "COMMIT" : "ROLLBACK");
    return { status: needsReconciliation ? "needs_reconciliation" : apply ? "repaired" : "audited", ...report, inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((arg) => arg !== "--apply");
  if (positional.length !== 2 || positional.some((arg) => arg.startsWith("--")))
    throw Error("Usage: node scripts/repair-variant-projection.js <shop> <snapshot-id> [--apply]");
  const url = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace("-pooler.", ".");
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const report = await repairVariantProjection(client, { shop: positional[0], runId: positional[1], apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "needs_reconciliation") process.exitCode = 2;
  } finally {
    await client.end();
  }
}
