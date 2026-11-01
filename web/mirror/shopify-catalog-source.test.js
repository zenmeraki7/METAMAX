import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompleteProduct} from './shopify-catalog-source.server.js';
const id='gid://shopify/Product/1';
test('a partial product family cannot be certified without an advancing cursor',async()=>{
 for(const pageInfo of [{hasNextPage:true},{hasNextPage:true,endCursor:undefined},{hasNextPage:true,endCursor:null},{hasNextPage:true,endCursor:''}]){
  let reads=0;
  await assert.rejects(()=>readCompleteProduct({productId:id,client:{async request(){reads++;return {data:{product:{id,variants:{nodes:[{id:'gid://shopify/ProductVariant/1'}],pageInfo}}}};}}}),/pagination did not advance/);
  assert.equal(reads,1);
 }
 let reads=0;
 await assert.rejects(()=>readCompleteProduct({productId:id,client:{async request(){reads++;return {data:{product:{id,variants:{nodes:[{id:`gid://shopify/ProductVariant/${reads}`}],pageInfo:{hasNextPage:true,endCursor:'same'}}}}};}}}),/pagination did not advance/);
 assert.equal(reads,2);
});
