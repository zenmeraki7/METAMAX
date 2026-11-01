import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
/** Read-only preflight. Uses the configured database; never deploys migrations
 * and never prints connection strings, credentials or merchant row contents. */
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';

let client;
try {
  const file=await readFile(new URL('../.env',import.meta.url),'utf8').catch(error=>{
    if(error.code==='ENOENT')return '';throw error;
  });
  const local=loadMigrationEnvironment();
  const connectionString=process.env.DIRECT_DATABASE_URL||local.DIRECT_DATABASE_URL||process.env.DATABASE_URL||local.DATABASE_URL;
  if(!connectionString)throw Object.assign(new Error('Missing configured database'),{code:'DATABASE_NOT_CONFIGURED'});
  const root=new URL('../prisma/migrations/',import.meta.url);
  const folders=(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&/^\d+_/.test(d.name)).map(d=>d.name).sort();
  const hashes=new Map(await Promise.all(folders.map(async name=>[name,createHash('sha256').update(await readFile(new URL(`${name}/migration.sql`,root))).digest('hex')])));
  client=new pg.Client({connectionString,connectionTimeoutMillis:15000,query_timeout:10000,enableChannelBinding:true});
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10000ms'");
  const database=(await client.query('SELECT current_database() AS name')).rows[0].name;
  const relations=(await client.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND c.relkind IN ('r','p') AND c.relname IN
    ('_prisma_migrations','shops','ingestion_runs','catalog_import_executions','sync_dispatches','sync_dispatch_deliveries','sync_dispatch_schedule','sync_dispatch_shops')
    ORDER BY c.relname`)).rows.map(r=>r.name);
  const history=relations.includes('_prisma_migrations')?(await client.query(`SELECT migration_name,checksum,
    finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back
    FROM mirror._prisma_migrations ORDER BY started_at,id`)).rows:[];
  const columns=(await client.query(`SELECT c.relname AS relation,a.attname AS column,t.typname AS type,a.attnotnull AS required
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='mirror' AND a.attnum>0 AND NOT a.attisdropped
    AND c.relname IN ('sync_dispatches','sync_dispatch_deliveries','sync_dispatch_schedule','sync_dispatch_shops')
    ORDER BY c.relname,a.attnum`)).rows;
  const constraints=(await client.query(`SELECT c.relname AS relation,p.conname AS name,p.convalidated AS validated,
    pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mirror'
    AND c.relname IN ('sync_dispatches','sync_dispatch_deliveries','sync_dispatch_schedule','sync_dispatch_shops')
    ORDER BY c.relname,p.conname`)).rows;
  await client.query('COMMIT');
  const applied=new Set(history.filter(h=>h.finished&&!h.rolled_back).map(h=>h.migration_name));
  console.log(JSON.stringify({database,relations,history:history.map(h=>({...h,checksumMatchesLocal:hashes.get(h.migration_name)===h.checksum})),
    pendingLocalMigrations:folders.filter(f=>!applied.has(f)),columns,constraints},null,2));
} catch(error) {
  console.error(JSON.stringify({inspectionFailed:true,code:error.code||error.name}));process.exitCode=1;
} finally {await client?.end();}
