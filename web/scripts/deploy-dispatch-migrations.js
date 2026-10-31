/** Deployment for the explicitly authorized dispatch migration chain.
 * Credentials are inherited in child environments, never written or printed.
 * Scratch validation and live deployment use pinned, distinct destinations.
 */
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import {createCatalogPhaseRuntime} from '../services/catalog-phase-runtime.server.js';
import {verifyInstalledFilterSchema} from '../services/filter-schema.server.js';

const mode=process.argv[2];
if(!['clone','test','live','verify-live'].includes(mode))throw new Error('Expected clone, test, live or verify-live');
const project='bitter-dream-29677040',recoveryBranch='br-long-credit-aoc5hnxe';
const liveHost='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech';
const branchHost='ep-falling-pond-aofxlzmy.c-2.ap-southeast-1.aws.neon.tech';
const testName='dispatch_validation_20261029';
const expected=['20261029000200_sync_dispatch_reservations','20261029000300_sync_dispatch_ledger',
  '20261029000400_sync_dispatch_lifecycle','20261029000500_dispatch_consumption_receipts',
  '20261029000600_sync_dispatch_recovery_evidence'];
const web=fileURLToPath(new URL('../',import.meta.url)),audit=new URL('../../.audit/',import.meta.url);
await mkdir(audit,{recursive:true});
const envBytes=await readFile(new URL('../.env',import.meta.url));
const envHash=createHash('sha256').update(envBytes).digest('hex');
const local=dotenv.parse(envBytes);
const live=new URL(process.env.DIRECT_DATABASE_URL||local.DIRECT_DATABASE_URL||'');
if(live.hostname!==liveHost||live.pathname!=='/newmeta_app'||live.hostname.includes('-pooler'))throw new Error('Configured live target changed');
live.searchParams.set('schema','mirror');
const backup=new URL(live);backup.hostname=branchHost;
const test=new URL(backup);test.pathname=`/${testName}`;
const prismaCli=join(process.env.APPDATA,'npm-cache','_npx','51d6e96430f348c4','node_modules','prisma','build','index.js');
const binaries=join(tmpdir(),'metamax-pg18-runtime','pgsql','bin');
const pendingHashes=Object.fromEntries(await Promise.all(expected.map(async name=>[
  name,createHash('sha256').update(await readFile(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url))).digest('hex')])));
const redact=s=>s.replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]');
async function save(name,data){await writeFile(new URL(name,audit),JSON.stringify(data,null,2));}
async function poolFor(url){const p=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:20000,query_timeout:30000});await p.query('SELECT 1');return p;}
async function history(p){
  const rows=(await p.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM mirror._prisma_migrations ORDER BY started_at,id')).rows;
  for(const row of rows){
    if(row.rolled_back_at)continue;
    if(!row.finished_at)throw new Error(`Unfinished migration: ${row.migration_name}`);
    const bytes=await readFile(new URL(`../prisma/migrations/${row.migration_name}/migration.sql`,import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==row.checksum)throw new Error(`Migration checksum mismatch: ${row.migration_name}`);
  }
  return rows.filter(r=>r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name);
}
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function snapshot(p){
  const relations=(await p.query(`SELECT n.nspname AS schema,c.relname AS name,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','mirror')
      AND c.relkind='r' AND c.relname<>'_prisma_migrations' ORDER BY n.nspname,c.relname`)).rows;
  const tables=[];
  for(const table of relations){
    const relation=`${quote(table.schema)}.${quote(table.name)}`;
    const count=(await p.query(`SELECT count(*)::text AS count FROM ${relation}`)).rows[0].count;
    let fingerprint=null;
    if(BigInt(count)<=100000n)fingerprint=(await p.query(`SELECT md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
      FROM(SELECT md5(row_to_json(q)::text) AS h FROM(SELECT ${table.columns.map(quote).join(',')} FROM ${relation}) q) hashes`)).rows[0].hash;
    tables.push({...table,count,fingerprint});
  }
  return tables;
}
async function unchanged(p,tables){
  for(const table of tables){
    const relation=`${quote(table.schema)}.${quote(table.name)}`;
    const count=(await p.query(`SELECT count(*)::text AS count FROM ${relation}`)).rows[0].count;
    if(count!==table.count)throw new Error(`Existing row count changed: ${relation}`);
    if(table.fingerprint!==null){
      const hash=(await p.query(`SELECT md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash
        FROM(SELECT md5(row_to_json(q)::text) AS h FROM(SELECT ${table.columns.map(quote).join(',')} FROM ${relation}) q) hashes`)).rows[0].hash;
      if(hash!==table.fingerprint)throw new Error(`Existing row fingerprint changed: ${relation}`);
    }
  }
}
function execute(executable,args,env){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:web,env:{...process.env,...env},windowsHide:true,shell:false});
    let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('Deployment command deadline exceeded'));},120000);
    child.stdout.on('data',b=>{output+=b.toString();});child.stderr.on('data',b=>{output+=b.toString();});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,output:redact(output)});});
  });
}
async function migrate(url,label){
  const p=await poolFor(url);
  try{
    const applied=await history(p);
    const names=(await readdir(new URL('../prisma/migrations/',import.meta.url),{withFileTypes:true}))
      .filter(d=>d.isDirectory()&&/^\d+_/.test(d.name)).map(d=>d.name).sort();
    const pending=names.filter(n=>!applied.includes(n));
    if(JSON.stringify(pending)!==JSON.stringify(expected))throw new Error(`Unexpected pending migration set for ${label}`);
  }finally{await p.end();}
  const result=await execute(process.execPath,[prismaCli,'migrate','deploy','--config','prisma.config.mjs'],{DIRECT_DATABASE_URL:url.href});
  await writeFile(new URL(`dispatch-deploy-${label}-prisma.txt`,audit),result.output);
  if(result.code!==0)throw new Error(`Prisma deployment failed; inspect dispatch-deploy-${label}-prisma.txt`);
  console.log(`${label}: Prisma migrate deploy succeeded`);
}
async function verify(url,label,before){
  const readonly=new URL(url);readonly.searchParams.set('options','-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000');
  const p=await poolFor(readonly);
  try{
    const migrations=await history(p);for(const name of expected)if(!migrations.includes(name))throw new Error(`Missing ${name}`);
    const runtime=await createCatalogPhaseRuntime({database:p,clientFactory(){throw new Error('External requests prohibited during deployment verification');}});
    await runtime.verifyStorage();
    const filters=await verifyInstalledFilterSchema({database:p});
    if(before)await unchanged(p,before);
    const missing=(await p.query(`SELECT count(*)::text AS count FROM mirror.shops s WHERE NOT EXISTS(
      SELECT 1 FROM mirror.sync_dispatch_schedule schedule WHERE schedule.shop_id=s.id)`)).rows[0].count;
    if(missing!=='0')throw new Error('Shop scheduling backfill incomplete');
    const dup=(await p.query("SELECT to_regclass('mirror.sync_dispatch_deliveries') AS ledger,to_regclass('mirror.sync_dispatch_shops') AS schedule")).rows[0];
    if(dup.ledger||dup.schedule)throw new Error('Duplicate dispatch authority remains');
    const report={label,checkedAt:new Date().toISOString(),database:decodeURIComponent(url.pathname.slice(1)),
      migrations,physicalDispatchSchemaVerified:true,startupVerificationPassed:true,filterFieldsVerified:filters.fieldMappings.length,
      schedulingBackfillVerified:true,existingDataPreserved:!!before,externalRequests:0,workersStarted:false,project,recoveryBranch,pendingHashes};
    await save(`dispatch-deploy-${label}-verification.json`,report);return report;
  }finally{await p.end();}
}
async function clone(){
  const empty=await poolFor(test);
  try{const {rows}=await empty.query("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','mirror')");
    if(rows[0].count!=='0')throw new Error('Scratch database is not empty; refusing overwrite');
  }finally{await empty.end();}
  const source=await poolFor(backup);let before;
  try{before={migrations:await history(source),tables:await snapshot(source)};}finally{await source.end();}
  await save('dispatch-deploy-clone-before.json',before);
  const pgEnv=(url)=>({ ...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),
    PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGSSLMODE:'require',PGCONNECT_TIMEOUT:'20'});
  const dump=spawn(join(binaries,'pg_dump.exe'),['--format=custom','--no-owner','--no-privileges'],{env:pgEnv(backup),windowsHide:true,shell:false});
  const restore=spawn(join(binaries,'pg_restore.exe'),['--no-owner','--no-privileges','--exit-on-error','--dbname',testName],{env:pgEnv(test),windowsHide:true,shell:false});
  let bytes=0,errors='';dump.stdout.on('data',b=>{bytes+=b.length;});dump.stdout.pipe(restore.stdin);
  restore.stdin.on('error',()=>{});dump.stderr.on('data',b=>{errors+=b.toString();});restore.stderr.on('data',b=>{errors+=b.toString();});
  const timer=setTimeout(()=>{dump.kill();restore.kill();},120000);
  const finish=child=>new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  const codes=await Promise.all([finish(dump),finish(restore)]).finally(()=>clearTimeout(timer));
  await writeFile(new URL('dispatch-deploy-clone-log.txt',audit),redact(errors));
  if(codes.some(c=>c!==0))throw new Error('Scratch clone failed; inspect clone log');
  const p=await poolFor(test);try{await unchanged(p,before.tables);await history(p);}finally{await p.end();}
  console.log(JSON.stringify({scratchCloneVerified:true,bytes,originalRecoveryDatabaseUnchanged:true}));
}

try{
  if(mode==='clone')await clone();
  if(mode==='test'){
    const before=JSON.parse(await readFile(new URL('dispatch-deploy-clone-before.json',audit),'utf8'));
    await migrate(test,'test');const report=await verify(test,'test',before.tables);
    const diff=await execute(process.execPath,[prismaCli,'migrate','diff','--from-config-datasource','--to-schema','prisma','--exit-code'],{DIRECT_DATABASE_URL:test.href});
    await writeFile(new URL('dispatch-deploy-test-diff.txt',audit),diff.output);
    if(diff.code!==0)throw new Error('Test database differs from canonical Prisma schema');
    await save('dispatch-deploy-test-approved.json',{...report,canonicalSchemaDiffPassed:true});console.log('Scratch migration, data preservation, startup and schema diff verified');
  }
  if(mode==='live'){
    const approved=JSON.parse(await readFile(new URL('dispatch-deploy-test-approved.json',audit),'utf8'));
    if(!approved.canonicalSchemaDiffPassed||JSON.stringify(approved.pendingHashes)!==JSON.stringify(pendingHashes))throw new Error('Validated migration files changed');
    const p=await poolFor(live);let before;
    try{
      const migrations=await history(p);
      if(expected.some(n=>migrations.includes(n)))throw new Error('Live migration history changed; recheck before deployment');
      const active=(await p.query(`SELECT count(*)::text AS count FROM mirror.catalog_import_executions WHERE completed_at IS NULL
        AND lease_token IS NOT NULL AND lease_until>clock_timestamp()`)).rows[0].count;
      if(active!=='0')throw new Error('Active catalog execution leases require draining before deployment');
      before=await snapshot(p);await save('dispatch-deploy-live-before-tables.json',before);
    }finally{await p.end();}
    await migrate(live,'live');await verify(live,'live',before);
    console.log('Live dispatch migrations and preservation checks passed');
  }
  if(mode==='verify-live'){
    const before=JSON.parse(await readFile(new URL('dispatch-deploy-live-before-tables.json',audit),'utf8'));
    const report=await verify(live,'live',before);
    const diff=await execute(process.execPath,[prismaCli,'migrate','diff','--from-config-datasource','--to-schema','prisma','--exit-code'],{DIRECT_DATABASE_URL:live.href});
    await writeFile(new URL('dispatch-deploy-live-diff.txt',audit),diff.output);
    if(diff.code!==0)throw new Error('Live database differs from canonical Prisma schema');
    const status=await execute(process.execPath,[prismaCli,'migrate','status','--config','prisma.config.mjs'],{DIRECT_DATABASE_URL:live.href});
    await writeFile(new URL('dispatch-deploy-live-status.txt',audit),status.output);
    if(status.code!==0)throw new Error('Live migration status is not current');
    await save('dispatch-deploy-live-verification.json',{...report,canonicalSchemaDiffPassed:true,migrationStatusUpToDate:true});
    console.log('Live dispatch verification, canonical schema diff and migration status passed');
  }
  if(createHash('sha256').update(await readFile(new URL('../.env',import.meta.url))).digest('hex')!==envHash)throw new Error('Application environment changed');
}catch(error){console.error(redact(error.message));process.exitCode=1;}
