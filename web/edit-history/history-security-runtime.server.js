import pg from 'pg';
import { createHistoryValueProtection } from './history-value-protection.server.js';
import { createHistoryRetentionService } from './history-retention.server.js';
import { verifyHistoryDatabasePrivileges } from './database-security.server.js';
import { requireHistoryId } from './history-contract.js';
import { createHistoryPrivacyService } from './history-privacy.server.js';
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
 let stopped=true,timer,inFlight,failures=0;
 async function tick(){
  try{for(let i=0;i<5&&!stopped;i++){const result=await service.purgeBatch();if(result.deletedRows===0)break;}
   if(!stopped)await service.encryptLegacyBatch();failures=0;
  }catch{failures++;try{logger.error?.('[history] Maintenance failed; retrying with bounded backoff');}catch{}}
  finally{if(!stopped){timer=setTimeout(run,Math.min(60000,5000*2**Math.min(failures,4)));timer.unref?.();}}
 }
 function run(){if(!stopped)inFlight=tick();}
 return Object.freeze({service,privacyService,start(){if(stopped){stopped=false;run();}},async stop(){stopped=true;clearTimeout(timer);await inFlight;keyring.close();await database.end();await privacyPool?.end();}});
}
