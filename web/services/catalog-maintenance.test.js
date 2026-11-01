import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogMaintenance} from './catalog-maintenance.server.js';
test('catalog maintenance serializes cycles, binds tenant scopes and limits reclamation and audit work',async()=>{
 const calls=[];let release;const database={query(sql,params){calls.push({sql,params});return new Promise(resolve=>release=resolve);},async connect(){return {async query(sql,params){calls.push({sql,params});return {rows:[],rowCount:0};},release(){}};}};
 const service=createCatalogMaintenance({database,logger:{error(){}}});
 const first=service.runOnce();assert.strictEqual(service.runOnce(),first);assert.equal(calls.length,1);
 assert.match(calls[0].sql,/LIMIT 5/);release({rows:[{shop_id:'maintenance.myshopify.com'}]});
 assert.deepEqual(await first,{shops:1,reclaimed:0});
 assert.ok(calls.some(c=>c.sql.includes('LIMIT 5 FOR UPDATE OF g SKIP LOCKED')));
 assert.ok(calls.some(c=>c.sql.includes('90 days')&&c.sql.includes('LIMIT 100')));
 for(const call of calls.filter(c=>c.sql.includes("set_config('app.shop_id'")))assert.deepEqual(call.params,['maintenance.myshopify.com']);
 await service.stop();
});
