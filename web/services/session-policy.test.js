import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '@shopify/shopify-api';
import {isValidShopifySession} from '../middleware/session-validation.js';
import {assertCatalogSession} from '../mirror/shopify-catalog-source.server.js';
import {createGenerationAuthorityProvider} from '../mirror/generation-authority.server.js';
const shop='policy.myshopify.com';
const valid=()=>new Session({id:'session',shop,state:'fixture',isOnline:false,accessToken:'token',scope:'read_products'});
test('one session policy accepts official offline and unexpired online sessions',async()=>{
 const offline=valid();assert.equal(isValidShopifySession(offline),true);assert.equal(assertCatalogSession(offline,shop),offline);
 const online=new Session({...offline,isOnline:true,expires:new Date(Date.now()+60000),onlineAccessInfo:{associated_user_scope:'read_products'}});
 assert.equal(isValidShopifySession(online),true);assert.equal(assertCatalogSession(online,shop),online);
 const authority=createGenerationAuthorityProvider({resolveInstallation:createInstallationResolver({readInstallation:async()=>({installation_version:'install-1'})}),sessionStorage:{loadSession:async()=>offline}});
 assert.equal((await authority.authorize({action:'verify',context:{sessionId:'session'}})).shopId,shop);
});
test('malformed credentials and expiries fail closed across session consumers',async()=>{
 for(const patch of [{id:undefined},{accessToken:undefined},{accessToken:'  '},{shop:'evil.example'},
  {expires:'not-a-date'},{expires:new Date(NaN)},{expires:new Date(0)},{expires:0},
  {expires:new Date(Date.now()+60000).toISOString()},{isOnline:true},{isOnline:'false'}]){
  const session={...valid(),...patch};assert.equal(isValidShopifySession(session),false,JSON.stringify(patch));
  assert.equal(isValidShopifySession(session,{requireCredentials:false}),false);
  assert.throws(()=>assertCatalogSession(session,shop));
  const authority=createGenerationAuthorityProvider({sessionStorage:{loadSession:async()=>session}});
  await assert.rejects(()=>authority.authorize({action:'verify',context:{sessionId:'session'}}),{code:'PERMISSION_DENIED'});
 }
});
test('session validity does not replace current staff product permission',()=>{
 const session={...valid(),isOnline:true,expires:new Date(Date.now()+60000),onlineAccessInfo:{associated_user_scope:'read_orders'}};
 assert.equal(isValidShopifySession(session),true);assert.throws(()=>assertCatalogSession(session,shop));
});
