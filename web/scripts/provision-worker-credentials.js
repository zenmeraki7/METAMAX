/** Explicit infrastructure cutover. Does not run from application imports. */
import {readFile,appendFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
import {verifyRuntimeDatabase} from '../security/runtime-database.server.js';
if(!process.argv.includes('--apply'))throw Error('Explicit --apply required after isolated migration verification');
const envFile=new URL('../.env',import.meta.url),local=dotenv.parse(await readFile(envFile,'utf8'));
const direct=new URL(loadMigrationEnvironment().DIRECT_DATABASE_URL||'');
const application=new URL(local.DATABASE_URL||'');
if(direct.pathname!==application.pathname||!['', '-pooler'].some(suffix=>direct.hostname.replace('.c-',suffix+'.c-')===application.hostname))throw Error('Worker and merchant deployment targets must match');
const owner=new pg.Pool({connectionString:direct.href,max:1,connectionTimeoutMillis:5000,query_timeout:15000});
try{
 if((await owner.query("SELECT 1 FROM mirror._prisma_migrations WHERE migration_name='20261101000500_dispatch_review' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")).rowCount!==1)throw Error('Runtime privilege hardening must be applied first');
 for(const [variable,login,role,profile] of [['CATALOG_WORKER_DATABASE_URL','metamax_catalog_runner','metamax_catalog_worker','catalogWorker'],['OPERATION_WORKER_DATABASE_URL','metamax_operation_runner','metamax_operation_worker','operationWorker']]){
  let url,created=false,checked=false;
  try{
   if(local[variable]){url=new URL(local[variable]);if(decodeURIComponent(url.username)!==login||url.hostname!==application.hostname||url.pathname!==application.pathname)throw Error('Existing worker credential target mismatch');}
   else{
    if((await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[login])).rowCount)throw Error('Worker login exists without configured credentials; no rotation performed');
    const password=randomBytes(32).toString('hex');
    // All identifiers are fixed literals in this reviewed deployment registry.
    await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);created=true;
    await owner.query(`GRANT ${role} TO ${login}`);url=new URL(application);url.username=login;url.password=password;
   }
   const pool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,query_timeout:15000});
   try{await verifyRuntimeDatabase(pool,{profile});}finally{await pool.end();}
   if(created)await appendFile(envFile,`\n${variable}=${url.href}\n`,{mode:0o600});checked=true;
   console.log(JSON.stringify({profile,verified:true,created,credentialsLogged:false}));
  }finally{if(created&&!checked)await owner.query(`ALTER ROLE ${login} NOLOGIN`);}
 }
}catch(error){console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]'));process.exitCode=1;}finally{await owner.end();}
