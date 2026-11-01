import test from 'node:test';
import assert from 'node:assert/strict';
import {createReconciliationService} from './reconciliation-service.server.js';
import {FILTER_SQL_SCHEMA} from '../fields/sources.js';
function fixture(revision='1'){
 const calls=[];const query=async(sql,params)=>{calls.push({sql,params});
  if(sql.includes('SET lease_token=$3'))return {rows:[{revision:'1',applied_revision:'0',fence:'1',deleted:false}],rowCount:1};
  if(sql.includes('FROM mirror.generations'))return {rows:[{status:'RECONCILING',mirror_schema_version:FILTER_SQL_SCHEMA.mirrorSchemaVersion,source_contract_version:FILTER_SQL_SCHEMA.sourceContractVersion,mapping_version:'mapping_v1',required_datasets:['products','variants']}]};
  if(sql.includes('SELECT revision,applied_revision,fence'))return {rows:[{revision,applied_revision:'0',fence:'1'}]};
  if(sql.includes('SET attempts=attempts+1'))return {rows:[{attempts:1}],rowCount:1};
  return {rows:[],rowCount:0};
 };
 const service=createReconciliationService({database:{query,async connect(){return {query,release(){}};}}});
 return {service,calls,input:{shopId:'lease.myshopify.com',generationId:'generation',productId:'gid://shopify/Product/1',workerId:'worker'}};
}
test('expired product lease is a failed attempt, while a newer webhook is successful supersession',async()=>{
 for(const revision of ['1','2']){
  const f=fixture(revision);const call=()=>f.service.reconcileLatestProduct({...f.input,fetchProduct:async()=>({complete:true,product:null})});
  if(revision==='1')await assert.rejects(call,{code:'PRODUCT_LEASE_LOST'});else assert.equal((await call()).superseded,true);
  const failures=f.calls.filter(c=>c.sql.includes('SET attempts=attempts+1'));
  assert.equal(failures.length,revision==='1'?1:0);if(failures.length){assert.match(failures[0].sql,/revision=\$7/);assert.equal(failures[0].params[6],'1');}
 }
});
test('an uncooperative product reader has a deadline inside its product lease',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let signal;
 const pending=f.service.reconcileLatestProduct({...f.input,fetchProduct:input=>{signal=input.signal;return new Promise(()=>{});}});
 const rejection=assert.rejects(()=>pending,{code:'PRODUCT_READ_TIMEOUT'});
 await new Promise(setImmediate);t.mock.timers.tick(20000);await rejection;
 assert.equal(signal.aborted,true);assert.ok(f.calls.some(c=>c.sql.includes('SET attempts=attempts+1')));
});
