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
    await t.test('partial results persist, backfill idempotently and reject uncertain terminal counts',async()=>{
      const tx=await pool.connect();
      try{
        await tx.query('BEGIN');
        const command=(await tx.query("SELECT shop_id,id FROM mirror.job_commands WHERE kind='bulk_edit' ORDER BY id LIMIT 1")).rows[0];assert.ok(command);
        const result={version:1,outcome:'PARTIAL',terminal:true,counts:{total:10,succeeded:9,failed:1,pending:0,uncertain:0,cancelled:0}};
        await tx.query("UPDATE mirror.job_commands SET status='FAILED',result=$3::jsonb WHERE shop_id=$1 AND id=$2",[command.shop_id,command.id,JSON.stringify(result)]);
        const backfill=(await readFile(new URL('20261101000700_backfill_partial_commands/migration.sql',root),'utf8')).split('ALTER TABLE mirror.job_commands')[0];
        await tx.query(backfill);await tx.query(backfill);
        assert.equal((await tx.query('SELECT status FROM mirror.job_commands WHERE shop_id=$1 AND id=$2',[command.shop_id,command.id])).rows[0].status,'PARTIAL');
        result.counts.uncertain=1;
        await assert.rejects(()=>tx.query('UPDATE mirror.job_commands SET result=$3::jsonb WHERE shop_id=$1 AND id=$2',[command.shop_id,command.id,JSON.stringify(result)]),{code:'23514'});
      }finally{await tx.query('ROLLBACK');tx.release();}
    });
    await t.test('outbox event identity is globally unique in the installed schema',async()=>{
      const row=(await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mirror.outbox_events'::regclass AND contype='p'")).rows[0];
      assert.equal(row.definition,'PRIMARY KEY (id)');
    });
  } finally {await pool.end();}
});
