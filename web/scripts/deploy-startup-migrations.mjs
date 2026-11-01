/** Operator-only migration deployment. Never imported by the app.
 * Input: rehearse|apply and the existing migration-only environment.
 * Output: credential-free audit reports. Authority: migration owner on the
 * pinned development database. Preconditions: matching migration checksums,
 * completed lineage, successful exact-clone rehearsal before apply.
 * Side effects: local backup/test container; apply installs reviewed migrations.
 * Each migration's transaction belongs to Prisma/the migration file. A lost
 * response is not automatically retried; inspect the durable ledger first.
 */
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import pg from 'pg';
import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
import {verifyRuntimeDatabase,readDatabaseSecurityState} from '../security/runtime-database.server.js';
const mode=process.argv[2];if(!['rehearse','apply'].includes(mode))throw Error('Expected rehearse or apply');
const web=fileURLToPath(new URL('../',import.meta.url));
const audit=fileURLToPath(new URL('../../.audit/startup-repair/',import.meta.url));await mkdir(audit,{recursive:true});
const live=new URL(loadMigrationEnvironment().DIRECT_DATABASE_URL);
if(live.hostname!=='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech'||live.pathname!=='/newmeta_app')throw Error('Unexpected deployment target');
const prisma=join(process.env.APPDATA,'npm-cache/_npx/51d6e96430f348c4/node_modules/prisma/build/index.js');
const hash=b=>createHash('sha256').update(b).digest('hex');
const files=Object.fromEntries(await Promise.all((await readdir(join(web,'prisma/migrations'),{withFileTypes:true})).filter(x=>x.isDirectory()).map(async x=>[x.name,hash(await readFile(join(web,'prisma/migrations',x.name,'migration.sql')))])));
const redact=s=>String(s).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]');
function run(exe,args,{env={},input,log}={}){const r=spawnSync(exe,args,{cwd:web,env:{...process.env,...env},input,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,timeout:180000});const out=redact((r.stdout||'')+(r.stderr||''));if(log) return writeFile(join(audit,log),out).then(()=>{if(r.error||r.status!==0)throw Error(out.slice(-5000)||r.error?.message);return out;});if(r.error||r.status!==0)throw Error(out.slice(-5000)||r.error?.message);return r.stdout||'';}
const pool=url=>new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:15000,query_timeout:30000});
async function history(p){const rows=(await p.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM mirror._prisma_migrations ORDER BY migration_name')).rows.filter(r=>!r.rolled_back_at);for(const r of rows)if(!r.finished_at||files[r.migration_name]!==r.checksum)throw Error('Unfinished or changed migration '+r.migration_name);return rows.map(r=>r.migration_name);}
async function counts(p){return (await p.query('SELECT (SELECT count(*)::text FROM mirror.products) products,(SELECT count(*)::text FROM mirror.variants) variants,(SELECT count(*)::text FROM mirror.shops) shops')).rows[0];}
async function migrate(url,label){const u=new URL(url);u.searchParams.set('schema','mirror');await run(process.execPath,[prisma,'migrate','deploy','--config','prisma.config.mjs'],{env:{DIRECT_DATABASE_URL:u.href},log:label+'-migrate.log'});}
async function profiles(p,base){const results={};for(const [name,role] of [['merchant','metamax_engine_runtime'],['catalogWorker','metamax_catalog_worker'],['operationWorker','metamax_operation_worker']]){const login='startup_check_'+name.toLowerCase(),password=randomBytes(24).toString('hex');await p.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}'`);await p.query(`GRANT ${role} TO ${login}`);const url=new URL(base);url.username=login;url.password=password;const restricted=pool(url);try{const state=await readDatabaseSecurityState(restricted);await writeFile(join(audit,'rehearsal-'+name+'-security.json'),JSON.stringify(state,null,2));results[name]=await verifyRuntimeDatabase(restricted,{profile:name});}catch(e){throw Error(name+': '+e.message);}finally{await restricted.end();}}return results;}
let container;
const owner=pool(live);
try{
 const before=await history(owner),pending=Object.keys(files).filter(n=>!before.includes(n)).sort();
 console.log(JSON.stringify({mode,pending}));
 if(mode==='rehearse'){
  const password=randomBytes(24).toString('hex');
  container=run('docker',['run','--detach','--rm','--memory','512m','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=newmeta_app','postgres:18-alpine'],{env:{POSTGRES_PASSWORD:password}}).trim();
  if(!/^[a-f0-9]{64}$/.test(container))throw Error('Invalid disposable container');
  const port=run('docker',['port',container,'5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];if(!port)throw Error('Invalid test port');
  const local=new URL('postgresql://postgres:'+password+'@127.0.0.1:'+port+'/newmeta_app');const test=pool(local);
  try{
   let ready=false;for(let i=0;i<30;i++){try{await test.query('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}if(!ready)throw Error('PostgreSQL not ready');
   const roles=(await owner.query("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname<>'postgres' ORDER BY rolname")).rows;
   for(const {rolname} of roles)await test.query('CREATE ROLE "'+rolname.replaceAll('"','""')+'" NOLOGIN');
   console.log('Backing up configured development database');
   run('docker',['exec','--env','PGPASSWORD',container,'pg_dump','--format=custom','--no-owner','--host',live.hostname,'--username',decodeURIComponent(live.username),'--dbname','newmeta_app','--file','/tmp/startup-before.dump'],{env:{PGPASSWORD:decodeURIComponent(live.password)}});
   run('docker',['cp',container+':/tmp/startup-before.dump',join(audit,'live-before.dump')]);
   run('docker',['exec',container,'pg_restore','--no-owner','--exit-on-error','--username=postgres','--dbname=newmeta_app','/tmp/startup-before.dump']);
   const baseline=await counts(test);await history(test);
   await migrate(local,'rehearsal');
   const after=await history(test);if(after.length!==Object.keys(files).length)throw Error('Pending migrations remain');
   const verified=await profiles(test,local);const final=await counts(test);if(JSON.stringify(baseline)!==JSON.stringify(final))throw Error('Catalog or shop row counts changed');
   const report={passed:true,before,pending,files,baseline,after,verified,applicationDatabaseChanged:false};await writeFile(join(audit,'rehearsal.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({rehearsalPassed:true,migrations:after.length,profiles:Object.keys(verified),preserved:final}));
  }finally{await test.end();}
 }else{
  const report=JSON.parse(await readFile(join(audit,'rehearsal.json'),'utf8'));
  if(!report.passed||JSON.stringify(report.files)!==JSON.stringify(files)||JSON.stringify(report.before)!==JSON.stringify(before))throw Error('Rehearsed files or live lineage changed');
  const leases=(await owner.query('SELECT count(*)::int AS n FROM mirror.catalog_import_executions WHERE completed_at IS NULL AND lease_token IS NOT NULL AND lease_until>clock_timestamp()')).rows[0].n;if(leases)throw Error('Active catalog workers must drain');
  const baseline=await counts(owner);await writeFile(join(audit,'live-before.json'),JSON.stringify({before,pending,baseline},null,2));
  await migrate(live,'live');const after=await history(owner);const verified={pendingCredentialProvisioning:true},final=await counts(owner);
  if(JSON.stringify(baseline)!==JSON.stringify(final))throw Error('Catalog or shop row counts changed');
  await writeFile(join(audit,'live-verification.json'),JSON.stringify({after,verified,preserved:final},null,2));console.log(JSON.stringify({deployed:true,migrations:after.length,profiles:Object.keys(verified),preserved:final}));
 }
}catch(e){console.error(redact(e.message));process.exitCode=1;}finally{await owner.end();if(container)run('docker',['rm','--force',container]);}
