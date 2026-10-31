import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryValueProtection } from '../history-value-protection.server.js';
import { historyValueKeyring,createHistorySecurityRuntime } from '../history-security-runtime.server.js';
const tenant={shopId:'security.myshopify.com',installationId:'install-1'};
const row=()=>({id:'snapshot-1',shop_id:tenant.shopId,installation_id:tenant.installationId,operation_id:'op-1',change_id:'change-1',
 snapshot_kind:'BEFORE',value_kind:'VALUE',resource_gid:'gid://shopify/Product/1',field_id:'product.title',snapshot_fingerprint:'hash-1',evidence_binding_fingerprint:'evidence-1'});
const protection=()=>createHistoryValueProtection({resolveKey:async({keyReference})=>({key:Buffer.alloc(32,19),keyReference:keyReference??'key-1'})});
test('AES-GCM values round trip null/false/objects with fresh nonces and no plaintext in storage',async()=>{
 for(const value of [null,false,0,'private value',{note:['private',1]}]){
  const p=protection(),r=row(),a=await p.seal(r,value,{tenant}),b=await p.seal(r,value,{tenant});
  assert.equal(a.value_json,null);assert.equal(a.value_encoding,'ENCRYPTED_JSON');assert.notDeepEqual(a.encrypted_value,b.encrypted_value);
  const clear=await p.open({...r,...a},{tenant});assert.deepEqual(JSON.parse(JSON.stringify(clear.value_json)),value);
 }
});
test('ciphertexts bind snapshot, operation, change, field, resource, fingerprints and key references',async()=>{
 const p=protection(),r=row(),sealed=await p.seal(r,'private',{tenant});
 for(const key of ['id','operation_id','change_id','snapshot_kind','resource_gid','field_id','snapshot_fingerprint','evidence_binding_fingerprint'])
  await assert.rejects(()=>p.open({...r,...sealed,[key]:'different'},{tenant}),{code:'HISTORY_EVIDENCE_CONFLICT'});
 await assert.rejects(()=>p.open({...r,...sealed,encryption_key_reference:'another-key'},{tenant}),{code:'HISTORY_EVIDENCE_CONFLICT'});
 await assert.rejects(()=>p.open({...r,...sealed},{tenant:{...tenant,installationId:'install-2'}}),{code:'HISTORY_UNAUTHORIZED'});
});
test('missing/wrong keys fail closed with generic errors and ABSENT contains no encrypted value',async()=>{
 const r=row();await assert.rejects(()=>createHistoryValueProtection().seal(r,'private',{tenant}),{code:'HISTORY_UNAUTHORIZED'});
 const p=createHistoryValueProtection({resolveKey:async()=>{throw Error('postgresql://secret@private/token');}});
 await assert.rejects(()=>p.seal(r,'private',{tenant}),error=>error.code==='HISTORY_UNAUTHORIZED'&&!error.message.includes('secret'));
 const absent=await createHistoryValueProtection().seal({...r,value_kind:'ABSENT'},undefined,{tenant});
 assert.equal(absent.value_encoding,'JSONB');assert.equal(absent.encrypted_value,null);
});
test('key resolver connection capabilities expire and cannot commit journal transactions',async()=>{
 let saved,queries=0;const client={async query(){queries++;return{rows:[]};}};
 const p=createHistoryValueProtection({resolveKey:async context=>{saved=context.client;await context.client.query('SELECT 1');
  await assert.rejects(()=>context.client.query('COMMIT'),{code:'HISTORY_UNAUTHORIZED'});return{key:Buffer.alloc(32,3),keyReference:'key'};}});
 await p.seal(row(),'value',{tenant,client});assert.equal(queries,1);
 await assert.rejects(()=>saved.query('SELECT 1'),{code:'HISTORY_OWNERSHIP_LOST'});
});
test('rotated keyrings retain old decryption keys and reject malformed secret material without echoing it',async()=>{
 const oldKey=Buffer.alloc(32,1).toString('base64'),newKey=Buffer.alloc(32,2).toString('base64');
 const first=historyValueKeyring({activeKeyId:'old',keysJson:JSON.stringify({old:oldKey})});
 const r=row(),sealed=await first.valueProtection.seal(r,'private',{tenant});
 const second=historyValueKeyring({activeKeyId:'new',keysJson:JSON.stringify({old:oldKey,new:newKey})});
 assert.equal((await second.valueProtection.open({...r,...sealed},{tenant})).value_json,'private');
 assert.equal((await second.valueProtection.seal(r,'private',{tenant})).encryption_key_reference,'new');
 first.close();second.close();
 assert.throws(()=>historyValueKeyring({activeKeyId:'x',keysJson:'private broken secret'}),error=>!error.message.includes('private broken secret'));
});
test('maintenance remains disabled without explicit configuration and rejects missing dedicated credentials',async()=>{
 assert.equal(await createHistorySecurityRuntime({env:{}}),null);
 await assert.rejects(()=>createHistorySecurityRuntime({env:{HISTORY_MAINTENANCE_ENABLED:'true'}}),/Dedicated history maintenance credentials/);
 await assert.rejects(()=>createHistorySecurityRuntime({env:{HISTORY_MAINTENANCE_ENABLED:'true',HISTORY_MAINTENANCE_DATABASE_URL:'unused'}}),/Dedicated history privacy credentials/);
});
