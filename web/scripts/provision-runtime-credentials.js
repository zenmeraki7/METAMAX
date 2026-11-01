/** One-time, explicit deployment action. Passwords never enter tool output. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import {PostgreSQLSessionStorage} from '@shopify/shopify-app-session-storage-postgresql';
import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
import {verifyRuntimeDatabase} from '../security/runtime-database.server.js';

const envFile=new URL('../.env',import.meta.url),text=await readFile(envFile,'utf8'),local=dotenv.parse(text),migrationEnv=loadMigrationEnvironment();
const direct=new URL(process.env.DIRECT_DATABASE_URL||migrationEnv.DIRECT_DATABASE_URL||'');
if(direct.hostname!=='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech'||direct.pathname!=='/newmeta_app')throw Error('Deployment target changed');
const owner=new pg.Pool({connectionString:direct.href,max:1,connectionTimeoutMillis:5000,query_timeout:15000});
const created=[];let engine,storage,cutover=false;
try{
  if((await owner.query("SELECT 1 FROM mirror._prisma_migrations WHERE migration_name='20261101000500_dispatch_review' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")).rowCount!==1)
    throw Error('Runtime privilege hardening must be deployed first');
  const roles=['metamax_app_runtime','metamax_shopify_sessions'];
  const exists=(await owner.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows;
  if(exists.length)throw Error('Runtime login already exists; refusing to rotate or overwrite credentials');
  const enginePassword=randomBytes(32).toString('hex'),sessionPassword=randomBytes(32).toString('hex');
  await owner.query(`CREATE ROLE metamax_app_runtime LOGIN PASSWORD '${enginePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);created.push(roles[0]);
  await owner.query('GRANT metamax_engine_runtime TO metamax_app_runtime');
  await owner.query(`CREATE ROLE metamax_shopify_sessions LOGIN PASSWORD '${sessionPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);created.push(roles[1]);
  // The official SDK initializes existing tables with CREATE IF NOT EXISTS.
  // This compatibility privilege belongs only to the session infrastructure
  // login, never to application repositories or the tenant gateway.
  await owner.query('GRANT USAGE,CREATE ON SCHEMA public TO metamax_shopify_sessions');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.shopify_sessions TO metamax_shopify_sessions');
  await owner.query('GRANT SELECT ON public.shopify_sessions_migrations TO metamax_shopify_sessions');
  const engineUrl=new URL(local.DATABASE_URL);engineUrl.username=roles[0];engineUrl.password=enginePassword;
  const sessionUrl=new URL(local.DATABASE_URL);sessionUrl.username=roles[1];sessionUrl.password=sessionPassword;
  engine=new pg.Pool({connectionString:engineUrl.href,max:1,connectionTimeoutMillis:5000,query_timeout:15000});
  const report=await verifyRuntimeDatabase(engine);
  // The installed SDK rebuilds its pg configuration and drops URL SSL flags.
  process.env.PGSSLMODE='require';
  storage=new PostgreSQLSessionStorage(sessionUrl.href);await storage.ready;
  // Read through the official adapter. No existing session is modified.
  await storage.loadSession('metamax-runtime-deployment-nonexistent-session');
  const sessionRole=(await owner.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname='metamax_shopify_sessions'`)).rows[0];
  if(!sessionRole||[sessionRole.rolsuper,sessionRole.rolbypassrls,sessionRole.rolcreaterole,sessionRole.rolcreatedb].some(Boolean))throw Error('Unsafe session login');
  const privateFile=new URL('../.env.migrations',import.meta.url);
  let privateText='';try{privateText=await readFile(privateFile,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const privateValues=dotenv.parse(privateText);
  if(privateValues.DIRECT_DATABASE_URL&&privateValues.DIRECT_DATABASE_URL!==direct.href)throw Error('Private migration credential already points elsewhere');
  if(!privateValues.DIRECT_DATABASE_URL)await writeFile(privateFile,privateText+`\n# Migration CLI only; not loaded by the application.\nDIRECT_DATABASE_URL=${direct.href}\n`,{mode:0o600});
  let next=text.replace(/^DIRECT_DATABASE_URL=.*(?:\r?\n|$)/gm,'').replace(/^DATABASE_URL=.*$/m,`DATABASE_URL=${engineUrl.href}`);
  if(/^SHOPIFY_SESSION_DATABASE_URL=/m.test(next))throw Error('Session URL already configured; refusing overwrite');
  next+=`\n# Dedicated official Shopify session-storage infrastructure.\nSHOPIFY_SESSION_DATABASE_URL=${sessionUrl.href}\n`;
  await writeFile(envFile,next,{mode:0o600});
  cutover=true;
  await mkdir(new URL('../../.audit/',import.meta.url),{recursive:true});
  const verification={...report,sessionRole:sessionRole.rolname,sessionSdkVerified:true,credentialsLogged:false,migrationCredentialSeparated:true,environmentUpdated:true};
  await writeFile(new URL('../../.audit/runtime-production-credentials.json',import.meta.url),JSON.stringify(verification,null,2));
  console.log(JSON.stringify(verification));
}catch(error){
  if(!cutover)for(const role of created)await owner.query(`ALTER ROLE ${role} NOLOGIN`).catch(()=>{});
  console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]'));process.exitCode=1;
}finally{await storage?.disconnect().catch(()=>{});await engine?.end();await owner.end();}
