import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantAuthority} from '../security/tenant.server.js';
import {TENANT_OPERATIONS} from '../security/tenant-policy.server.js';
import {createShopifyAuthMiddleware,createTenantAdminAuthenticator} from '../middleware/shopify-auth.js';
const shop='tenant.myshopify.com',version='11111111-1111-4111-8111-111111111111',nextVersion='22222222-2222-4222-8222-222222222222';
function fixture(overrides={}){
 const installation={active:true,shopId:shop,installationId:version,installationVersion:version};
 const worker={verified:true,namespace:'mirror.job_commands',jobKind:'bulk_edit',jobId:'123',claimToken:'33333333-3333-4333-8333-333333333333',fenceEpoch:'1',shopId:shop,installationId:version,installationVersion:version};
 const adapters={authenticateAdmin:async()=>({shopId:shop,identityKind:'SHOP'}),getActiveInstallation:async()=>installation,
  verifyWorkerClaim:async()=>worker,getInstallationInTransaction:async()=>installation,verifyWorkerInTransaction:async()=>worker,
  authorizeAdminInTransaction:async()=>({authorized:true}),operations:TENANT_OPERATIONS,
  workerPolicies:[{namespace:worker.namespace,jobKind:worker.jobKind,operation:'bulk_edit'}],...overrides};
 return {authority:createTenantAuthority(adapters),installation,worker};
}
const run=(authority,context,operation='sync_sources.read',mode='READ')=>authority.runAuthorized({context,tx:{},operation,mode,execute:async()=>42});
test('tenant capability cannot be forged or transferred to another authority',async()=>{
 const a=fixture().authority,b=fixture().authority,context=await a.fromAdminRequest({});
 await assert.rejects(run(a,{},'sync_sources.read'),{code:'UNTRUSTED_TENANT_CONTEXT'});
 await assert.rejects(run(b,context),{code:'UNTRUSTED_TENANT_CONTEXT'});assert.equal(await run(a,context),42);
});
test('complete installation assertion requires matching ID and UUID lifecycle version',async()=>{
 const {authority:a}=fixture(),c=await a.fromAdminRequest({});
 assert.equal(a.assertInstallation(c,version,version),true);
 for(const v of [undefined,'1',nextVersion])assert.throws(()=>a.assertInstallation(c,version,v));
 assert.throws(()=>a.assertInstallation(c,nextVersion,version),{code:'INSTALLATION_MISMATCH'});
});
test('reinstall revokes an existing context before protected work',async()=>{
 const f=fixture(),c=await f.authority.fromAdminRequest({});f.installation.installationVersion=nextVersion;
 await assert.rejects(run(f.authority,c),{code:'INSTALLATION_REVOKED'});
});
test('operation modes follow durable effects, including export and preview writes',async()=>{
 const a=fixture().authority,c=await a.fromAdminRequest({});
 for(const {operation,mode} of TENANT_OPERATIONS){assert.equal(await run(a,c,operation,mode),42);await assert.rejects(run(a,c,operation,mode==='READ'?'WRITE':'READ'),{code:'OPERATION_TRANSACTION_MODE_MISMATCH'});}
});
test('unknown and legacy string policies fail closed',()=>{
 assert.throws(()=>fixture({operations:['sync_sources.read']}));
 assert.throws(()=>fixture({operations:[{operation:'sync_sources.read',mode:'READ'},{operation:'sync_sources.read',mode:'WRITE'}]}));
});
test('worker policy keys cannot collide through delimiters',async()=>{
 const f=fixture({workerPolicies:[{namespace:'a:b',jobKind:'c',operation:'bulk_edit'},{namespace:'a',jobKind:'b:c',operation:'undo'}]});
 f.worker.namespace='a';f.worker.jobKind='b:c';const c=await f.authority.fromWorkerClaim(f.worker);
 assert.equal(await run(f.authority,c,'undo','WRITE'),42);
 await assert.rejects(run(f.authority,c,'bulk_edit','WRITE'),{code:'WORKER_OPERATION_DENIED'});
});
test('worker authority rechecks exact current fence inside supplied transaction',async()=>{
 const f=fixture(),c=await f.authority.fromWorkerClaim(f.worker);f.worker.fenceEpoch='2';
 await assert.rejects(run(f.authority,c,'bulk_edit','WRITE'),{code:'WORKER_CLAIM_REVOKED'});
});
test('worker lookup mismatches and unknown kinds cannot issue a capability',async()=>{
 const f=fixture();await assert.rejects(f.authority.fromWorkerClaim({...f.worker,jobId:'124'}),{code:'WORKER_CLAIM_MISMATCH'});
 f.worker.jobKind='import';await assert.rejects(f.authority.fromWorkerClaim(f.worker),{code:'WORKER_KIND_UNAUTHORIZED'});
});
test('admin identity kind is required and must agree with actor presence',async()=>{
 for(const identity of [{},{identityKind:'SHOP',actorId:'1'},{identityKind:'USER'}]){
  const f=fixture({authenticateAdmin:async()=>({shopId:shop,...identity})});await assert.rejects(f.authority.fromAdminRequest({}));
 }
});
for(const isOnline of [false,true])test(`Shopify adapter derives ${isOnline?'USER':'SHOP'} from verified stored session, ignoring browser properties`,async()=>{
 const session={id:'session',shop,accessToken:'secret-fixture',isOnline,...(isOnline?{expires:new Date(Date.now()+60000)}:{}),...(isOnline?{onlineAccessInfo:{associated_user:{id:77}}}:{})};
 const auth=createTenantAdminAuthenticator({resolveInstallation:createInstallationResolver({readInstallation:async()=>({installation_version:version})}),sessionStorage:{loadSession:async()=>session}});
 const req={body:{identityKind:isOnline?'SHOP':'USER',actorId:'999'},query:{shop:'attacker.myshopify.com'}};
 await assert.rejects(auth(req));
 const middleware=createShopifyAuthMiddleware({shopify:{validateAuthenticatedSession:()=> (_req,res,next)=>{res.locals.shopify={session};next();}}});
 await new Promise((resolve,reject)=>middleware(req,{locals:{},status(){throw Error('Unexpected denial');}},e=>e?reject(e):resolve()));
 assert.deepEqual(await auth(req),{shopId:shop,sessionId:'session',installationId:version,installationVersion:version,identityKind:isOnline?'USER':'SHOP',...(isOnline?{actorId:'77'}:{})});
 session.isOnline=!isOnline;await assert.rejects(auth(req));
});

test('admin authority rejects lifecycle replacement between identity authentication and independent lookup',async()=>{
 const f=fixture({authenticateAdmin:async()=>({shopId:shop,identityKind:'SHOP',installationId:nextVersion,installationVersion:nextVersion})});
 await assert.rejects(f.authority.fromAdminRequest({}),{code:'INSTALLATION_REVOKED'});
});
