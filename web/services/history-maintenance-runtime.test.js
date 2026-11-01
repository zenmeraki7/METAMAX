import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const pools=[];let fail=false,gate=null,purges=0,encryptions=0,purgeRows=0,encryptedRows=2,failureError=Error('unavailable'),encryptionError=null,onPurge=null;
const limits=[];
mock.module('pg',{defaultExport:{Pool:class{constructor(){pools.push(this);}async connect(){return {release(){}};}async end(){this.closed=true;}}}});
mock.module('../edit-history/database-security.server.js',{namedExports:{verifyHistoryDatabasePrivileges:async()=>{}}});
mock.module('../edit-history/history-privacy.server.js',{namedExports:{createHistoryPrivacyService:()=>({})}});
mock.module('../edit-history/history-retention.server.js',{namedExports:{createHistoryRetentionService:()=>({
 async purgeBatch(options){purges++;limits.push(['purge',options.limit]);if(gate)await gate;if(fail)throw failureError;onPurge?.();return {deletedRows:purgeRows};},
 async encryptLegacyBatch(options){encryptions++;limits.push(['encrypt',options.limit]);if(encryptionError)throw encryptionError;return {encrypted:encryptedRows};}
})}});
const {createHistorySecurityRuntime}=await import('../security/history-security-runtime.server.js');
const env={HISTORY_MAINTENANCE_ENABLED:'true',HISTORY_MAINTENANCE_DATABASE_URL:'fixture',HISTORY_PRIVACY_DATABASE_URL:'fixture',
 HISTORY_ENCRYPTION_ACTIVE_KEY_ID:'key',HISTORY_ENCRYPTION_KEYS_JSON:JSON.stringify({key:Buffer.alloc(32,1).toString('base64')})};

test('one-shot history maintenance runs without a timer, joins concurrent calls, surfaces failure and closes pools',async()=>{
 const runtime=await createHistorySecurityRuntime({env});
 try{
  assert.equal(runtime.status().running,false);
  let release;gate=new Promise(resolve=>{release=resolve;});
  const first=runtime.runOnce(),second=runtime.runOnce();assert.equal(purges,1);release();
  assert.deepEqual(await first,{deletedRows:0,encrypted:2,reviewRequired:false});assert.deepEqual(await second,await first);
  assert.equal(encryptions,1);assert.ok(runtime.status().lastSuccessAt);gate=null;
  fail=true;await assert.rejects(runtime.runOnce(),/unavailable/);assert.equal(runtime.status().failures,1);assert.ok(runtime.status().lastFailureAt);
  fail=false;await runtime.runOnce();assert.equal(runtime.status().failures,0);
 }finally{await runtime.stop();}
 assert.ok(pools.every(pool=>pool.closed));await assert.rejects(runtime.runOnce(),/stopped/);
});

test('scheduled command exits nonzero on missing configuration without logging key material',()=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('HISTORY_'))delete env[key];
 env.DOTENV_CONFIG_PATH=fileURLToPath(new URL('./nonexistent-maintenance-env',import.meta.url));
 env.HISTORY_ENCRYPTION_KEYS_JSON='never-print-this-keyring';
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/history-maintenance.mjs',import.meta.url))],{env,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,1);assert.match(result.stderr,/HISTORY_MAINTENANCE_FAILED/);
 assert.doesNotMatch(result.stderr+result.stdout,/never-print-this-keyring/);
});

test('maintenance failures expose stage and allowlisted category without arbitrary messages or codes',async()=>{
 const events=[];const runtime=await createHistorySecurityRuntime({env,logger:{error(event){events.push(event);}}});
 try{
  fail=true;failureError=Object.assign(Error('connection string private-value'),{code:'57P01'});
  await assert.rejects(runtime.runOnce());assert.equal(events.at(-1).category,'DATABASE');assert.equal(events.at(-1).stage,'retention');
  fail=false;encryptionError=Object.assign(Error('History encryption key unavailable'),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(runtime.runOnce());assert.equal(events.at(-1).category,'KEY_UNAVAILABLE');assert.equal(events.at(-1).stage,'encryption');
  assert.equal(runtime.status().lastFailure.category,'KEY_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(events),/private-value/);
 }finally{fail=false;encryptionError=null;failureError=Error('unavailable');await runtime.stop();}
});

test('maintenance throughput is configurable within fixed row and pass bounds',async()=>{
 const config={...env,HISTORY_PURGE_BATCHES_PER_PASS:'2',HISTORY_PURGE_BATCH_SIZE:'7',HISTORY_ENCRYPTION_BATCHES_PER_PASS:'3',HISTORY_ENCRYPTION_BATCH_SIZE:'4'};
 const runtime=await createHistorySecurityRuntime({env:config});const start=limits.length;purgeRows=7;encryptedRows=4;
 try{
  assert.deepEqual(await runtime.runOnce(),{deletedRows:14,encrypted:12,reviewRequired:false});
  assert.deepEqual(limits.slice(start),[['purge',7],['purge',7],['encrypt',4],['encrypt',4],['encrypt',4]]);
 }finally{purgeRows=0;encryptedRows=2;await runtime.stop();}
 await assert.rejects(createHistorySecurityRuntime({env:{...env,HISTORY_PURGE_BATCHES_PER_PASS:'999'}}),/Invalid HISTORY_PURGE_BATCHES_PER_PASS/);
});

test('maintenance pass budget stops starting additional batches while retaining completed work',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);onPurge=()=>{now+=1001;};
 const runtime=await createHistorySecurityRuntime({env:{...env,HISTORY_MAINTENANCE_PASS_BUDGET_MS:'1000'}}),before=encryptions;
 try{assert.deepEqual(await runtime.runOnce(),{deletedRows:0,encrypted:0,reviewRequired:false,budgetExhausted:true});assert.equal(encryptions,before);}
 finally{onPurge=null;await runtime.stop();}
});
