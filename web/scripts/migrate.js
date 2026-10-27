import "../env.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = new URL(
  process.env.DIRECT_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL
);
// Migrations require a direct connection; application requests keep pooling.
if (url.hostname.endsWith(".neon.tech"))
  url.hostname = url.hostname.replace("-pooler.", ".");
function migrate(...args) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/prisma/build/index.js", import.meta.url)
      ),
      "migrate",
      ...args,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: "inherit",
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Prisma migration command failed (${result.status})`);
}

const client = new pg.Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 5000,
});
await client.connect();
try {
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'"
  );
  const tables = rows.map((row) => row.tablename);
  const allowed = new Set([
    "shopify_sessions",
    "shopify_sessions_migrations",
    "_prisma_migrations",
  ]);
  const history = tables.includes("_prisma_migrations")
    ? (
        await client.query(
          'SELECT count(*)::int AS count FROM "_prisma_migrations"'
        )
      ).rows[0].count
    : 0;
  if (history === 0 && tables.includes("shopify_sessions")) {
    if (tables.some((table) => !allowed.has(table))) {
      throw new Error(
        "Unrecognized existing schema. Review and baseline it before running migrations."
      );
    }
    migrate("resolve", "--applied", "202610250000_sessions_baseline");
  }
} finally {
  await client.end();
}
migrate("deploy");
