/** Read-only deployment check. Never prints connection strings or raw errors. */
import 'dotenv/config';
import pg from 'pg';
import { inspectHistoryDatabasePrivileges } from '../edit-history/database-security.server.js';
const profile=process.argv[2]??'runtime';
const variable={runtime:'HISTORY_DATABASE_URL',maintenance:'HISTORY_MAINTENANCE_DATABASE_URL',privacy:'HISTORY_PRIVACY_DATABASE_URL'}[profile];
if(!variable||process.argv.length>3){console.error('Usage: node scripts/verify-history-security.js runtime|maintenance|privacy');process.exitCode=1;}
else if(!process.env[variable]){console.error(JSON.stringify({verified:false,profile,configurationRequired:variable}));process.exitCode=1;}
else{
 const pool=new pg.Pool({connectionString:process.env[variable],max:1,connectionTimeoutMillis:10000,query_timeout:15000});
 try{const client=await pool.connect();try{await client.query("SET statement_timeout='15000ms'");
  const authorityRelations=process.env.HISTORY_AUTHORITY_RELATIONS_JSON?JSON.parse(process.env.HISTORY_AUTHORITY_RELATIONS_JSON):[];
  const report=await inspectHistoryDatabasePrivileges(client,{profile,authorityRelations});console.log(JSON.stringify(report));if(!report.verified)process.exitCode=1;
 }finally{client.release();}}catch{console.error(JSON.stringify({verified:false,profile,error:'HISTORY_DATABASE_VERIFICATION_FAILED'}));process.exitCode=1;}
 finally{await pool.end();}
}
