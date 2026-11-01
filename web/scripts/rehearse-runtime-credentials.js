/** Pinned disposable Neon branch only; no environment file is changed. */
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {PostgreSQLSessionStorage} from '@shopify/shopify-app-session-storage-postgresql';
import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
import {verifyRuntimeDatabase,createVerifiedRuntimePool} from '../security/runtime-database.server.js';
const url=new URL(loadMigrationEnvironment().DIRECT_DATABASE_URL);
url.hostname='ep-holy-feather-aojfs2c6.c-2.ap-southeast-1.aws.neon.tech';
if(url.pathname!=='/newmeta_app')throw Error('Unexpected rehearsal database');
const owner=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000,query_timeout:15000});
let engine,storage;
try{
  const password=randomBytes(32).toString('hex');
  if(!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='metamax_app_rehearsal'")).rowCount)await owner.query('CREATE ROLE metamax_app_rehearsal NOLOGIN');
  await owner.query(`ALTER ROLE metamax_app_rehearsal LOGIN PASSWORD '${password}'`);
  await owner.query('GRANT metamax_engine_runtime TO metamax_app_rehearsal');
  if(!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='metamax_session_rehearsal'")).rowCount)await owner.query('CREATE ROLE metamax_session_rehearsal NOLOGIN');
  await owner.query(`ALTER ROLE metamax_session_rehearsal LOGIN PASSWORD '${password}'`);
  await owner.query('GRANT USAGE,CREATE ON SCHEMA public TO metamax_session_rehearsal');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.shopify_sessions TO metamax_session_rehearsal');
  await owner.query('GRANT SELECT ON public.shopify_sessions_migrations TO metamax_session_rehearsal');
  const appUrl=new URL(url);appUrl.username='metamax_app_rehearsal';appUrl.password=password;
  engine=new pg.Pool({connectionString:appUrl.href,max:1,connectionTimeoutMillis:10000,query_timeout:15000});
  const verification=await verifyRuntimeDatabase(engine),audited=createVerifiedRuntimePool(engine);
  if((await audited.query('SELECT shop_id FROM mirror.products')).rowCount!==0)throw Error('Unscoped runtime leaked catalog rows');
  const handle=await audited.connect();handle.release();
  let denied=false;try{await handle.query('SELECT 1');}catch{denied=true;}
  if(!denied)throw Error('Released runtime handle remains usable');
  const sessionUrl=new URL(url);sessionUrl.username='metamax_session_rehearsal';sessionUrl.password=password;
  process.env.PGSSLMODE='require';storage=new PostgreSQLSessionStorage(sessionUrl.href);await storage.ready;
  await storage.loadSession('nonexistent-runtime-rehearsal-session');
  const report={branch:'br-fancy-block-aoigs917',database:'newmeta_app',...verification,unscopedCatalogDenied:true,releasedHandleDenied:true,officialSessionSdkVerified:true,liveEnvironmentChanged:false};
  await mkdir(new URL('../../.audit/',import.meta.url),{recursive:true});await writeFile(new URL('../../.audit/runtime-branch-rehearsal.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]'));process.exitCode=1;}
finally{
  await storage?.disconnect().catch(()=>{});await engine?.end();
  await owner.query('ALTER ROLE metamax_app_rehearsal NOLOGIN').catch(()=>{});await owner.query('ALTER ROLE metamax_session_rehearsal NOLOGIN').catch(()=>{});await owner.end();
}
