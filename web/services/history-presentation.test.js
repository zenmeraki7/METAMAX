import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createHistoryRouter} from '../edit-history/history.routes.js';

test('history list and detail preserve operation titles, partial counts and unknown states',async()=>{
 const kinds=['UNDO','EXPORT','IMPORT','BULK_EDIT'];
 const states=['COMPLETED','PARTIAL','FAILED','RECORDING','ACTIVE','RECONCILING','CANCELLED','FUTURE_STATE',null];
 const records=states.map((state,i)=>({operationId:String(i),operationKind:kinds[i%4],state,
  counts:{recorded:10,verified:7,failed:2,uncertain:1},createdAt:'2026-11-01T00:00:00Z',completedAt:null}));
 const diagnostics=[];let authorized=true,reads=0;
 const app=express();app.use('/history',createHistoryRouter({authentication:{async authenticate(){return authorized?{}:null;}},
  logger:{error(event){diagnostics.push(event);}},historyReadService:{
   async listOperations(){reads++;return {items:records,nextCursor:null};},
   async getOperation({operationId}){reads++;return records.find(r=>r.operationId===operationId);}
  }}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}/history`;
  const list=await (await fetch(base)).json();
  assert.deepEqual(list.operations.map(o=>o.status),['Completed','Partial','Failed','Pending','In Progress','In Progress','Cancelled','Unknown','Unknown']);
  assert.deepEqual(list.operations.slice(0,4).map(o=>[o.type,o.title]),[
   ['Undo','Undo Operation'],['Export','Product Export'],['Import','Product Import'],['Edit','Bulk Product Edit']]);
  for(const row of list.operations){
   assert.equal(row.processedCount,7);assert.equal(row.failedCount,2);assert.equal(row.totalCount,10);assert.equal(row.uncertainCount,1);
   assert.equal(row.countUnit,'fields');
   const detail=(await (await fetch(`${base}/${row.id}`)).json()).operation;
   assert.equal(detail.status,row.status);assert.equal(detail.title,row.title);assert.equal(detail.changesFailed,row.failedCount);
   assert.equal(detail.countUnit,'fields');
   assert.equal(detail.changesVerified,row.processedCount);assert.equal(detail.changesRecorded,row.totalCount);assert.equal(detail.changesUncertain,1);
  }
  assert.equal(diagnostics.length,4);assert.ok(diagnostics.every(event=>event.code==='HISTORY_STATUS_UNRECOGNIZED'));
  const before=reads;authorized=false;assert.equal((await fetch(base)).status,401);assert.equal(reads,before);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
