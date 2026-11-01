import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstallationResolver,assertInstallationTenant} from '../security/installation-lifecycle.server.js';
import {createFilterAuthentication} from '../middleware/filter-auth.server.js';
import {createFieldAuthorizationService} from './field-authorization.server.js';
test('session authority is pinned to the installation at capture and cannot survive a reinstall',async()=>{
 let version='first';const session={id:'s',shop:'lifecycle.myshopify.com',accessToken:'token',isOnline:false};
 const resolveInstallation=createInstallationResolver({readInstallation:async()=>({installation_version:version})});
 const authentication=createFilterAuthentication({resolveInstallation,sessionStorage:{loadSession:async()=>session}});
 const req={},res={locals:{shopify:{session}}};await authentication.capture(req,res,error=>{if(error)throw error;});
 const context=await authentication.authenticate(req);assert.equal((await authentication.resolveTenant(context)).installationVersion,'first');
 const authorization=createFieldAuthorizationService({resolveShop:authentication.resolveShop,resolveTenant:authentication.resolveTenant,getShopScopes:async()=>['read_products']});
 const input={shopId:session.shop,authContext:context,access:'read',operation:'filter',field:{id:'product.title'},source:{adapterId:'trusted-reader'}};
 assert.equal(await authorization.authorizeAccess(input),true);
 version='second';await assert.rejects(()=>authentication.resolveTenant(context),{code:'FIELD_PERMISSION_DENIED'});assert.equal(await authorization.authorizeAccess(input),false);
 const next={};await authentication.capture(next,res,error=>{if(error)throw error;});assert.equal((await authentication.resolveTenant(await authentication.authenticate(next))).installationVersion,'second');
 assert.throws(()=>assertInstallationTenant({shopId:session.shop,installationId:'second',installationVersion:'second'}),{code:'INSTALLATION_NOT_ACTIVE'});
});
test('installation resolver rejects missing, uninstalled and malformed lifecycle evidence',async()=>{
 for(const row of [null,{}, {installation_version:''},{installation_version:'version',uninstalled_at:new Date()}]){
  const resolve=createInstallationResolver({readInstallation:async()=>row});await assert.rejects(()=>resolve('lifecycle.myshopify.com'),{code:'INSTALLATION_NOT_ACTIVE'});
 }
});
