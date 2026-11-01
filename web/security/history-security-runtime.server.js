import pg from 'pg';
import { createHistoryValueProtection } from '../edit-history/history-value-protection.server.js';
import { createHistoryRetentionService } from '../edit-history/history-retention.server.js';
import { verifyHistoryDatabasePrivileges } from '../edit-history/database-security.server.js';
import { requireHistoryId } from '../edit-history/history-contract.js';
import { createHistoryPrivacyService } from '../edit-history/history-privacy.server.js';
import {historyMaintenanceBudgets,historyMaintenanceFailure} from './history-maintenance-policy.server.js';
export function historyValueKeyring({activeKeyId,keysJson}){
 let encoded;try{encoded=JSON.parse(keysJson);}catch{throw TypeError('History keyring configuration required');}
 if(!encoded||typeof encoded!=='object'||Array.isArray(encoded)||typeof activeKeyId!=='string')throw TypeError('Invalid history keyring configuration');
 const keys=new Map();
 for(const [id,value] of Object.entries(encoded)){
  requireHistoryId(id,'keyReference',256);
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw TypeError('History keys must be canonical 256-bit base64');
  const buffer=Buffer.from(value,'base64');if(buffer.length!==32||buffer.toString('base64')!==value)throw TypeError('Invalid history key material');keys.set(id,buffer);
 }
 if(!keys.has(activeKeyId))throw TypeError('Active history key missing');
 const valueProtection=createHistoryValueProtection({resolveKey:async({keyReference})=>{
  const reference=keyReference??activeKeyId,key=keys.get(reference);if(!key)throw Error('Key unavailable');return{key,keyReference:reference};
 }});
 return Object.freeze({valueProtection,close(){for(const key of keys.values())key.fill(0);keys.clear();}});
}
export async function createHistorySecurityRuntime({env=process.env,logger=console}={}){
 const maintenanceEnabled=env.HISTORY_MAINTENANCE_ENABLED==='true';
 if(!maintenanceEnabled&&!env.HISTORY_PRIVACY_DATABASE_URL)return null;
 if(maintenanceEnabled&&!env.HISTORY_MAINTENANCE_DATABASE_URL)throw TypeError('Dedicated history maintenance credentials required');
 if(maintenanceEnabled&&!env.HISTORY_PRIVACY_DATABASE_URL)throw TypeError('Dedicated history privacy credentials required');
 const budgets=maintenanceEnabled?historyMaintenanceBudgets(env):null;
 const keyring=maintenanceEnabled?historyValueKeyring({activeKeyId:env.HISTORY_ENCRYPTION_ACTIVE_KEY_ID,keysJson:env.HISTORY_ENCRYPTION_KEYS_JSON}):null;
 let privacyPool,privacyService;
 if(env.HISTORY_PRIVACY_DATABASE_URL){
  privacyPool=new pg.Pool({connectionString:env.HISTORY_PRIVACY_DATABASE_URL,max:1,query_timeout:15000,connectionTimeoutMillis:10000});
  try{const client=await privacyPool.connect();try{await verifyHistoryDatabasePrivileges(client,{profile:'privacy'});}finally{client.release();}}
  catch{await privacyPool.end();keyring?.close();throw Error('History privacy database verification failed');}
  privacyService=createHistoryPrivacyService({database:privacyPool});
 }
 if(!maintenanceEnabled)return Object.freeze({privacyService,start(){},async stop(){await privacyPool?.end();}});
 const database=new pg.Pool({connectionString:env.HISTORY_MAINTENANCE_DATABASE_URL,max:1,query_timeout:15000,connectionTimeoutMillis:10000});
 try{const client=await database.connect();try{await verifyHistoryDatabasePrivileges(client,{profile:'maintenance'});}finally{client.release();}}
 catch{keyring.close();await database.end();await privacyPool?.end();throw Error('History maintenance database verification failed');}
 const service=createHistoryRetentionService({database,valueProtection:keyring.valueProtection});
 // runOnce is a bounded scheduled-worker entry point, independent of start().
 // Input: none (dedicated verified credentials/keyring from bootstrap). Output:
 // non-sensitive counts and review flag. Effects: repository-owned purge/encrypt
 // transactions. Concurrent calls join one batch; failure rejects for scheduler
 // monitoring. A timer remains optional for continuously running deployments.
 let stopped=true,closing=false,timer,inFlight,failures=0,lastSuccessAt=null,lastFailureAt=null,lastFailure=null;
 async function runOnce(){
  if(closing)throw Error('History maintenance runtime stopped');
  if(inFlight)return inFlight;
  let stage='retention';
  const work=(async()=>{
   let deletedRows=0,encrypted=0,reviewRequired=false;
   const deadline=Date.now()+budgets.passBudgetMs;
   for(let i=0;i<budgets.purgeBatches&&!closing&&Date.now()<deadline;i++){
    const result=await service.purgeBatch({limit:budgets.purgeBatchSize});
    if(!Number.isSafeInteger(result?.deletedRows)||result.deletedRows<0)throw Error('Invalid retention result');
    deletedRows+=result.deletedRows;if(result.deletedRows===0)break;
   }
   stage='encryption';
   for(let i=0;i<budgets.encryptionBatches&&!closing&&Date.now()<deadline;i++){
    const result=await service.encryptLegacyBatch({limit:budgets.encryptionBatchSize});
    if(!Number.isSafeInteger(result?.encrypted)||result.encrypted<0)throw Error('Invalid encryption result');
    encrypted+=result.encrypted;reviewRequired ||= result.reviewRequired===true;
    if(result.encrypted===0||reviewRequired)break;
   }
   const outcome=Object.freeze({deletedRows,encrypted,reviewRequired,...(Date.now()>=deadline?{budgetExhausted:true}:{})});
   lastSuccessAt=new Date().toISOString();failures=0;return outcome;
  })();
  inFlight=work;
  try{return await work;}
  catch(error){failures++;lastFailureAt=new Date().toISOString();lastFailure=historyMaintenanceFailure(error,stage);
   try{logger.error?.({...lastFailure,failures},'History maintenance pass failed');}catch{}throw error;}
  finally{if(inFlight===work)inFlight=null;}
 }
 async function tick(){
  try{await runOnce();}
  catch{ /* runOnce records a structured, redacted diagnostic for every caller. */ }
  finally{if(!stopped){timer=setTimeout(run,Math.min(60000,5000*2**Math.min(failures,4)));timer.unref?.();}}
 }
 function run(){if(!stopped)void tick();}
 return Object.freeze({service,privacyService,runOnce,
  status(){return Object.freeze({running:!stopped,inFlight:!!inFlight,failures,lastSuccessAt,lastFailureAt,lastFailure,budgets});},
  start(){if(closing)throw Error('History maintenance runtime stopped');if(stopped){stopped=false;run();}},
  async stop(){closing=true;stopped=true;clearTimeout(timer);try{await inFlight;}catch{}finally{keyring.close();await Promise.all([database.end(),privacyPool?.end()]);}}
 });
}
