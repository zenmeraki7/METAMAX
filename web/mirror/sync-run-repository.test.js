import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRunRepository } from "./sync-run-repository.server.js";
import { createSyncProcessor, SyncWorkerError } from "../workers/sync.worker.js";

const epoch = Date.parse("2026-10-29T10:00:00Z");
const initial = (id = "run-1", shopId = "repo.myshopify.com") => ({ id,shopId,generationId:"generation-1",phase:"STARTING",fence:"0",attempt:0,
  leaseToken:null,leaseExpiresAt:null,nextEligibleAt:null,completedAt:null,reviewRequired:false,outcomeUncertain:false,recoveryAttempts:0 });

/**
 * In-memory repository contract adapter. The fixture simulates serialized
 * execution and rollback using a mutex and a cloned Map. It does not exercise
 * PostgreSQL transactions, row locks, isolation, or database concurrency.
 */
function fixture({ rows = [initial()], overrides = {}, dbOverrides = {}, maxAttempts = 12 } = {}) {
  let stored = new Map(rows.map(row => [row.id,structuredClone(row)])), clock = epoch, tail = Promise.resolve();
  const calls = [], patches = [];
  const db = {
    async getRunShop(id) { calls.push("hint"); return stored.get(id)?.shopId ?? null; },
    async transaction(work, options) {
      assert.equal(options.isolationLevel,"Serializable");
      const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;
      const draft=structuredClone(stored);
      const owns = (run,c) => run && run.id===c.runId && run.shopId===c.shopId && run.generationId===c.generationId &&
        run.phase===c.phase && run.leaseToken===c.leaseToken && String(run.fence)===c.fence && run.attempt===c.attempt &&
        run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()>clock;
      const tx = {
        now: async()=>new Date(clock),
        lockShop: async shopId=>{calls.push("shop");return [...draft.values()].some(run=>run.shopId===shopId);},
        lockRun: async id=>{calls.push("run");return draft.get(id)??null;},
        hasOtherLiveRun: async(shopId,id)=>[...draft.values()].some(run=>run.id!==id&&run.shopId===shopId&&run.leaseExpiresAt&&new Date(run.leaseExpiresAt).getTime()>clock),
        async claimRun(id,p) {
          calls.push("claim");patches.push(p);const run=draft.get(id);
          if(!run||run.shopId!==p.shopId||run.generationId!==p.expectedGenerationId||run.phase!==p.expectedPhase||String(run.fence)!==p.expectedPreviousFence)return null;
          Object.assign(run,{leaseToken:p.leaseToken,leaseExpiresAt:new Date(clock+p.leaseSeconds*1000),fence:p.fence,attempt:p.attempt});return run;
        },
        async renewRun(id,p) {
          calls.push("renew");patches.push(p);const run=draft.get(id);if(!owns(run,p.claim))return null;
          run.leaseExpiresAt=new Date(clock+p.leaseSeconds*1000);return run;
        },
        verifyStepEvidence: async()=>{calls.push("evidence");return true;},
        verifyPublished: async()=>{calls.push("published");return true;},
        async commitStep(id,p) {
          calls.push("step");patches.push(p);const run=draft.get(id);if(!owns(run,p.claim))return null;
          run.leaseToken=null;run.leaseExpiresAt=null;run.attempt=0;
          if(p.kind==="ADVANCE"){run.phase=p.nextPhase;run.nextEligibleAt=null;}
          if(p.kind==="DEFER")run.nextEligibleAt=new Date(clock+p.delayMs);
          if(p.kind==="COMPLETE"){run.completedAt=new Date(clock);run.nextEligibleAt=null;}
          return run;
        },
        async commitFailure(id,p) {
          calls.push("failure");patches.push(p);const run=draft.get(id);if(!owns(run,p.claim))return null;
          Object.assign(run,{leaseToken:null,leaseExpiresAt:null,attempt:p.attempt,reviewRequired:p.reviewRequired,
            outcomeUncertain:p.outcomeUncertain,nextEligibleAt:p.retryAfterMs!==null?new Date(clock+p.retryAfterMs):null});return run;
        },
      };
      const base={...tx};
      for(const [method,override]of Object.entries(overrides))tx[method]=(...args)=>override({draft,base,tx,clock},...args);
      try { const result=await work(tx);stored=draft;return result; } finally { release(); }
    },
    ...dbOverrides,
  };
  const repository=createSyncRunRepository({db,maxAttempts});
  return {repository,db,calls,patches,row:id=>structuredClone(stored.get(id??"run-1")),
    clock(ms){clock=epoch+ms;},
    // Test-only stand-in for a verified, fenced recovery receipt; no such
    // uncertainty setter is exposed by the production repository.
    recover(){const row=stored.get("run-1");Object.assign(row,{leaseToken:null,leaseExpiresAt:null,outcomeUncertain:false,recoveryAttempts:row.recoveryAttempts+1});},
    claim:(runId="run-1")=>repository.claimRun({runId,workerId:"worker-1",leaseSeconds:1}),
  };
}
const failure = {code:"REMOTE_UNAVAILABLE",retryable:true,outcomeUncertain:false,retryAfterMs:1000};

test("repository requires a transaction adapter and validates its claim budget", () => {
  assert.throws(()=>createSyncRunRepository(),/transaction/);
  assert.throws(()=>createSyncRunRepository({db:{transaction(){}}}),/getRunShop/);
  for(const maxAttempts of [0,13,1.5])assert.throws(()=>fixture({maxAttempts}));
});

test("invalid input fails before reading or writing durable state", async () => {
  const f=fixture();
  for(const input of [{runId:"bad id",workerId:"w",leaseSeconds:1},{runId:"run-1",workerId:"",leaseSeconds:1},
    {runId:"run-1",workerId:"w",leaseSeconds:0},{runId:"run-1",workerId:"w",leaseSeconds:3601}]) {
    await assert.rejects(()=>f.repository.claimRun(input));
  }
  assert.deepEqual(f.calls,[]);
});

test("authoritative claims bind the resolved tenant and increment fence and attempt once", async () => {
  const f=fixture();const c=await f.claim();
  assert.ok(Object.isFrozen(c));assert.equal(c.shopId,"repo.myshopify.com");assert.equal(c.fence,"1");assert.equal(c.attempt,1);
  assert.match(c.leaseToken,/^[a-f0-9]{32}$/);assert.deepEqual(f.calls.slice(0,4),["hint","shop","run","claim"]);
  assert.equal(f.patches[0].shopId,c.shopId);assert.equal(f.patches[0].expectedPreviousFence,"0");
  assert.equal(await f.claim(),null);
});

test("missing runs and mismatched tenant hints cannot acquire authority", async () => {
  const f=fixture();assert.equal(await f.claim("missing"),null);
  const mismatch=fixture({dbOverrides:{getRunShop:async()=>"other.myshopify.com"},overrides:{lockShop:async()=>true}});
  assert.equal(await mismatch.claim(),null);assert.equal(mismatch.calls.includes("claim"),false);
  await assert.rejects(()=>fixture({dbOverrides:{getRunShop:async()=>"invalid"}}).claim());
});

for(const changed of [{nextEligibleAt:new Date(epoch+1)},{leaseToken:"existing",leaseExpiresAt:new Date(epoch+1),attempt:1,fence:"1"}, {completedAt:new Date(epoch)},
  {reviewRequired:true},{outcomeUncertain:true},{cancelRequested:true},{attempt:12}]) {
  test(`ordinary claims reject ineligible durable state: ${JSON.stringify(changed)}`, async () => {
    const f=fixture({rows:[{...initial(),...changed}]});assert.equal(await f.claim(),null);assert.equal(f.calls.includes("claim"),false);
  });
}

test("concurrent duplicate and same-shop claims have only one live owner", async () => {
  const f=fixture({rows:[initial(),initial("run-2")]});
  const claims=await Promise.all([f.claim(),f.claim(),f.claim("run-2")]);assert.equal(claims.filter(Boolean).length,1);
  const other=fixture({rows:[initial(),initial("run-2","other.myshopify.com")]});
  assert.equal((await Promise.all([other.claim(),other.claim("run-2")])).filter(Boolean).length,2);
});

test("unknown coordination outcomes fail closed", async () => {
  for(const method of ["lockShop","hasOtherLiveRun"]) {
    const f=fixture({overrides:{[method]:async()=>undefined}});
    await assert.rejects(()=>f.claim(),error=>error.outcomeUncertain===true);
    assert.equal(f.row().attempt,0);
  }
});

test("malformed durable counters, fences and dates cannot authorize a claim", async () => {
  for(const changed of [{fence:"01"},{fence:"9223372036854775808"},{fence:9007199254740992},{attempt:-1},
    {reviewRequired:undefined},{outcomeUncertain:undefined},{nextEligibleAt:"bad"}]) {
    await assert.rejects(()=>fixture({rows:[{...initial(),...changed}]}).claim());
  }
  await assert.rejects(()=>fixture({rows:[{...initial(),fence:"9223372036854775807"}]}).claim(),{code:"FENCE_EXHAUSTED"});
});

test("an unverified claim write rolls back its attempt and fence", async () => {
  for(const change of [{shopId:"other.myshopify.com"},{fence:"9"},{attempt:2},{leaseToken:"wrong"}]) {
    const f=fixture({overrides:{claimRun:async({base},...args)=>({...await base.claimRun(...args),...change})}});
    await assert.rejects(()=>f.claim(),{code:"UNKNOWN_DB_OUTCOME"});assert.equal(f.row().attempt,0);assert.equal(f.row().fence,"0");
  }
});

test("renewal extends the current lease without incrementing counters, including in-place adapters", async () => {
  const f=fixture();const c=await f.claim();f.clock(100);
  assert.deepEqual(await f.repository.renewLease({claim:c,leaseSeconds:1}),{kind:"RENEWED"});
  assert.equal(f.row().leaseExpiresAt.getTime(),epoch+1100);assert.equal(f.row().attempt,1);assert.equal(f.row().fence,"1");
});

test("expired, superseded and mismatched claims cannot renew or acknowledge", async () => {
  const f=fixture();const old=await f.claim();f.clock(1000);assert.equal(await f.claim(),null);f.recover();const latest=await f.claim();
  assert.equal(latest.fence,"2");
  for(const c of [old,{...latest,generationId:"other"},{...latest,shopId:"other.myshopify.com"},{...latest,phase:"WAITING"}]) {
    assert.deepEqual(await f.repository.renewLease({claim:c,leaseSeconds:1}),{kind:"STALE_CLAIM"});
    assert.deepEqual(await f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{kind:"STALE_CLAIM"});
    assert.deepEqual(await f.repository.recordFailure({claim:c,failure}),{kind:"STALE_CLAIM"});
  }
  assert.equal(f.row().fence,"2");assert.equal(f.row().attempt,2);
});

test("non-extending and corrupted renewal results roll back", async () => {
  for(const changed of [{fence:"2"},{attempt:2},{outcomeUncertain:true}]) {
    const f=fixture({overrides:{renewRun:async({base},...args)=>({...await base.renewRun(...args),...changed})}});
    const c=await f.claim();f.clock(100);
    await assert.rejects(()=>f.repository.renewLease({claim:c,leaseSeconds:1}),{code:"UNKNOWN_DB_OUTCOME"});
    assert.equal(f.row().leaseExpiresAt.getTime(),epoch+1000);
  }
  const f=fixture();const c=await f.claim();await assert.rejects(()=>f.repository.renewLease({claim:c,leaseSeconds:1}),{code:"UNKNOWN_DB_OUTCOME"});
});

test("phase advancement requires strict durable evidence and then releases the lease", async () => {
  for(const evidence of [false,undefined,{complete:false}]) {
    const f=fixture({overrides:{verifyStepEvidence:async()=>evidence}});const c=await f.claim();
    await assert.rejects(()=>f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"EVIDENCE_MISSING"});
    assert.equal(f.row().phase,"STARTING");assert.equal(f.calls.includes("step"),false);
  }
  for(const [phase,next]of Object.entries({STARTING:"WAITING",WAITING:"INGESTING",INGESTING:"RECONCILING",RECONCILING:"PUBLISHING"})) {
    const f=fixture({rows:[{...initial(),phase}]});const c=await f.claim();
    assert.deepEqual(await f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{kind:"RECORDED"});
    assert.equal(f.row().phase,next);assert.equal(f.row().leaseToken,null);assert.equal(f.row().attempt,0);
    const writes=f.calls.filter(call=>call==="failure").length;
    assert.deepEqual(await f.repository.recordFailure({claim:c,failure}),{kind:"STALE_CLAIM"});
    assert.equal(f.row().phase,next);assert.equal(f.row().attempt,0);
    assert.equal(f.calls.filter(call=>call==="failure").length,writes);
  }
});

test("DEFER preserves phase and durably stores a bounded future eligibility time", async () => {
  const f=fixture();const c=await f.claim();
  await f.repository.recordStep({claim:c,result:{kind:"DEFER",delayMs:1500}});
  assert.equal(f.row().phase,"STARTING");assert.equal(f.row().nextEligibleAt.getTime(),epoch+1500);assert.equal(await f.claim(),null);
  assert.equal(f.row().leaseToken,null);assert.equal(f.row().leaseExpiresAt,null);
  f.clock(1500);assert.equal((await f.claim()).attempt,1);
});

test("a lease that expires during evidence verification cannot advance the phase", async () => {
  let f;
  f=fixture({overrides:{verifyStepEvidence:async()=>{f.clock(1000);return true;}}});
  const c=await f.claim();
  assert.deepEqual(await f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{kind:"STALE_CLAIM"});
  assert.equal(f.calls.includes("step"),false);assert.equal(f.row().phase,"STARTING");
});

test("publication is the only completing phase and requires a committed publication receipt", async () => {
  for(const evidence of [false,undefined,{published:false}]) {
    const f=fixture({rows:[{...initial(),phase:"PUBLISHING"}],overrides:{verifyPublished:async()=>evidence}});const c=await f.claim();
    await assert.rejects(()=>f.repository.recordStep({claim:c,result:{kind:"COMPLETE"}}),{code:"PUBLICATION_MISSING"});assert.equal(f.row().completedAt,null);
  }
  const f=fixture({rows:[{...initial(),phase:"PUBLISHING"}]});const c=await f.claim();
  assert.deepEqual(await f.repository.recordStep({claim:c,result:{kind:"COMPLETE"}}),{kind:"RECORDED"});assert.equal(await f.claim(),null);
});

test("non-publishing phase cannot complete or write a completion proposal", async () => {
  for(const phase of ["STARTING","WAITING","INGESTING","RECONCILING"]) {
    const f=fixture({rows:[{...initial(),phase}]});const c=await f.claim();const calls=f.calls.length;
    await assert.rejects(()=>f.repository.recordStep({claim:c,result:{kind:"COMPLETE"}}),{code:"INVALID_INPUT"});
    assert.equal(f.calls.length,calls);assert.equal(f.row().phase,phase);assert.equal(f.row().completedAt,null);
  }
});

test("corrupted step commits cannot acknowledge a different fence, attempt or outcome", async () => {
  for(const changed of [{fence:"2"},{attempt:2},{phase:"INGESTING"},{reviewRequired:true},{outcomeUncertain:true},{leaseToken:"retained"},{leaseExpiresAt:new Date(epoch+1000)}]) {
    const f=fixture({overrides:{commitStep:async({base},...args)=>({...await base.commitStep(...args),...changed})}});const c=await f.claim();
    await assert.rejects(()=>f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"UNKNOWN_DB_OUTCOME"});assert.equal(f.row().phase,"STARTING");
  }
});

test("retryable failures preserve the attempt count and exact uncertainty disposition", async () => {
  const f=fixture();const c=await f.claim();
  assert.deepEqual(await f.repository.recordFailure({claim:c,failure}),{kind:"RECORDED",retryable:true,reviewRequired:false,outcomeUncertain:false});
  assert.equal(f.row().attempt,1);assert.equal(f.row().leaseToken,null);assert.equal(f.row().nextEligibleAt.getTime(),epoch+1000);
});

test("uncertain outcomes block ordinary claims until an authoritative recovery clears them", async () => {
  const f=fixture();const c=await f.claim();
  const result=await f.repository.recordFailure({claim:c,failure:{...failure,outcomeUncertain:true}});
  assert.equal(result.outcomeUncertain,true);f.clock(10000);assert.equal(await f.claim(),null);
  assert.deepEqual(await f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}}),{kind:"STALE_CLAIM"});
});

test("exhausted and deterministic failures require review without double-counting attempts", async () => {
  for(const maxAttempts of [1,12]) {
    const f=fixture({maxAttempts,rows:[{...initial(),attempt:maxAttempts-1}]});const c=await f.claim();
    const result=await f.repository.recordFailure({claim:c,failure});assert.equal(result.retryable,false);assert.equal(result.reviewRequired,true);
    assert.equal(f.row().attempt,maxAttempts);f.clock(10000);assert.equal(await f.claim(),null);
  }
  const f=fixture();const c=await f.claim();await f.repository.recordFailure({claim:c,failure:{...failure,retryable:false,retryAfterMs:null}});assert.equal(f.row().reviewRequired,true);
});

test("failure commit verification rejects incremented attempts and retained live leases", async () => {
  for(const changed of [{attempt:2},{fence:"2"},{phase:"WAITING"},{completedAt:new Date(epoch)},{outcomeUncertain:true},{reviewRequired:true},
    {leaseExpiresAt:new Date(epoch+1000)}]) {
    const f=fixture({overrides:{commitFailure:async({base},...args)=>{const row=await base.commitFailure(...args);Object.assign(row,changed);return row;}}});const c=await f.claim();
    await assert.rejects(()=>f.repository.recordFailure({claim:c,failure}),{code:"UNKNOWN_DB_OUTCOME"});assert.equal(f.row().attempt,1);assert.equal(f.row().leaseToken,c.leaseToken);
  }
});

test("invalid proposals and accessor-backed data fail before a transaction", async () => {
  const f=fixture();const c=await f.claim();const before=f.calls.length;
  const malicious={get kind(){assert.fail("Getter invoked");}};
  for(const result of [malicious,{kind:"COMPLETE"},{kind:"DEFER",delayMs:999},{kind:"UNKNOWN"}])await assert.rejects(()=>f.repository.recordStep({claim:c,result}));
  for(const fail of [{...failure,code:"bad code"},{...failure,retryable:"true"},{...failure,outcomeUncertain:undefined}])await assert.rejects(()=>f.repository.recordFailure({claim:c,failure:fail}));
  assert.equal(f.calls.length,before);
});

test("worker reports repository-enforced review and recovery instead of falsely scheduling retries", async () => {
  for(const [error,maxAttempts,expected]of [[new Error("uncertain network"),12,"RECOVERY_REQUIRED"],
    [new SyncWorkerError("REMOTE_RETRY","known retry",{retryable:true}),1,"REVIEW_REQUIRED"]]) {
    const f=fixture({maxAttempts});
    const syncSteps=Object.fromEntries(["startBulk","checkBulk","ingestChunk","reconcile","publish"].map(method=>[method,async()=>{throw error;}]));
    const processor=createSyncProcessor({repository:f.repository,syncSteps,logger:{error(){},info(){}}});
    assert.equal((await processor.processRun("run-1")).kind,expected);
    f.clock(10000);assert.equal((await processor.processRun("run-1")).kind,"NOT_CLAIMED");
  }
});

// Successful polls and chunk checkpoints must not consume a lifetime claim cap.
test("healthy polling and chunk deferrals exceed twelve claims while stale claims stay fenced", async () => {
  for (const phase of ["WAITING", "INGESTING"]) {
    const f=fixture({rows:[{...initial(),phase}]}); let first;
    for(let i=0;i<40;i++) {
      f.clock(i*1000);const c=await f.claim();first??=c;
      assert.equal(c.attempt,1);assert.equal(c.fence,String(i+1));
      await f.repository.recordStep({claim:c,result:{kind:"DEFER",delayMs:1000}});
      assert.equal(f.row().attempt,0);
    }
    assert.deepEqual(await f.repository.recordStep({claim:first,result:{kind:"ADVANCE"}}),{kind:"STALE_CLAIM"});
    f.clock(40000);const c=await f.claim();
    await f.repository.recordStep({claim:c,result:{kind:"ADVANCE"}});
    assert.equal(f.row().reviewRequired,false);
  }
});

test("a successful step resets consecutive failures but repeated failures still require review", async () => {
  const f=fixture({maxAttempts:3});
  let c=await f.claim();await f.repository.recordFailure({claim:c,failure});
  f.clock(1000);c=await f.claim();assert.equal(c.attempt,2);
  await f.repository.recordStep({claim:c,result:{kind:"DEFER",delayMs:1000}});
  for(let i=0;i<3;i++) {
    f.clock(2000+i*1000);c=await f.claim();assert.equal(c.attempt,i+1);
    await f.repository.recordFailure({claim:c,failure});
  }
  assert.equal(f.row().reviewRequired,true);assert.equal(await f.claim(),null);
});

test("recovery eligibility is locked, scoped, immutable and independent of the ordinary attempt budget",async()=>{
  const f=fixture({maxAttempts:1,rows:[{...initial(),attempt:1,outcomeUncertain:true}]});
  const result=await f.repository.getRecoveryEligibility({runId:"run-1",shopId:"repo.myshopify.com"});
  assert.equal(result.kind,"ELIGIBLE");assert.equal(result.eligible,true);assert.equal(result.attempt,1);assert.equal(result.recoveryAttempts,0);
  assert.ok(Object.isFrozen(result));assert.equal(f.row().fence,"0");assert.equal(f.row().attempt,1);assert.equal(await f.claim(),null);
  assert.deepEqual(f.calls.slice(0,3),["hint","shop","run"]);
  assert.deepEqual(await f.repository.getRecoveryEligibility({runId:"run-1",shopId:"other.myshopify.com"}),{kind:"NOT_FOUND",eligible:false,runId:"run-1"});
  assert.deepEqual(await f.repository.getRecoveryEligibility({runId:"missing"}),{kind:"NOT_FOUND",eligible:false,runId:"missing"});
});

test("recovery eligibility rejects terminal, delayed, live, unneeded and exhausted recovery state",async()=>{
  for(const [changed,reason] of [
    [{completedAt:new Date(epoch)},"COMPLETED"], [{cancelRequested:true},"CANCELLED"],
    [{reviewRequired:true},"REVIEW_REQUIRED"], [{outcomeUncertain:false},"NOT_REQUIRED"],
    [{leaseToken:"worker",leaseExpiresAt:new Date(epoch+1000)},"LEASE_ACTIVE"],
    [{nextEligibleAt:new Date(epoch+1000)},"NOT_DUE"], [{recoveryAttempts:8},"RECOVERY_LIMIT"],
    [{recoveryAttempts:undefined},"RECOVERY_STATE_UNAVAILABLE"],
  ]) {
    const f=fixture({rows:[{...initial(),attempt:1,outcomeUncertain:true,...changed}]});
    const result=await f.repository.getRecoveryEligibility({runId:"run-1"});
    assert.equal(result.eligible,false);assert.equal(result.reason,reason);assert.equal(f.calls.includes("claim"),false);
  }
});

test("expired retained ownership is eligible for recovery but never an ordinary reclaim",async()=>{
  const f=fixture();const c=await f.claim();f.clock(1000);
  assert.equal(await f.claim(),null);
  assert.equal((await f.repository.getRecoveryEligibility({runId:"run-1"})).eligible,true);
  assert.equal(f.row().attempt,c.attempt);assert.equal(f.row().fence,c.fence);
  f.recover();assert.equal((await f.claim()).fence,"2");
});

test("recovery eligibility respects another live owner and fails closed on unknown coordination",async()=>{
  const f=fixture({rows:[{...initial(),outcomeUncertain:true},
    {...initial("run-2"),leaseToken:"other",leaseExpiresAt:new Date(epoch+1000),attempt:1,fence:"1"}]});
  assert.equal((await f.repository.getRecoveryEligibility({runId:"run-1"})).reason,"SHOP_BUSY");
  const unknown=fixture({rows:[{...initial(),outcomeUncertain:true}],overrides:{hasOtherLiveRun:async()=>undefined}});
  await assert.rejects(()=>unknown.repository.getRecoveryEligibility({runId:"run-1"}),error=>error.outcomeUncertain===true);
});

test("zero, fractional and over-budget claim attempts are rejected before database access",async()=>{
  const f=fixture({maxAttempts:2});const claim=await f.claim();const before=f.calls.length;
  for(const attempt of [0,-1,1.5,3,"1",NaN]) {
    const bad={...claim,attempt};
    await assert.rejects(()=>f.repository.renewLease({claim:bad,leaseSeconds:1}),{code:"INVALID_INPUT"});
    await assert.rejects(()=>f.repository.recordStep({claim:bad,result:{kind:"ADVANCE"}}),{code:"INVALID_INPUT"});
    await assert.rejects(()=>f.repository.recordFailure({claim:bad,failure}),{code:"INVALID_INPUT"});
  }
  assert.equal(f.calls.length,before);
});

test("malformed durable ownership and recovery counters cannot become eligibility grants",async()=>{
  for(const changed of [{fence:null},{fence:undefined},{fence:0},{cancelRequested:null},{leaseToken:"worker"},
    {leaseExpiresAt:new Date(epoch)},{leaseToken:"worker",leaseExpiresAt:new Date(epoch)},
    {recoveryAttempts:null},{recoveryAttempts:-1},{recoveryAttempts:9},{recoveryAttempts:"0"}]) {
    const f=fixture({rows:[{...initial(),...changed}]});
    await assert.rejects(()=>f.claim(),{code:"INVALID_INPUT"});
    await assert.rejects(()=>f.repository.getRecoveryEligibility({runId:"run-1"}),{code:"INVALID_INPUT"});
  }
});

test("uncertainty on the last ordinary attempt schedules recovery rather than retry or terminal review",async()=>{
  for(const retryable of [true,false]) {
    const f=fixture({maxAttempts:1});const claim=await f.claim();
    const result=await f.repository.recordFailure({claim,failure:{...failure,retryable,outcomeUncertain:true,retryAfterMs:retryable?1000:null}});
    assert.deepEqual(result,{kind:"RECORDED",retryable:false,reviewRequired:false,outcomeUncertain:true});
    assert.equal(f.row().attempt,1);assert.equal(f.row().reviewRequired,false);
    assert.equal((await f.repository.getRecoveryEligibility({runId:"run-1"})).reason,"NOT_DUE");
    f.clock(1000);assert.equal((await f.repository.getRecoveryEligibility({runId:"run-1"})).eligible,true);assert.equal(await f.claim(),null);
  }
});

test("strict commit verification rejects expired lease remnants, retained workers and terminal retry dates",async()=>{
  for(const changed of [{leaseExpiresAt:new Date(epoch-1)},{workerId:"retained"},{nextEligibleAt:new Date(epoch-1)},{cancelRequested:true}]) {
    const f=fixture({overrides:{commitStep:async({base},...args)=>({...await base.commitStep(...args),...changed})}});const claim=await f.claim();
    await assert.rejects(()=>f.repository.recordStep({claim,result:{kind:"ADVANCE"}}),{code:"UNKNOWN_DB_OUTCOME"});
    assert.equal(f.row().phase,"STARTING");
    const terminal=fixture({overrides:{commitFailure:async({base},...args)=>({...await base.commitFailure(...args),...changed})}});const c=await terminal.claim();
    await assert.rejects(()=>terminal.repository.recordFailure({claim:c,failure:{...failure,retryable:false,retryAfterMs:null}}),{code:"UNKNOWN_DB_OUTCOME"});
    assert.equal(terminal.row().reviewRequired,false);
  }
});
