import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
/** Deploy only the explicitly authorized refresh migration. No credentials are logged. */
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const migration='20261031130000_reopen_verified_staging';
const mode=process.argv[2];
if(!['rehearse','apply','verify'].includes(mode))throw Error('Expected rehearse, apply, or verify');
const web=fileURLToPath(new URL('../',import.meta.url));
const audit=resolve(web,'../.audit/reopen-staging-20261031');
const local=loadMigrationEnvironment();
const target=new URL(process.env.DIRECT_DATABASE_URL||local.DIRECT_DATABASE_URL||'');
if(target.hostname!=='ep-odd-surf-aoil4uxa.c-2.ap-southeast-1.aws.neon.tech'||target.pathname!=='/newmeta_app')throw Error('Configured database target changed');
target.searchParams.set('schema','mirror');
const sql=await readFile(join(web,'prisma/migrations',migration,'migration.sql'),'utf8');
const checksum=createHash('sha256').update(sql).digest('hex');
const pool=new pg.Pool({connectionString:target.href,max:1,connectionTimeoutMillis:15000,query_timeout:30000});
const redact=value=>value.replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[REDACTED_DATABASE_URL]');
await mkdir(audit,{recursive:true});

async function history() {
  const rows=(await pool.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM mirror._prisma_migrations ORDER BY started_at,id')).rows;
  const applied=[];
  for(const row of rows){
    if(row.rolled_back_at)continue;
    if(!row.finished_at)throw Error(`Unfinished migration: ${row.migration_name}`);
    const bytes=await readFile(join(web,'prisma/migrations',row.migration_name,'migration.sql'));
    if(createHash('sha256').update(bytes).digest('hex')!==row.checksum)throw Error(`Migration checksum mismatch: ${row.migration_name}`);
    applied.push(row.migration_name);
  }
  return applied;
}
async function inspect(client=pool) {
  const body=sql.slice(sql.indexOf('$$')+2,sql.lastIndexOf('$$')).trim();
  const row=(await client.query("SELECT prosrc FROM pg_proc WHERE oid='mirror.guard_generation_status()'::regprocedure")).rows[0];
  if(row?.prosrc.trim()!==body)throw Error('Guard body differs from requested migration');
  const triggers=(await client.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='mirror.generations'::regclass AND tgname='guard_generation_status' AND tgenabled='O'")).rows[0].count;
  if(triggers!==1)throw Error('Generation status guard trigger is not enabled');
  return {guardBodyVerified:true,triggers};
}

try {
  const before=await history();
  if(mode==='rehearse'){
    if(before.includes(migration))throw Error('Migration already applied');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='2000ms'");
      await client.query("SET LOCAL statement_timeout='15000ms'");
      await client.query('LOCK TABLE mirror.publications IN ACCESS SHARE MODE');
      await client.query(sql);
      const result=await inspect(client);
      await client.query('ROLLBACK');
      const report={migration,checksum,host:target.hostname,database:'newmeta_app',before,rolledBack:true,result};
      await writeFile(join(audit,'rehearsal.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({rehearsalPassed:true,rolledBack:true,guardBodyVerified:result.guardBodyVerified}));
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  if(mode==='apply'){
    const rehearsal=JSON.parse(await readFile(join(audit,'rehearsal.json'),'utf8'));
    if(rehearsal.checksum!==checksum||JSON.stringify(rehearsal.before)!==JSON.stringify(before)||!rehearsal.rolledBack)throw Error('Validated migration or database history changed');
    // Only the requested migration is included in the staged deployment.
    // Include only the real applied lineage and this migration. Other pending
    // migrations are deliberately absent from this deployment staging directory.
    const stage=join(audit,'stage');
    await mkdir(join(stage,'prisma/migrations'),{recursive:true});
    for(const name of [...before,migration]){
      await mkdir(join(stage,'prisma/migrations',name),{recursive:true});
      await writeFile(join(stage,'prisma/migrations',name,'migration.sql'),await readFile(join(web,'prisma/migrations',name,'migration.sql')));
    }
    await writeFile(join(stage,'prisma/migrations/migration_lock.toml'),'provider = "postgresql"\n');
    for(const name of await readdir(join(web,'prisma')))if(name.endsWith('.prisma'))await writeFile(join(stage,'prisma',name),await readFile(join(web,'prisma',name)));
    const config=join(stage,'prisma.config.mjs');
    await writeFile(config,'export default {schema:"./prisma",migrations:{path:"./prisma/migrations"},datasource:{url:process.env.DIRECT_DATABASE_URL}};\n');
    const cli=join(process.env.APPDATA,'npm-cache/_npx/51d6e96430f348c4/node_modules/prisma/build/index.js');
    const output=await new Promise((done,fail)=>{
      const child=spawn(process.execPath,[cli,'migrate','deploy','--config',config],{cwd:stage,env:{...process.env,DIRECT_DATABASE_URL:target.href},windowsHide:true,shell:false});
      let text='';child.stdout.on('data',b=>{text+=b});child.stderr.on('data',b=>{text+=b});
      child.on('error',fail);child.on('close',code=>code===0?done(redact(text)):fail(Error(`Prisma deployment failed: ${redact(text)}`)));
    });
    await writeFile(join(audit,'prisma-deploy.txt'),output);
    const after=await history();
    if(JSON.stringify(after)!==JSON.stringify([...before,migration]))throw Error('Unexpected migration history after deployment');
    const result=await inspect();
    await writeFile(join(audit,'verification.json'),JSON.stringify({migration,checksum,host:target.hostname,database:'newmeta_app',before,after,result},null,2));
    console.log(JSON.stringify({applied:migration,appliedMigrations:after.length,onlyRequestedMigrationApplied:true,guardBodyVerified:result.guardBodyVerified}));
  }
  if(mode==='verify'){
    if(!before.includes(migration))throw Error('Refresh migration is not applied');
    console.log(JSON.stringify({migrationVerified:true,result:await inspect()}));
  }
}catch(error){console.error(redact(error.message));process.exitCode=1;}finally{await pool.end();}
