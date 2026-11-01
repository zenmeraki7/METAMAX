/** Explicit infrastructure action. Never logs credentials or rotates a role. */
import {readFile,appendFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import {createTenantDatabaseVerifier} from '../security/tenant-db-adapters.server.js';
import {SOURCE_TABLES} from '../security/repositories/sync-sources.server.js';
import {loadMigrationEnvironment} from '../security/migration-environment.server.js';

const envPath=new URL('../.env',import.meta.url),local=dotenv.parse(await readFile(envPath));
const target=new URL(process.env.DIRECT_DATABASE_URL||loadMigrationEnvironment().DIRECT_DATABASE_URL||'');
if(target.hostname!=='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech'||target.pathname!=='/newmeta_app')throw Error('Configured deployment target changed');
const owner=new pg.Pool({connectionString:target.href,max:1,connectionTimeoutMillis:5000,query_timeout:15000});
const role='metamax_http_reader';let runtime,created=false;
try{
  const migration=(await owner.query("SELECT 1 FROM mirror._prisma_migrations WHERE migration_name='20261031140000_source_read_rls' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")).rowCount;
  if(migration!==1)throw Error('Source RLS migration must be deployed first');
  const existing=(await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount;
  let configured=process.env.TENANT_DATABASE_URL||local.TENANT_DATABASE_URL;
  if(existing&&!configured)throw Error('Reader role exists without configured credentials; refusing password rotation');
  let runtimeUrl;
  if(!existing){
    if(configured)throw Error('Tenant credentials already configured for a different deployment; refusing overwrite');
    const password=randomBytes(32).toString('hex');
    await owner.query(`CREATE ROLE metamax_http_reader LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);created=true;
    await owner.query('GRANT metamax_tenant_reader TO metamax_http_reader');
    runtimeUrl=new URL(local.DATABASE_URL);runtimeUrl.username=role;runtimeUrl.password=password;
  }else runtimeUrl=new URL(configured);
  const expectedPoolHost=target.hostname.replace('.c-','-pooler.c-');
  if(![target.hostname,expectedPoolHost].includes(runtimeUrl.hostname)||runtimeUrl.pathname!==target.pathname||decodeURIComponent(runtimeUrl.username)!==role)
    throw Error('Tenant runtime credential target mismatch');
  runtime=new pg.Pool({connectionString:runtimeUrl.href,max:1,connectionTimeoutMillis:5000,query_timeout:10000});
  const client=await runtime.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await createTenantDatabaseVerifier({tables:SOURCE_TABLES})(client);
    const shop=(await owner.query('SELECT id FROM mirror.shops ORDER BY id LIMIT 1')).rows[0]?.id??'missing-verification-shop.myshopify.com';
    await client.query("SELECT set_config('app.shop_id',$1,true)",[shop]);
    const visible=(await client.query('SELECT id FROM mirror.shops')).rows;
    if(visible.some(row=>row.id!==shop))throw Error('Runtime cross-tenant visibility detected');
    const privileges=(await client.query("SELECT has_table_privilege(current_user,'mirror.products','SELECT') AS products,has_table_privilege(current_user,'mirror.shops','UPDATE') AS mutation")).rows[0];
    if(privileges.products||privileges.mutation)throw Error('Reader has permissions outside its source-read profile');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  if(created)await appendFile(envPath,`\n# Restricted gateway source-read connection; owner URL remains infrastructure-only.\nTENANT_DATABASE_URL=${runtimeUrl.href}\n`);
  await mkdir(new URL('../../.audit/',import.meta.url),{recursive:true});
  const report={role,database:'newmeta_app',profile:'source-read-only',created,credentialsLogged:false,verifiedTables:SOURCE_TABLES,restrictedRoleVerified:true,rlsVerified:true,environmentConfigured:true};
  await writeFile(new URL('../../.audit/tenant-reader-production.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){
  if(created)await owner.query('ALTER ROLE metamax_http_reader NOLOGIN').catch(()=>{});
  console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]'));process.exitCode=1;
}finally{await runtime?.end();await owner.end();}
