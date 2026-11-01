import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireResourceFamilies} from '../security/resource-family-admission.server.js';
const tenant={shopId:'family.myshopify.com',installationId:'installation'};
const input={tenant,operationId:'operation',mutationId:'mutation',attemptId:'attempt',families:['gid://shopify/Product/1']};
test('family admission uses the shop and canonical parent, sorted once across resources',async()=>{
 const keys=[];await acquireResourceFamilies({...input,families:['gid://shopify/Product/2',...input.families,...input.families],tx:{async query(sql,p){
  if(sql.includes('pg_try_advisory')){keys.push(JSON.parse(p[0]));return{rows:[{acquired:true}]};}
  assert.deepEqual(p,[tenant.shopId,tenant.installationId,['gid://shopify/Product/1','gid://shopify/Product/2'],'operation','mutation','attempt']);
  assert.match(sql,/DISPATCHING.*OUTCOME_UNKNOWN.*ACKNOWLEDGED/);return{rows:[]};
 }}});assert.deepEqual(keys,[[tenant.shopId,'gid://shopify/Product/1'],[tenant.shopId,'gid://shopify/Product/2']]);
});
test('busy and uncertain families fail closed without granting a new dispatch',async()=>{
 for(const busy of [true,false])await assert.rejects(()=>acquireResourceFamilies({...input,tx:{query:async sql=>sql.includes('pg_try_advisory')?{rows:[{acquired:!busy}]}:{rows:[{}]}}}),{code:busy?'HISTORY_OWNERSHIP_LOST':'HISTORY_INVALID_TRANSITION'});
 await assert.rejects(()=>acquireResourceFamilies({...input,families:['gid://shopify/ProductVariant/1'],tx:{query(){assert.fail();}}}),{code:'HISTORY_INVALID_INPUT'});
});
