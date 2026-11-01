import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { Session } from "@shopify/shopify-api";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";
import { shopifyApp } from "@shopify/shopify-app-express";
import { createApp } from "../app.js";
import { createWebhookHandlers } from "../privacy.js";
import productCreator from "../product-creator.js";
import {createFiltersController} from '../controllers/filters.controller.js';
import {parseFilterAst} from '../filters/ast.js';
import {requireCanonicalField} from '../fields/canonical.js';
import {normalizeFieldValue} from '../fields/normalize.js';
import {
  createShopifyAuthMiddleware,
  createAuthenticatedSessionService,
  isValidShopifyDomain,
  isValidShopifySession,
} from "../middleware/shopify-auth.js";

test('HTTP field consumer rejects a forged descriptor before normalization and accepts registry IDs',async()=>{
  let normalized=0;
  const controller=createFiltersController({authenticate:async()=>Object.freeze({}),resolveDatasets:async()=>({executionContext:{}}),logger:{error(){}},
    compiler:{async validateFilter(input){
      const parsed=parseFilterAst(input);
      normalized++;normalizeFieldValue(requireCanonicalField(parsed.root.field),parsed.root.value);
      return parsed;
    },async compileFilter(value){return value;}},executor:{async execute(){return {products:[]};}}});
  await withServer(fakeShopify(),async base=>{
    const post=field=>fetch(`${base}/api/filters/search`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({filter:{version:1,root:{kind:'condition',field,operator:'eq',value:'Summer'}}})});
    const invalid=await post({id:'product.title',type:'number',nullable:true,constraints:{}});
    assert.equal(invalid.status,400);assert.equal(normalized,0);
    const valid=await post('product.title');assert.equal(valid.status,200,await valid.text());assert.equal(normalized,1);
  },{filterRuntime:{capture(_req,_res,next){next();},search:controller.search}});
});

function fakeShopify({ authenticated = true, productErrors = [], requests = [] } = {}) {
  const sessionStorage = new MemorySessionStorage();
  const session = new Session({ id: 'offline_example.myshopify.com', shop: 'example.myshopify.com', state: 'test', isOnline: false, accessToken: 'test-token',scope:'read_products,write_products' });
  sessionStorage.storeSession(session);
  return {
    config: { auth: { path: '/api/auth', callbackPath: '/api/auth/callback' }, webhooks: { path: '/api/webhooks' }, sessionStorage },
    auth: { begin: () => (_req,res) => res.status(302).set('Location','https://example.myshopify.com/admin/oauth/authorize').end(), callback: () => (_req,_res,next) => next() },
    redirectToShopifyOrAppRoot: () => (_req,res) => res.redirect('/'),
    cspHeaders: () => (_req,res,next) => {res.set('Content-Security-Policy',"frame-ancestors https://admin.shopify.com"); next();},
    ensureInstalledOnShop: () => (_req,_res,next) => next(),
    validateAuthenticatedSession: () => (_req,res,next) => { if(!authenticated) return res.status(401).json({error:'UNAUTHORIZED'}); res.locals.shopify={session}; next(); },
    processWebhooks: () => (_req,res) => res.status(200).end(),
    api: {clients: {Graphql: class {async request(query, options){
      requests.push({ query, options });
      if (query.includes('mutation populateProduct')) return {data:{productCreate:{product:productErrors.length ? null : {id:'gid://shopify/Product/1'},userErrors:productErrors}}};
      return {data:{productsCount:{count:4,precision:'EXACT'}}};
    }}}},
  };
}
async function withServer(shopify, callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'newmeta-template-'));
  await writeFile(join(directory,'index.html'),'<html><head><meta name="shopify-api-key" content="%VITE_SHOPIFY_API_KEY%"></head><body>Retained frontend<script type="module" src="/main.jsx"></script></body></html>');
  const app=createApp({shopify,staticPath:directory,apiKey:'test-key',installationDatabase:{async connect(){return {async query(){return {rows:[{installation_version:'test-installation'}]};},release(){}};}},...options});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try{await callback(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(resolve=>server.close(resolve)); await rm(directory,{recursive:true,force:true});}
}

test('OAuth completion awaits durable install scheduling before redirect and ignores browser shop',async()=>{
 const shopify=fakeShopify(),session={id:'offline_example.myshopify.com',shop:'example.myshopify.com'};
 shopify.auth.callback=()=> (_req,res,next)=>{res.locals.shopify={session};next();};
 let calls=0;
 await withServer(shopify,async base=>{
  const response=await fetch(`${base}/api/auth/callback?shop=forged.myshopify.com`,{redirect:'manual'});
  assert.equal(response.status,302);assert.equal(calls,1);
 },{catalogImportService:{async onInstall(input){assert.equal(input,session);calls++;}}});
});

test('rejected OAuth never schedules; failed scheduling never returns the success redirect',async()=>{
 const rejected=fakeShopify();let calls=0;
 rejected.auth.callback=()=> (_req,res)=>res.sendStatus(401);
 await withServer(rejected,async base=>{
  assert.equal((await fetch(`${base}/api/auth/callback`,{redirect:'manual'})).status,401);
 },{catalogImportService:{async onInstall(){calls++;}}});
 assert.equal(calls,0);
 const verified=fakeShopify();
 verified.auth.callback=()=> (_req,res,next)=>{res.locals.shopify={session:{shop:'example.myshopify.com'}};next();};
 await withServer(verified,async base=>{
  const response=await fetch(`${base}/api/auth/callback`,{redirect:'manual'});
  assert.equal(response.status,500);assert.equal(response.headers.get('location'),null);
 },{catalogImportService:{async onInstall(){throw new Error('Database commit unavailable');}}});
 await withServer(verified,async base=>{
  assert.equal((await fetch(`${base}/api/auth/callback`,{redirect:'manual'})).status,503);
 });
});

test('authenticated mirror status repairs interrupted initial scheduling before reading coverage',async()=>{
 const order=[];
 await withServer(fakeShopify(),async base=>{
  const response=await fetch(`${base}/api/mirror/status?shop=forged.myshopify.com`);
  assert.equal(response.status,200);assert.deepEqual(order,['ensure','status']);
 },{catalogImportService:{async ensureInitialSync(session){assert.equal(session.shop,'example.myshopify.com');order.push('ensure');}},
  filterRuntime:{capture(_req,_res,next){next();},search(_req,res){res.sendStatus(503);},catalogStatus(_req,res){order.push('status');res.json({ready:false});}}});
});

test('current sync progress is authenticated, tenant-scoped and never cached',async()=>{
 const shopify=fakeShopify();
 let sessionReads=0;
 const loadSession=shopify.config.sessionStorage.loadSession.bind(shopify.config.sessionStorage);
 shopify.config.sessionStorage.loadSession=async id=>{sessionReads++;return loadSession(id);};
 const current={id:'run-one',status:'RUNNING',progress:{percent:50,estimated:true,stage:'Saving products and variants'}};
 const service={async current(session){assert.equal(session.shop,'example.myshopify.com');return current;}};
 await withServer(shopify,async base=>{
  const response=await fetch(`${base}/api/mirror/sync?shop=forged.myshopify.com`);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{data:current});
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(sessionReads,2); // Global installation guard plus route authentication.
 },{catalogImportService:service});
 await withServer(fakeShopify({authenticated:false}),async base=>{
  assert.equal((await fetch(`${base}/api/mirror/sync`)).status,401);
 },{catalogImportService:service});
});

test('general API JSON errors retain client status and never invoke product creation',async()=>{
 const requests=[];
 await withServer(fakeShopify({requests}),async base=>{
  for(const [body,status,code] of [
   ['{',400,'INVALID_JSON'],
   [JSON.stringify({value:'x'.repeat(1024*1024)}),413,'REQUEST_TOO_LARGE'],
  ]){
   const response=await fetch(`${base}/api/products`,{method:'POST',headers:{'Content-Type':'application/json'},body});
   assert.equal(response.status,status);
   assert.deepEqual(await response.json(),{error:code});
  }
  assert.equal(requests.length,0);
 });
});

test('app-mounted imports use the router body limit and schema before the general JSON parser', async()=>{
 let calls=0;
 await withServer(fakeShopify(),async base=>{
  const post=body=>fetch(`${base}/api/mirror/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body});
  for(const [body,status,code] of [
   ['{',400,'INVALID_IMPORT_REQUEST'],
   ['{"options":{}}',400,'INVALID_IMPORT_REQUEST'],
   [' '.repeat(4095)+'{}',413,'IMPORT_REQUEST_TOO_LARGE'],
  ]){
   const response=await post(body);
   assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:code});
  }
  assert.equal(calls,0);
  assert.equal((await post('{}')).status,202);assert.equal(calls,1);
  const current=await fetch(`${base}/api/mirror/sync`);
  assert.equal(current.status,200);assert.deepEqual(await current.json(),{data:null});
 },{catalogImportService:{async enqueue(){calls++;return {id:'job'};},async current(){return null;}}});
});

test('health and retained SPA work, API routes return JSON rather than HTML',async()=>{
 await withServer(fakeShopify(),async base=>{
  const health=await fetch(`${base}/health`); assert.deepEqual(await health.json(),{status:'ok'}); assert.ok(health.headers.get('content-security-policy'));
  const page=await fetch(`${base}/products`); assert.match(await page.text(),/content="test-key"/);
  const count=await fetch(`${base}/api/products/count`); assert.equal(count.status,503); assert.equal((await count.json()).error,'FILTER_COVERAGE_UNAVAILABLE');
  const catalog=await fetch(`${base}/api/mirror/products`); assert.equal(catalog.status,503); assert.equal((await catalog.json()).error,'FILTER_COVERAGE_UNAVAILABLE');
 });
});

test('all API endpoints require an authenticated Shopify session',async()=>{
 await withServer(fakeShopify({authenticated:false}),async base=>{
  assert.equal((await fetch(`${base}/api/products/count`)).status,401);
  assert.equal((await fetch(`${base}/api/products`, {method:'POST'})).status,401);
  assert.equal((await fetch(`${base}/api/mirror/products`)).status,401);
  assert.equal((await fetch(`${base}/api/filters/search`, {method:'POST'})).status,401);
  assert.equal((await fetch(`${base}/health`)).status,200);
 });
});

test('filter endpoint fails closed without mirror contracts and bounds JSON at the HTTP boundary', async()=>{
 await withServer(fakeShopify(),async base=>{
  const post=body=>fetch(`${base}/api/filters/search`,{method:'POST',headers:{'Content-Type':'application/json'},body});
  const unavailable=await post('{}');
  assert.equal(unavailable.status,503);
  assert.equal(unavailable.headers.get('cache-control'),'private, no-store');
  assert.equal((await unavailable.json()).error.code,'FILTER_COVERAGE_UNAVAILABLE');
  const malformed=await post('{'); assert.equal(malformed.status,400);
  assert.equal((await malformed.json()).error.code,'FILTER_INVALID_INPUT');
  const oversized=await post(JSON.stringify({filter:'x'.repeat(128*1024)}));
  assert.equal(oversized.status,413);
  assert.equal((await oversized.json()).error.code,'FILTER_INVALID_INPUT');
 });
});

test('configured filter endpoint runs behind Shopify authentication and ahead of the API fallback', async()=>{
 let captured=false, searched=false;
 const runtime={capture(_req,res,next){assert.equal(res.locals.shopify.session.shop,'example.myshopify.com');captured=true;next();},
  search(req,res){assert.ok(captured);searched=true;assert.deepEqual(req.body,{filter:{version:1}});res.json({data:{productIds:['123']}});}};
 await withServer(fakeShopify(),async base=>{
  const result=await fetch(`${base}/api/filters/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filter:{version:1}})});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{data:{productIds:['123']}});
 },{filterRuntime:runtime});
 assert.ok(searched);
 captured=false;searched=false;
 await withServer(fakeShopify({authenticated:false}),async base=>{
  assert.equal((await fetch(`${base}/api/filters/search`,{method:'POST'})).status,401);
 },{filterRuntime:runtime});
 assert.equal(captured,false);assert.equal(searched,false);
});

test('development HTML initializes React Refresh before the frontend entry', async()=>{
 await withServer(fakeShopify(),async base=>{
  const html=await (await fetch(`${base}/`)).text();
  assert.match(html,/import "\/dev_embed\.js"; import "\/main\.jsx";/);
  assert.doesNotMatch(html,/src="\/main\.jsx"/);
 },{development:true});
 await withServer(fakeShopify(),async base=>{
  const html=await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html,/import "\/dev_embed\.js"/);
  assert.match(html,/src="\/main\.jsx"/);
 },{development:false});
});

test('template populate endpoint creates five products with the current mutation', async()=>{
 const requests=[];
 await withServer(fakeShopify({requests}),async base=>{
  const response=await fetch(`${base}/api/products`,{method:'POST'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{success:true,error:null});
 });
 assert.equal(requests.length,5);
 for(const request of requests){
  assert.match(request.query,/productCreate\(product: \$product\)/);
  assert.ok(request.options.variables.product.title);
 }
});

test('Shopify product validation errors stop creation and return a failed response', async()=>{
 const productErrors=[{field:['product','title'],message:'Invalid title'}];
 const requests=[];
 await assert.rejects(productCreator(fakeShopify({productErrors}),{}),/Invalid title/);
 await withServer(fakeShopify({productErrors,requests}),async base=>{
  const response=await fetch(`${base}/api/products`,{method:'POST'});
  assert.equal(response.status,500);
  assert.equal((await response.json()).success,false);
 });
 assert.equal(requests.length,1);
});

test('sample writes reload storage and enforce both app and online staff permission',async()=>{
 for(const kind of ['read-only','online-read-only','online-write','revoked']){
  const requests=[],shopify=fakeShopify({requests}),storage=shopify.config.sessionStorage;
  const id='offline_example.myshopify.com',session=await storage.loadSession(id);
  if(kind==='read-only')session.scope='read_products';
  if(kind.startsWith('online-')){
   session.isOnline=true;session.expires=new Date(Date.now()+60000);
   session.onlineAccessInfo={associated_user_scope:kind==='online-write'?'write_products':'read_products',associated_user:{id:42}};
  }
  if(kind==='revoked')await storage.deleteSession(id);else await storage.storeSession(session);
  await withServer(shopify,async base=>{
   const response=await fetch(`${base}/api/products`,{method:'POST'});
   assert.equal(response.status,kind==='online-write'?200:kind==='revoked'?401:403,kind);
  });
  assert.equal(requests.length,kind==='online-write'?5:0,kind);
 }
});

test('unknown webhook paths never fall through to merchant authentication',async()=>{
 const shopify=fakeShopify();let authenticated=0;
 shopify.validateAuthenticatedSession=()=> (_req,_res,next)=>{authenticated++;next();};
 await withServer(shopify,async base=>{
  for(const path of ['/api/webhooks/unknown','/api/webhooks']){
   const response=await fetch(base+path);
   assert.equal(response.status,404);assert.equal((await response.json()).error,'WEBHOOK_ROUTE_NOT_FOUND');
  }
 });
 assert.equal(authenticated,0);
});

test('uninstall and shop-redact remove only the affected shops sessions',async()=>{
 const storage=new MemorySessionStorage();
 for(const shop of ['one.myshopify.com','two.myshopify.com']) await storage.storeSession(new Session({id:`offline_${shop}`,shop,state:'test',isOnline:false,accessToken:'test-token'}));
 const handlers=createWebhookHandlers(storage);
 await handlers.APP_UNINSTALLED.callback('APP_UNINSTALLED','one.myshopify.com');
 assert.equal((await storage.findSessionsByShop('one.myshopify.com')).length,0);
 assert.equal((await storage.findSessionsByShop('two.myshopify.com')).length,1);
 await handlers.SHOP_REDACT.callback('SHOP_REDACT','two.myshopify.com');
 assert.equal((await storage.findSessionsByShop('two.myshopify.com')).length,0);
});

test('official Shopify webhook middleware verifies raw signatures before JSON parsing',async()=>{
 const secret='template-test-secret';
 const shopify=shopifyApp({api:{apiKey:'template-test-key',apiSecretKey:secret,scopes:['read_products'],hostName:'example.test',isEmbeddedApp:true,apiVersion:'2026-10'},auth:{path:'/api/auth',callbackPath:'/api/auth/callback'},webhooks:{path:'/api/webhooks'},sessionStorage:new MemorySessionStorage()});
 await withServer(shopify,async base=>{
  const body=JSON.stringify({shop_domain:'example.myshopify.com'});
  const headers={'Content-Type':'application/json','X-Shopify-Topic':'app/uninstalled','X-Shopify-Shop-Domain':'example.myshopify.com','X-Shopify-Webhook-Id':'template-test-event','X-Shopify-API-Version':'2026-10','X-Shopify-Hmac-Sha256':createHmac('sha256',secret).update(body).digest('base64')};
  const valid=await fetch(`${base}/api/webhooks`,{method:'POST',headers,body}); assert.equal(valid.status,200);
  const invalid=await fetch(`${base}/api/webhooks`,{method:'POST',headers:{...headers,'X-Shopify-Hmac-Sha256':'invalid'},body}); assert.equal(invalid.status,401);
  const tampered=await fetch(`${base}/api/webhooks`,{method:'POST',headers,body:body+' '});assert.equal(tampered.status,401);
  const unsigned=await fetch(`${base}/api/webhooks`,{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(unsigned.status,400);
 });
});

test('shopify-auth middleware rejects missing, malformed, or expired sessions and bridges WeakMap auth contexts',async()=>{
 assert.equal(isValidShopifyDomain('example.myshopify.com'),true);
 assert.equal(isValidShopifyDomain('evil.com'),false);
 assert.equal(isValidShopifySession({shop:'example.myshopify.com',id:'s1',accessToken:'tok'},{requireCredentials:true}),true);
 assert.equal(isValidShopifySession({shop:'example.myshopify.com'},{requireCredentials:true}),false);
 assert.equal(isValidShopifySession({shop:'example.myshopify.com',expires:new Date(Date.now()-1000)}),false);
 assert.throws(()=>createShopifyAuthMiddleware({}),/validateAuthenticatedSession/);

 for(const badSession of [null,{},{shop:'invalid-domain.com'},{shop:'example.myshopify.com',expires:new Date(Date.now()-5000)}]){
  const shopify=fakeShopify();
  shopify.validateAuthenticatedSession=()=> (_req,res,next)=>{res.locals.shopify={session:badSession};next();};
  await withServer(shopify,async base=>{
   assert.equal((await fetch(`${base}/api/products/count`)).status,401);
  });
 }

 const storage=new MemorySessionStorage();
 await storage.storeSession(new Session({id:'offline_example.myshopify.com',shop:'example.myshopify.com',state:'s',isOnline:false,accessToken:'token-1',scope:'read_products'}));
 const authService=createAuthenticatedSessionService({sessionStorage:storage,resolveInstallation:createInstallationResolver({readInstallation:async()=>({installation_version:'test-installation'})})});
 const req={},res={locals:{shopify:{session:{id:'offline_example.myshopify.com',shop:'example.myshopify.com',accessToken:'token-1',isOnline:false}}}};
 await authService.capture(req,res,()=>{});
 const ctx=await authService.authenticate(req);
 assert.ok(ctx);
 const verified=await authService.requireAuthenticatedShop(ctx);
 assert.deepEqual(verified,{shopId:'example.myshopify.com',installationId:'test-installation',installationVersion:'test-installation',sessionId:'offline_example.myshopify.com',scope:'read_products'});
 await assert.rejects(()=>authService.requireAuthenticatedShop({}),/Authenticated filter session required/);
});



test('all protected API families reject revoked installations before invoking handlers',async()=>{
 const paths=['/api/products','/api/products/count','/api/mirror/count','/api/mirror/status','/api/mirror/sync','/api/catalog/capabilities','/api/filters/search','/api/exports','/api/history','/api/shopify-data/sources'];
 await withServer(fakeShopify(),async base=>{
  for(const path of paths)assert.equal((await fetch(base+path)).status,403,path);
 },{installationDatabase:{async connect(){return {async query(sql,params){if(sql.includes('FROM mirror.shops')){assert.match(sql,/uninstalled_at IS NULL/);assert.deepEqual(params,['example.myshopify.com']);}return {rows:[]};},release(){}};}}});
});
test('installation checks fail closed when unavailable',async()=>{
 await withServer(fakeShopify(),async base=>assert.equal((await fetch(base+'/api/products/count')).status,503),{installationDatabase:null});
});
