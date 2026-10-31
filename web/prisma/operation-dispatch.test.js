/** Isolated PostgreSQL migration and operation identity/selection integration. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { testSelection } from "../mirror/integration/selection.js";

test("operation dispatch migration and concurrent bulk/undo authorization", async t => {
  assert.equal(process.env.FILTER_TEST_DATABASE_ISOLATED,"1");
  const target = new URL(process.env.FILTER_TEST_DATABASE_URL);
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(target.hostname));
  assert.equal(target.pathname,"/metamax_filter_test");
  const pool = new pg.Pool({connectionString:target.href});
  try {
    const root = new URL("./migrations/",import.meta.url);
    const directories=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^\d+_/.test(entry.name)).map(entry=>entry.name).sort();
    for(const directory of directories) await pool.query(await readFile(new URL(`${directory}/migration.sql`,root),"utf8"));
    await testSelection(t,pool);
  } finally {await pool.end();}
});
