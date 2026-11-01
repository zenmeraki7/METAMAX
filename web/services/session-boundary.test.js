import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopifyAuthMiddleware,createInstallationGuard,createTenantAdminAuthenticator} from '../middleware/shopify-auth.js';
import {createFilterAuthentication} from '../middleware/filter-auth.server.js';
import {createInstallationResolver} from '../security/installation-lifecycle.server.js';

const shop='boundary.myshopify.com';
function fixture(){
 let version='installation-1',installed=true;
 const session={id:'session',shop,isOnline:false,accessToken:'token',scope:'read_products'};
 const resolveInstallation=createInstallationResolver({readInstallation:async()=>installed?{installation_version:version}:null});
 const storage={loadSession:async()=>session};
 const middleware=createShopifyAuthMiddleware({shopify:{validateAuthenticatedSession:()=> (_req,res,next)=>{res.locals.shopify={session};next();}}});
 const admin=createTenantAdminAuthenticator({sessionStorage:storage,resolveInstallation});
 const filter=createFilterAuthentication({sessionStorage:storage,resolveInstallation});
 const database={connect:async()=>({query:async sql=>({rows:sql.includes('FROM mirror.shops')&&installed?[{installation_version:version}]:[]}),release(){}})};
 const guard=createInstallationGuard({database,sessionStorage:storage});
 return {session,admin,filter,middleware,guard,reinstall(){version='installation-2';},uninstall(){installed=false;}};
}
const response=()=>({locals:{},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
async function capture(f){
 const req={},res=response();let called=false;
 await f.middleware(req,res,()=>{called=true;});assert.equal(called,true);
 await f.guard(req,res,()=>{});
 await f.filter.capture(req,res,error=>{if(error)throw error;});
 return {req,res,context:await f.filter.authenticate(req)};
}

test('protected middleware rejects incomplete online/offline and actor classification',async()=>{
 for(const patch of [{isOnline:undefined},{isOnline:'false'},{isOnline:true,expires:new Date(Date.now()+60000)},
  {isOnline:true,expires:new Date(Date.now()+60000),onlineAccessInfo:{associated_user:{id:0}}}]){
  const f=fixture();Object.assign(f.session,patch);const req={},res=response();let called=false;
  await f.middleware(req,res,()=>{called=true;});assert.equal(called,false);assert.equal(res.statusCode,401);
 }
});

test('all protected adapters reject in-place credential or identity replacement consistently',async()=>{
 for(const mutate of [s=>s.accessToken='replacement',s=>s.id='different',s=>s.shop='other.myshopify.com',
  s=>{s.isOnline=true;s.expires=new Date(Date.now()+60000);s.onlineAccessInfo={associated_user:{id:7}};}]){
  const f=fixture(),{req,res,context}=await capture(f);mutate(f.session);
  await assert.rejects(f.admin(req),{code:'FIELD_PERMISSION_DENIED'});
  await assert.rejects(f.filter.resolveSession(context),{code:'FIELD_PERMISSION_DENIED'});
  let continued=false;await f.guard(req,res,()=>{continued=true;});assert.equal(continued,false);assert.equal(res.statusCode,401);
 }
});

test('guard, admin and filter authority pin and recheck the installation lifecycle',async()=>{
 for(const lifecycle of ['reinstall','uninstall']){
  const f=fixture(),{req,res,context}=await capture(f);await f.admin(req);f[lifecycle]();
  await assert.rejects(f.admin(req));await assert.rejects(f.filter.resolveTenant(context));
  let continued=false;await f.guard(req,res,()=>{continued=true;});assert.equal(continued,false);assert.equal(res.statusCode,403);
 }
});

test('missing installation verification cannot issue filter or admin authority',async()=>{
 const f=fixture();assert.throws(()=>createTenantAdminAuthenticator({sessionStorage:{loadSession:async()=>f.session}}));
 const auth=createFilterAuthentication({sessionStorage:{loadSession:async()=>f.session}}),req={};let failure;
 await auth.capture(req,{locals:{shopify:{session:f.session}}},error=>{failure=error;});
 assert.ok(failure);assert.equal(await auth.authenticate(req),null);
});

test('scope changes remain current policy inputs without being borrowed from request evidence',async()=>{
 const f=fixture(),{req,context}=await capture(f);f.session.scope='read_orders';
 assert.equal((await f.filter.resolveSession(context)).scope,'read_orders');assert.equal((await f.admin(req)).identityKind,'SHOP');
});

test('online actor replacement and expiry revoke all current-session adapters',async()=>{
 for(const mutate of [s=>{s.onlineAccessInfo.associated_user.id=8;},s=>s.expires=new Date(0)]){
  const f=fixture();Object.assign(f.session,{isOnline:true,expires:new Date(Date.now()+60000),onlineAccessInfo:{associated_user:{id:7}}});
  const {req,res,context}=await capture(f);mutate(f.session);
  await assert.rejects(f.admin(req),{code:'FIELD_PERMISSION_DENIED'});
  await assert.rejects(f.filter.resolveSession(context),{code:'FIELD_PERMISSION_DENIED'});
  let continued=false;await f.guard(req,res,()=>{continued=true;});assert.equal(continued,false);assert.equal(res.statusCode,401);
 }
});

test('filter capture cannot rebind the installation already checked by the request guard',async()=>{
 const f=fixture(),req={},res=response();await f.middleware(req,res,()=>{});await f.guard(req,res,()=>{});f.reinstall();
 let failure;await f.filter.capture(req,res,error=>{failure=error;});assert.equal(failure.code,'FIELD_PERMISSION_DENIED');
 assert.equal(await f.filter.authenticate(req),null);
});
