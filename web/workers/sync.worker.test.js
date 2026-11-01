import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSyncProcessor,
  createBullMQSyncWorker,
  createBullMQRecoveryWorker,
  SyncWorkerError,
  SYNC_QUEUE_NAME,
  RECOVERY_QUEUE_NAME,
} from "./sync.worker.js";

const claim = Object.freeze({ runId: "run-1", shopId: "sync.myshopify.com", generationId: "generation-1",
  leaseToken: "lease-1", fence: "1", phase: "STARTING", attempt: 0 });
const quiet = { info() {}, error() {} };
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return { promise, resolve, reject }; };
function fixture({ claimed = claim, repository = {}, steps = {}, options = {} } = {}) {
  const calls = { claim: [], renew: [], step: [], failure: [], adapters: [] };
  const repo = {
    async claimRun(input) { calls.claim.push(input); return claimed; },
    async renewLease(input) { calls.renew.push(input); return { kind: "RENEWED" }; },
    async recordStep(input) { calls.step.push(input); return { kind: "RECORDED" }; },
    async recordFailure(input) { calls.failure.push(input); return { kind: "RECORDED" }; },
    ...repository,
  };
  const syncSteps = Object.fromEntries(["startBulk","checkBulk","ingestChunk","reconcile","publish"].map(method => [method, async input => {
    calls.adapters.push({ method, ...input }); return { kind: method === "publish" ? "COMPLETE" : "ADVANCE" };
  }]));
  Object.assign(syncSteps, steps);
  const processor = createSyncProcessor({ repository: repo, syncSteps, workerId: "worker-1", logger: quiet, ...options });
  return { processor, repo, syncSteps, calls };
}

test("sync processor requires every repository/step method and bounded execution settings", () => {
  assert.throws(() => createSyncProcessor(), /claimRun/);
  const f=fixture();
  for (const method of ["claimRun","renewLease","recordStep","recordFailure"]) {
    assert.throws(() => createSyncProcessor({ repository:{...f.repo,[method]:null},syncSteps:f.syncSteps }), new RegExp(method));
  }
  for (const method of Object.keys(f.syncSteps)) {
    assert.throws(() => createSyncProcessor({ repository:f.repo,syncSteps:{...f.syncSteps,[method]:null} }), new RegExp(method));
  }
  for (const options of [{leaseSeconds:0},{leaseSeconds:3601},{stepTimeoutMs:0},{heartbeatMs:0},{workerId:"bad worker"},{leaseSeconds:1,heartbeatMs:500}]) {
    assert.throws(() => fixture({options}));
  }
});

test("queue notification identity cannot supply shop, phase, or generation authority", async () => {
  const f=fixture();
  await assert.rejects(() => f.processor.processRun({runId:"run-1",shopId:"evil.myshopify.com"}), /Invalid SyncRun/);
  assert.equal(f.calls.claim.length,0);
  assert.deepEqual(await fixture({claimed:null}).processor.processRun("run-1"),{kind:"NOT_CLAIMED",runId:"run-1"});
});

for (const invalid of [{runId:"other"},{shopId:"bad shop"},{generationId:""},{leaseToken:""},{fence:"0"},
  {fence:"9223372036854775808"},{fence:1n},{phase:"UNKNOWN"},{attempt:-1},{attempt:1.5}]) {
  test(`sync rejects an invalid durable claim: ${JSON.stringify(invalid,(_key,value)=>typeof value==="bigint" ? String(value) : value)}`, async () => {
    const f=fixture({claimed:{...claim,...invalid}});
    await assert.rejects(() => f.processor.processRun("run-1"));
    assert.equal(f.calls.adapters.length,0);assert.equal(f.calls.step.length,0);
  });
}

for (const [phase,method] of Object.entries({STARTING:"startBulk",WAITING:"checkBulk",INGESTING:"ingestChunk",RECONCILING:"reconcile",PUBLISHING:"publish"})) {
  test(`one invocation executes only the authoritative ${phase} step`, async () => {
    const f=fixture({claimed:{...claim,phase}});
    const result=await f.processor.processRun("run-1");
    assert.equal(result.kind,phase==="PUBLISHING" ? "COMPLETE" : "ADVANCE");
    assert.equal(f.calls.adapters.length,1);assert.equal(f.calls.adapters[0].method,method);
    assert.ok(Object.isFrozen(f.calls.adapters[0].claim));
    assert.deepEqual(f.calls.step[0].claim,{...claim,phase});
    assert.equal(f.calls.failure.length,0);
  });
}

test("DEFER persists the delay through the database before acknowledging delivery", async () => {
  const f=fixture({steps:{startBulk:async()=>({kind:"DEFER",delayMs:1234})}});
  assert.equal((await f.processor.processRun("run-1")).delayMs,1234);
  assert.deepEqual(f.calls.step[0].result,{kind:"DEFER",delayMs:1234});
});

test("malformed results and premature completion cannot advance a phase", async () => {
  for (const result of [null,{kind:"UNKNOWN"},{kind:"COMPLETE"},{kind:"DEFER",delayMs:0},{kind:"DEFER",delayMs:900001}]) {
    const f=fixture({steps:{startBulk:async()=>result}});
    assert.equal((await f.processor.processRun("run-1")).kind,"REVIEW_REQUIRED");
    assert.equal(f.calls.step.length,0);assert.equal(f.calls.failure[0].failure.retryable,false);
  }
  const f=fixture({claimed:{...claim,phase:"PUBLISHING"},steps:{publish:async()=>({kind:"ADVANCE"})}});
  assert.equal((await f.processor.processRun("run-1")).kind,"REVIEW_REQUIRED");
});

test("claim and result accessors are rejected without invoking them", async () => {
  const malicious={...claim};Object.defineProperty(malicious,"phase",{get(){assert.fail("Claim getter invoked");}});
  await assert.rejects(()=>fixture({claimed:malicious}).processor.processRun("run-1"));
  const result={get kind(){assert.fail("Result getter invoked");}};
  const f=fixture({steps:{startBulk:async()=>result}});
  assert.equal((await f.processor.processRun("run-1")).kind,"REVIEW_REQUIRED");
});

test("uncertain adapter failures persist bounded retry eligibility", async () => {
  const f=fixture({claimed:{...claim,attempt:Number.MAX_SAFE_INTEGER},steps:{startBulk:async()=>{throw new Error("network");}}});
  assert.equal((await f.processor.processRun("run-1")).kind,"RETRY_SCHEDULED");
  assert.deepEqual(f.calls.failure[0].failure,{code:"SYNC_OPERATION_FAILED",retryable:true,outcomeUncertain:true,retryAfterMs:900000});
});

test('failure diagnostics never invoke error accessors or prevent durable recovery',async()=>{
 let getters=0;const failure=new Error('private dependency details');
 Object.defineProperty(failure,'code',{get(){getters++;throw Error('must not run');}});
 const events=[];
 const f=fixture({steps:{startBulk:async()=>{throw failure;}},options:{logger:{info(){},error(event){events.push(event);}}}});
 assert.equal((await f.processor.processRun('run-1')).kind,'RETRY_SCHEDULED');
 assert.equal(getters,0);assert.equal(f.calls.failure.length,1);
 const event=events.find(e=>e.event==='catalog_sync_failure');
 assert.equal(event.sourceCode,null);assert.equal(JSON.stringify(event).includes('private dependency details'),false);
});

test("a hard deadline ends the wait for an adapter that ignores cancellation", {timeout:2000}, async () => {
  let signal;
  const f=fixture({options:{leaseSeconds:1,heartbeatMs:100,stepTimeoutMs:25},steps:{startBulk:({signal:current})=>{signal=current;return new Promise(()=>{});}}});
  assert.equal((await f.processor.processRun("run-1")).kind,"RETRY_SCHEDULED");
  assert.equal(signal.aborted,true);assert.equal(f.calls.failure[0].failure.code,"STEP_TIMEOUT");
  assert.equal(f.calls.step.length,0);
});

test("a hung heartbeat cannot defeat the step deadline or authorize a final write", {timeout:2000}, async () => {
  const started=deferred();
  const f=fixture({options:{leaseSeconds:1,heartbeatMs:2,stepTimeoutMs:50},repository:{renewLease(){started.resolve();return new Promise(()=>{});}},
    steps:{startBulk:async()=>{await started.promise;return {kind:"ADVANCE"};}}});
  assert.equal((await f.processor.processRun("run-1")).kind,"STALE_CLAIM");
  assert.equal(f.calls.step.length,0);assert.equal(f.calls.failure.length,0);
});

for (const renewLease of [async()=>({kind:"STALE_CLAIM"}),async()=>{throw new Error("database down");}]) {
  test("lease loss overrides adapter success and prevents acknowledgment", {timeout:2000}, async () => {
    let signal;
    const f=fixture({options:{leaseSeconds:1,heartbeatMs:2,stepTimeoutMs:100},repository:{renewLease},steps:{startBulk:({signal:current})=>{signal=current;return new Promise(()=>{});}}});
    assert.equal((await f.processor.processRun("run-1")).kind,"STALE_CLAIM");
    assert.equal(signal.aborted,true);assert.equal(f.calls.step.length,0);assert.equal(f.calls.failure.length,0);
  });
}

test("final acknowledgment waits for an in-flight renewal and heartbeats never overlap", {timeout:2000}, async () => {
  const started=deferred(),renewed=deferred(),finishStep=deferred();let renewals=0,records=0;
  const f=fixture({options:{leaseSeconds:1,heartbeatMs:2,stepTimeoutMs:200},repository:{
    renewLease(){renewals++;started.resolve();return renewed.promise;},recordStep(){records++;return {kind:"RECORDED"};},
  },steps:{startBulk:async()=>{await started.promise;await finishStep.promise;return {kind:"ADVANCE"};}}});
  const processing=f.processor.processRun("run-1");await started.promise;await delay(12);
  assert.equal(renewals,1);finishStep.resolve();await delay(4);assert.equal(records,0);
  renewed.resolve({kind:"RENEWED"});assert.equal((await processing).kind,"ADVANCE");assert.equal(records,1);
});

test("repository calls are bounded and unknown commit outcomes remain uncertain", {timeout:2000}, async () => {
  for (const method of ["claimRun","recordStep","recordFailure"]) {
    const f=fixture({options:{leaseSeconds:1,heartbeatMs:100,stepTimeoutMs:20},repository:{[method]:()=>new Promise(()=>{})},
      ...(method==="recordFailure" ? {steps:{startBulk:async()=>{throw new Error("failed");}}} : {})});
    await assert.rejects(()=>f.processor.processRun("run-1"),error=>error.code==="DURABLE_RESULT_UNKNOWN" && error.outcomeUncertain);
  }
});

test("only verified durable outcomes can acknowledge successful or failed steps", async () => {
  for (const kind of ["RECORDED","STALE_CLAIM",undefined,"UNKNOWN"]) {
    const f=fixture({repository:{recordStep:async()=>({kind})}});
    if (["RECORDED","STALE_CLAIM"].includes(kind)) assert.equal((await f.processor.processRun("run-1")).kind,kind==="RECORDED"?"ADVANCE":kind);
    else await assert.rejects(()=>f.processor.processRun("run-1"),error=>error.outcomeUncertain);
  }
  const f=fixture({repository:{recordFailure:async()=>({kind:"STALE_CLAIM"})},steps:{startBulk:async()=>{throw new Error("failed");}}});
  assert.equal((await f.processor.processRun("run-1")).kind,"STALE_CLAIM");
});

test("logger failures and rejected logger promises cannot change durable outcomes", async () => {
  for (const logger of [{info(){throw new Error("log failure");}}, {info:async()=>{throw new Error("async log failure");}}]) {
    assert.equal((await fixture({options:{logger}}).processor.processRun("run-1")).kind,"ADVANCE");
  }
});

test("duplicate delivery and a timed-out old adapter rely on repository fencing", {timeout:2000}, async () => {
  const old=deferred();let fence=0,phase="STARTING",leased=false,mirror="",acknowledgments=0;
  const repository={
    claimRun(){if(leased||phase!=="STARTING")return null;leased=true;return {...claim,fence:String(++fence)};},
    renewLease:async()=>({kind:"RENEWED"}),
    recordFailure({claim:observed}){if(observed.fence!==String(fence))return {kind:"STALE_CLAIM"};leased=false;return {kind:"RECORDED"};},
    recordStep({claim:observed}){if(!leased||observed.fence!==String(fence))return {kind:"STALE_CLAIM"};phase="WAITING";leased=false;acknowledgments++;return {kind:"RECORDED"};},
  };
  const f=fixture({repository,options:{leaseSeconds:1,heartbeatMs:100,stepTimeoutMs:25},steps:{startBulk:async({claim:observed})=>{
    if(observed.fence==="1") await old.promise;
    if(leased&&phase==="STARTING"&&observed.fence===String(fence))mirror=observed.fence;
    return {kind:"ADVANCE"};
  }}});
  assert.equal((await f.processor.processRun("run-1")).kind,"RETRY_SCHEDULED");
  assert.equal((await f.processor.processRun("run-1")).kind,"ADVANCE");
  old.resolve();await delay(0);
  assert.equal(mirror,"2");assert.equal(acknowledgments,1);
  assert.equal((await f.processor.processRun("run-1")).kind,"NOT_CLAIMED");
});

test("BullMQ adapter accepts only plain runId data and starts paused", async () => {
  let process,config,queue;const events=new Map(),calls=[];
  class Worker { constructor(name,fn,options){queue=name;process=fn;config=options;} on(name,fn){events.set(name,fn);} }
  const connection={};
  const worker=createBullMQSyncWorker({Worker,connection,processor:{processRun:async runId=>{calls.push(runId);return "processed";}},logger:quiet});
  assert.ok(worker instanceof Worker);assert.equal(queue,SYNC_QUEUE_NAME);assert.strictEqual(config.connection,connection);
  assert.deepEqual([config.autorun,config.concurrency,config.maxStalledCount],[false,2,2]);
  assert.equal(await process({data:{runId:"run-1"}}),"processed");
  const accessor={get runId(){assert.fail("Queue getter invoked");}};
  const symbol={runId:"run-1",[Symbol("hidden")]:true};
  for(const data of [null,[],{}, {runId:1},{runId:"run-1",shopId:claim.shopId},accessor,symbol,Object.create({runId:"run-1"})]) {
    await assert.rejects(()=>process({data}));
  }
  assert.deepEqual(calls,["run-1"]);
  for(const event of ["failed","stalled","error"])assert.equal(typeof events.get(event),"function");
});

test("BullMQ adapter validates its required dependencies", () => {
  assert.throws(()=>createBullMQSyncWorker(),/constructor/);
  assert.throws(()=>createBullMQSyncWorker({Worker:class {}}),/Redis/);
  assert.throws(()=>createBullMQSyncWorker({Worker:class {},connection:{}}),/processRun/);
  assert.throws(()=>createBullMQSyncWorker({Worker:class {},connection:{},processor:{processRun(){}},concurrency:33}),/concurrency/);
});

test("BullMQ recovery adapter accepts only plain runId data and validates dependencies", async () => {
  let process,config,queue;const events=new Map(),calls=[];
  class Worker { constructor(name,fn,options){queue=name;process=fn;config=options;} on(name,fn){events.set(name,fn);} }
  const connection={};
  const worker=createBullMQRecoveryWorker({Worker,connection,recovery:{recoverRun:async runId=>{calls.push(runId);return "recovered";}},logger:quiet});
  assert.ok(worker instanceof Worker);assert.equal(queue,RECOVERY_QUEUE_NAME);assert.strictEqual(config.connection,connection);
  assert.deepEqual([config.autorun,config.concurrency,config.maxStalledCount],[false,2,2]);
  assert.equal(await process({data:{runId:"run-1"}}),"recovered");
  const accessor={get runId(){assert.fail("Queue getter invoked");}};
  const symbol={runId:"run-1",[Symbol("hidden")]:true};
  for(const data of [null,[],{},{runId:1},{runId:"run-1",shopId:claim.shopId},accessor,symbol,Object.create({runId:"run-1"})]) {
    await assert.rejects(()=>process({data}));
  }
  assert.deepEqual(calls,["run-1"]);
  for(const event of ["failed","stalled","error"])assert.equal(typeof events.get(event),"function");
  assert.throws(()=>createBullMQRecoveryWorker(),/constructor/);
  assert.throws(()=>createBullMQRecoveryWorker({Worker:class {}}),/Redis/);
  assert.throws(()=>createBullMQRecoveryWorker({Worker:class {},connection:{}}),/recoverRun/);
  assert.throws(()=>createBullMQRecoveryWorker({Worker:class {},connection:{},recovery:{recoverRun(){}},concurrency:33}),/concurrency/);
});
