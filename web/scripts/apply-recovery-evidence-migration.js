import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
// Complete the reviewed pending migration needed by the installed runtime.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import {createCatalogPhaseRuntime} from '../services/catalog-phase-runtime.server.js';
const mode=process.argv[2];
if(!['--scratch-only','--live'].includes(mode))throw Error('Explicit --scratch-only or --live mode required');
const bytes=await readFile(new URL('../.env',import.meta.url));
const env=loadMigrationEnvironment(),live=new URL(env.DIRECT_DATABASE_URL);
if(live.hostname!=='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech'||live.pathname!=='/newmeta_app')throw Error('Live target changed');
const stage=new URL(live);stage.hostname='ep-falling-pond-aofxlzmy.c-2.ap-southeast-1.aws.neon.tech';stage.pathname='/dispatch_validation_20261029';
const expected='20261029000600_sync_dispatch_recovery_evidence';
const cli=join(process.env.APPDATA,'npm-cache','_npx','51d6e96430f348c4','node_modules/prisma/build/index.js');
const hash=b=>createHash('sha256').update(b).digest('hex');
const migrationHash=hash(await readFile(new URL(`../prisma/migrations/${expected}/migration.sql`,import.meta.url)));
const names=(await readdir(new URL('../prisma/migrations/',import.meta.url),{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function fingerprint(p){
  const rows=(await p.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname IN ('public','mirror') AND c.relname NOT IN ('_prisma_migrations','sync_dispatch_recovery_evidence') ORDER BY 1,2`)).rows;
  const result=[];
  for(const r of rows){
    const f=(await p.query(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM
      (SELECT md5(row_to_json(t)::text) AS h FROM ${quote(r.schema)}.${quote(r.name)} t) hashes`)).rows[0];
    result.push({...r,...f});
  }
  return result;
}
function command(url,args){
  const r=spawnSync(process.execPath,[cli,...args],{cwd:new URL('../',import.meta.url),env:{...process.env,DIRECT_DATABASE_URL:url.href},
    windowsHide:true,encoding:'utf8',timeout:120000});
  const output=((r.stdout||'')+(r.stderr||'')).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]');
  if(r.error||r.status!==0)throw Error(`Prisma command failed: ${output.slice(-2500)}`);
  return output;
}
async function deploy(url,label){
  const p=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:20000,query_timeout:30000});
  try{
    const history=(await p.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM mirror._prisma_migrations ORDER BY started_at')).rows;
    for(const row of history){
      if(row.rolled_back_at)continue;
      if(!row.finished_at||hash(await readFile(new URL(`../prisma/migrations/${row.migration_name}/migration.sql`,import.meta.url)))!==row.checksum)throw Error('Migration history mismatch');
    }
    const applied=history.filter(r=>r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name);
    const pending=names.filter(n=>!applied.includes(n));
    if(JSON.stringify(pending)!==JSON.stringify([expected])&&!(label==='scratch'&&pending.length===0))throw Error(`Unexpected pending migrations on ${label}`);
    if((await p.query("SELECT 1 FROM mirror.catalog_import_executions WHERE completed_at IS NULL AND lease_token IS NOT NULL AND lease_until>clock_timestamp() LIMIT 1")).rowCount)throw Error('Active execution must drain');
    const before=await fingerprint(p);
    if(hash(await readFile(new URL(`../prisma/migrations/${expected}/migration.sql`,import.meta.url)))!==migrationHash)throw Error('Migration changed after validation');
    const log=command(url,['migrate','deploy','--config','prisma.config.mjs']);
    await writeFile(new URL(`../../.audit/recovery-evidence-${label}-migration.txt`,import.meta.url),log);
    const diff=command(url,['migrate','diff','--from-config-datasource','--to-schema','prisma','--exit-code']);
    const runtime=await createCatalogPhaseRuntime({database:p,clientFactory(){throw Error('External requests prohibited during verification');}});
    await runtime.verifyStorage();
    if(JSON.stringify(before)!==JSON.stringify(await fingerprint(p)))throw Error('Existing data changed');
    const installed=(await p.query('SELECT checksum,finished_at FROM mirror._prisma_migrations WHERE migration_name=$1',[expected])).rows[0];
    if(!installed?.finished_at||installed.checksum!==migrationHash)throw Error('Migration completion not confirmed');
    await writeFile(new URL(`../../.audit/recovery-evidence-${label}-verification.json`,import.meta.url),JSON.stringify({label,database:url.pathname.slice(1),migration:expected,migrationHash,verifiedAt:new Date().toISOString(),existingTablesPreserved:before.length,storageVerified:true,diff,before},null,2));
    console.log(`${label}: migration, canonical schema, runtime storage and existing data verified`);
  }finally{await p.end();}
}
try{
  await deploy(stage,'scratch');
  if(mode==='--live')await deploy(live,'live');
  if(hash(bytes)!==hash(await readFile(new URL('../.env',import.meta.url))))throw Error('Environment changed');
}catch(error){console.error(error.message);process.exitCode=1;}
