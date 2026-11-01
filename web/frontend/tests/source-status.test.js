import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchShopifyData,requestShopifyRefresh} from '../services/shopifyData.api.js';
test('unavailable source endpoint never falls back to fabricated healthy mirror data',async()=>{
  const original=globalThis.fetch;const calls=[];
  try {
    globalThis.fetch=async url=>{calls.push(url);return {ok:false,status:503,json:async()=>({error:'SOURCES_UNAVAILABLE'})};};
    await assert.rejects(()=>fetchShopifyData(),/SOURCES_UNAVAILABLE/);assert.deepEqual(calls,['/api/shopify-data/sources']);
  }finally{globalThis.fetch=original;}
});
test('source status preserves null/actual times and rejects malformed responses and unsupported refreshes',async()=>{
  const original=globalThis.fetch;let calls=0;
  const payload={shopTimeZone:'UTC',sources:[{id:'collections',name:'Collections',status:'unavailable',lastFullSyncAt:null}]};
  try {
    globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>payload};};
    assert.deepEqual(await fetchShopifyData(),payload);
    await assert.rejects(()=>requestShopifyRefresh('collections'),/not available/);assert.equal(calls,1);
    payload.sources[0].lastFullSyncAt='not-a-time';await assert.rejects(()=>fetchShopifyData(),/Invalid source/);
  }finally{globalThis.fetch=original;}
});
