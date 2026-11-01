import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogImportService} from './catalog-import.server.js';
import {hasCurrentProductRead} from '../middleware/product-permission.server.js';
const shop='staff.myshopify.com',id='12345678-1234-4234-9234-123456789abc';
test('interactive sync controls cannot use offline authority to broaden current staff permissions',async()=>{
 for(const staffScope of ['read_orders','',undefined]){
  let queries=0;const stored={id:'online',shop,isOnline:true,expires:new Date(Date.now()+60000),scope:'read_products',accessToken:'token',onlineAccessInfo:{associated_user_scope:staffScope}};
  const database={async query(){queries++;return {rows:[]};},async connect(){queries++;throw Error('Unauthorized database access');}};
  const service=createCatalogImportService({database,shopify:{config:{sessionStorage:{loadSession:async()=>stored,findSessionsByShop:async()=>[{...stored,isOnline:false}]}}}});
  for(const call of [()=>service.enqueue({...stored,isOnline:false,scope:'write_products'}),()=>service.status(stored,id),()=>service.current(stored),()=>service.cancel(stored,id)])
   await assert.rejects(call,{code:'IMPORT_PERMISSION_DENIED'});
  assert.equal(queries,0);
 }
 assert.equal(hasCurrentProductRead({scope:'read_products',isOnline:false}),true);
 assert.equal(hasCurrentProductRead({scope:'read_products',isOnline:true,onlineAccessInfo:{associated_user_scope:'write_products'}}),true);
 assert.equal(hasCurrentProductRead({scope:'read_orders',isOnline:true,onlineAccessInfo:{associated_user_scope:'read_products'}}),false);
});
