/** All history values are sensitive by default. Keys never enter database rows. */
import { createCipheriv,createDecipheriv,randomBytes,hkdfSync } from 'node:crypto';
import { canonicalHistoryJson,HistoryContractError,HISTORY_ERROR_CODES as C,requireHistoryId,HISTORY_LIMITS } from './history-contract.js';
import { createHistoryHookInvoker } from './transaction-hooks.server.js';
const issued=new WeakSet();
const fail=(code,message)=>{throw new HistoryContractError(code,message);};
function associated(row,tenant,keyReference){
 if(row.shop_id!==tenant.shopId||row.installation_id!==tenant.installationId)fail(C.UNAUTHORIZED,'Snapshot key scope mismatch');
 return Buffer.from(JSON.stringify([1,row.shop_id,row.installation_id,row.operation_id,row.change_id,row.id,row.snapshot_kind,
  row.resource_gid,row.field_id,row.snapshot_fingerprint,row.evidence_binding_fingerprint,keyReference]));
}
export function assertHistoryValueProtection(value){if(!issued.has(value))throw TypeError('Issued history value protection required');}
export function createHistoryValueProtection({resolveKey}={}){
 if(resolveKey!==undefined&&typeof resolveKey!=='function')throw TypeError('Trusted history key resolver required');
 async function key(context,keyReference){
  if(!resolveKey)fail(C.UNAUTHORIZED,'History encryption key provider required');
  const controller=new AbortController();let timer;
  try{
   const source=await Promise.race([Promise.resolve().then(()=>typeof context.client?.query==='function'
    ?createHistoryHookInvoker(context.client,{budgetMs:5000,hookMs:5000})(resolveKey,{...context,keyReference})
    :resolveKey({...context,keyReference,signal:controller.signal})),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]);
   if(!source||!Buffer.isBuffer(source.key)||source.key.length!==32)throw Error('key');
   const reference=requireHistoryId(source.keyReference,'keyReference',256);
   if(keyReference!==undefined&&reference!==keyReference)throw Error('scope');
   const derived=Buffer.from(hkdfSync('sha256',source.key,Buffer.from(JSON.stringify([context.tenant.shopId,context.tenant.installationId])),
    Buffer.from(`metamax-history-value-v1:${reference}`),32));
   return{key:derived,keyReference:reference};
  }catch{fail(C.UNAUTHORIZED,'History encryption key unavailable');}
  finally{clearTimeout(timer);controller.abort();}
 }
 const protection=Object.freeze({
  async seal(row,value,context){
   if(row.value_kind==='ABSENT')return{value_encoding:'JSONB',value_json:null,encrypted_value:null,encryption_key_reference:null};
   const resolved=await key({...context,purpose:'encrypt'});
   try{
    const plaintext=Buffer.from(JSON.stringify(canonicalHistoryJson(value)));
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',resolved.key,nonce);
    cipher.setAAD(associated(row,context.tenant,resolved.keyReference));
    try{return{value_encoding:'ENCRYPTED_JSON',value_json:null,
     encrypted_value:Buffer.concat([Buffer.from([1]),nonce,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]),
     encryption_key_reference:resolved.keyReference};}finally{plaintext.fill(0);}
   }finally{resolved.key.fill(0);}
  },
  async open(row,context){
   associated(row,context.tenant,row.encryption_key_reference??null);
   if(row.value_encoding==='JSONB'){
    if(row.encrypted_value!==null||row.encryption_key_reference!==null)fail(C.BINDING_CONFLICT,'Inconsistent history value encoding');
    return row; // Existing plaintext is read only for verification/backfill or explicitly authorized reveal.
   }
   if(row.value_encoding!=='ENCRYPTED_JSON'||row.value_kind!=='VALUE'||row.value_json!==null)fail(C.BINDING_CONFLICT,'Inconsistent history value encoding');
   const payload=Buffer.isBuffer(row.encrypted_value)?row.encrypted_value:
    typeof row.encrypted_value==='string'&&/^\\x[0-9a-f]+$/i.test(row.encrypted_value)?Buffer.from(row.encrypted_value.slice(2),'hex'):null;
   if(!payload||payload.length<30||payload.length>HISTORY_LIMITS.MAX_VALUE_BYTES+64||payload[0]!==1)fail(C.EVIDENCE_CONFLICT,'Invalid encrypted history value');
   const resolved=await key({...context,purpose:'decrypt'},row.encryption_key_reference);
   try{
    const decipher=createDecipheriv('aes-256-gcm',resolved.key,payload.subarray(1,13));
    decipher.setAAD(associated(row,context.tenant,resolved.keyReference));decipher.setAuthTag(payload.subarray(-16));
    let plaintext;
    try{plaintext=Buffer.concat([decipher.update(payload.subarray(13,-16)),decipher.final()]);
     const value=canonicalHistoryJson(JSON.parse(plaintext.toString('utf8')));
     return{...row,value_encoding:'JSONB',value_json:value,encrypted_value:null,encryption_key_reference:null};
    }catch{fail(C.EVIDENCE_CONFLICT,'History value authentication failed');}
    finally{plaintext?.fill(0);}
   }finally{resolved.key.fill(0);}
  },
 });
 issued.add(protection);return protection;
}
