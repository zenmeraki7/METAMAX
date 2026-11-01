/** Real LOGIN profiles for disposable PostgreSQL integration tests only. */
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createVerifiedRuntimePool} from '../runtime-database.server.js';
export async function createRestrictedRuntimeProfiles(admin,connectionString){
 const base=new URL(connectionString);if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('Disposable local PostgreSQL fixture required');
 const pools=[],logins=[],profiles={};
 try{
  for(const [profile,role] of [['merchant','metamax_engine_runtime'],['operationWorker','metamax_operation_worker'],['catalogWorker','metamax_catalog_worker']]){
   const login='fixture_'+randomUUID().replaceAll('-',''),password=randomUUID();
   await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);logins.push(login);
   await admin.query(`GRANT ${role} TO ${login}`);
   const url=new URL(base);url.username=login;url.password=password;
   const pool=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:5000,query_timeout:15000});pools.push(pool);
   profiles[profile]=createVerifiedRuntimePool(pool,{profile});await profiles[profile].query('SELECT 1');
  }
 }catch(error){await Promise.all(pools.map(pool=>pool.end()));for(const login of logins){await admin.query(`DROP OWNED BY ${login}`);await admin.query(`DROP ROLE ${login}`);}throw error;}
 return {...profiles,async close(){await Promise.all(pools.map(pool=>pool.end()));for(const login of logins){await admin.query(`DROP OWNED BY ${login}`);await admin.query(`DROP ROLE ${login}`);}}};
}
