import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantAuthority} from '../security/tenant.server.js';
import {TENANT_OPERATIONS} from '../security/tenant-policy.server.js';
import {createTenantDatabase,classifyTenantDatabaseError} from '../security/tenant-db.server.js';
function fixture(){
 const tenant={shopId:'gateway.myshopify.com',installationId:'11111111-1111-4111-8111-111111111111',installationVersion:'11111111-1111-4111-8111-111111111111',active:true};
 let connections=0;const sql=[];
 const authority=createTenantAuthority({authenticateAdmin:async()=>({shopId:tenant.shopId,identityKind:'SHOP'}),getActiveInstallation:async()=>tenant,
  getInstallationInTransaction:async()=>tenant,authorizeAdminInTransaction:async()=>({authorized:true}),verifyWorkerClaim:async()=>null,verifyWorkerInTransaction:async()=>null,
  operations:TENANT_OPERATIONS,workerPolicies:[]});
 const pool={async connect(){connections++;return {release(){},async query(text,values){sql.push({text,values});return {rows:text.includes('AS shop_id')?[{shop_id:tenant.shopId,installation_id:tenant.installationId,installation_version:tenant.installationVersion}]:[],rowCount:0};}};}};
 const gateway=createTenantDatabase({pool,authority,verifyDatabase:async()=>true,statements:[{name:'read',mode:'READ',operations:['sync_sources.read'],sql:'SELECT $1,$2,$3',validateValues:()=>[]}]});
 return {gateway,authority,sql,connections:()=>connections};
}
test('gateway rejects forged contexts, unsupported operations and wrong modes before opening a connection',async()=>{
 const f=fixture(),context=await f.authority.fromAdminRequest({});
 for(const input of [{context:{},operation:'sync_sources.read'},{context,operation:'unknown'},{context,operation:'export'}])await assert.rejects(f.gateway.withTenantRead({...input,execute(){}}));
 assert.equal(f.connections(),0);
});
test('gateway hides raw clients, rejects arbitrary statement names and revokes escaped handles',async()=>{
 const f=fixture(),context=await f.authority.fromAdminRequest({});let escaped;
 await f.gateway.withTenantRead({context,operation:'sync_sources.read',execute:async repo=>{escaped=repo;assert.deepEqual(Object.keys(repo),['run']);await repo.run('read');}});
 await assert.rejects(escaped.run('read'),{code:'TENANT_TRANSACTION_ENDED'});
 await assert.rejects(f.gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('SET app.shop_id')}),{code:'TENANT_STATEMENT_DENIED'});
 assert.ok(f.sql.some(q=>q.text==='ROLLBACK'));
});
test('retryable errors roll back once without replaying a potentially effectful callback',async()=>{
 const f=fixture(),context=await f.authority.fromAdminRequest({});let calls=0;
 await assert.rejects(f.gateway.withTenantRead({context,operation:'sync_sources.read',execute(){calls++;throw Object.assign(Error('conflict'),{code:'40001'});}}),{code:'40001'});
 assert.equal(calls,1);assert.equal(f.connections(),1);assert.ok(f.sql.some(q=>q.text==='ROLLBACK'));
});
test('database errors distinguish conflicts, permanent denials and unknown commit outcomes',()=>{
 assert.equal(classifyTenantDatabaseError({code:'40001'}),'RETRYABLE_TRANSACTION');
 assert.equal(classifyTenantDatabaseError({code:'40P01'}),'RETRYABLE_TRANSACTION');
 assert.equal(classifyTenantDatabaseError({code:'23505'}),'PERMANENT');
 assert.equal(classifyTenantDatabaseError({code:'42501'}),'PERMANENT');
 assert.equal(classifyTenantDatabaseError({code:'57014'}),'TRANSIENT_CAPACITY');
 assert.equal(classifyTenantDatabaseError({code:'ECONNRESET'}),'OUTCOME_UNKNOWN');
});
test('operation timeout configuration is bounded at trusted bootstrap',()=>{
 const f=fixture();assert.throws(()=>createTenantDatabase({pool:{connect(){}},authority:f.authority,statements:[],verifyDatabase(){},operationTimeouts:{catalog:{statementMs:999999,lockMs:100}}}));
});
