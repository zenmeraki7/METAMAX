import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createExportQueueEvidence,assertExportQueuePayload} from "./export-dispatch.server.js";
const event={id:randomUUID(),delivery_key:randomUUID(),job_id:randomUUID()};
function fixture({receipt=false,jobState="QUEUED",queueState=null}={}) {
  const queries=[];let leaseChecks=0;
  const query=async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes("SELECT r.event_id"))return {rows:receipt?[{event_id:event.id}]:[]};
    if(sql.includes("SELECT j.*"))return {rows:jobState==="QUEUED"?[{id:event.job_id,shop_id:"dispatch.myshopify.com",installation_id:"install",fence_epoch:"12"}]:[]};
    return {rows:[]};
  };
  const database={query,async connect(){return {query,release(){}};}};
  const queue={async getJob(id){return queueState?{id,name:"export",data:{eventId:event.id},async getState(){return queueState;}}:null;}};
  const generationProtection={async verify(){leaseChecks++;return {verified:true};}};
  return {evidence:createExportQueueEvidence({database,queue,generationProtection}),queries,get leaseChecks(){return leaseChecks;},queue};
}
test("missing BullMQ job without fenced database replay proof requires review",async()=>{
  const f=fixture({jobState:"RUNNING"});
  assert.equal((await f.evidence.reconcileDelivery({event})).decision,"REVIEW_REQUIRED");
  assert.equal(f.leaseChecks,0);
});
test("redelivery after Redis loss requires exact-generation and database fencing evidence",async()=>{
  const f=fixture(),proof=await f.evidence.reconcileDelivery({event});
  assert.equal(proof.decision,"RETRY_ELIGIBLE");assert.equal(proof.safeToRetry,true);assert.equal(proof.source,"POSTGRES_FENCED_REPLAY");
  assert.equal(f.leaseChecks,1);assert.equal(f.queries.at(-1).sql,"COMMIT");
  const selection=f.queries.find(q=>q.sql.includes("SELECT j.*"));assert.match(selection.sql,/lease_token IS NULL/);assert.match(selection.sql,/NOT j.cancel_requested/);
});
test("durable observation confirms delivery despite Redis job removal",async()=>{
  const f=fixture({receipt:true});
  assert.equal((await f.evidence.verifyDeliveryEvidence({event,evidence:{confirmed:false}})).source,"POSTGRES_OBSERVATION");
});
test("an observed token that failed before capacity was available can be safely rescheduled",async()=>{
  const f=fixture({receipt:true,queueState:"failed"});
  const proof=await f.evidence.reconcileDelivery({event});
  assert.equal(proof.decision,"RETRY_ELIGIBLE");assert.equal(f.leaseChecks,1);
});
test("a retained completed token does not authorize rerunning a completed export",async()=>{
  const f=fixture({receipt:true,queueState:"completed",jobState:"COMPLETED"});
  assert.equal((await f.evidence.reconcileDelivery({event})).decision,"DELIVERED");assert.equal(f.leaseChecks,0);
});
test("queue inspection errors remain uncertain; no database replay proof is issued",async()=>{
  const f=fixture();f.queue.getJob=async()=>{throw Error("redis unavailable");};
  await assert.rejects(()=>f.evidence.reconcileDelivery({event}),/redis unavailable/);
  assert.ok(!f.queries.some(q=>q.sql==="BEGIN"));
});
test("queue payload cannot override tenant, cursor or filter",()=>{
  assert.throws(()=>assertExportQueuePayload({eventId:event.id,shopId:"forged"}),TypeError);
  assert.throws(()=>assertExportQueuePayload({eventId:"not-uuid"}),TypeError);
});
