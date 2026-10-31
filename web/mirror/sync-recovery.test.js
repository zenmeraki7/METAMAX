import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRecoveryService, createSyncRecoveryOrchestrator } from "./sync-recovery.server.js";

const claim={runId:"run-1",shopId:"recovery.myshopify.com",generationId:"generation-1",phase:"STARTING",fence:"2",leaseToken:"recovery-lease",
  intent:{id:"intent-1",runId:"run-1",shopId:"recovery.myshopify.com",generationId:"generation-1",kind:"BULK_START"}};
function fixture(options={}) {
  const calls={claim:0,verify:0,finish:[],failure:[]};
  const recoveryRepository={
    claimRecovery:async()=>{calls.claim++;return claim;},
    finishRecovery:async input=>{calls.finish.push(input);return {kind:input.verification.kind==="UNRESOLVED"?"REVIEW_REQUIRED":"RESUMED"};},
    recordRecoveryFailure:async input=>{calls.failure.push(input);return {kind:"RECORDED"};},
    ...options.repository,
  };
  const externalVerifier={verify:async input=>{calls.verify++;assert.ok(Object.isFrozen(input.intent));return {kind:"CONFIRMED",authoritative:true,evidence:{operationId:"gid://shopify/BulkOperation/1"}};},...options.verifier};
  return {calls,service:createSyncRecoveryService({recoveryRepository,externalVerifier,verificationTimeoutMs:100,...options.settings})};
}

test("recovery requires repository methods and a read-only verifier",()=>{
  assert.throws(()=>createSyncRecoveryService(),/claimRecovery/);
  assert.throws(()=>fixture({verifier:{verify:null}}),/Read-only/);
  assert.throws(()=>fixture({settings:{verificationTimeoutMs:0}}),/deadline/);
});

test("missing durable recovery work returns before any external request",async()=>{
  const f=fixture({repository:{claimRecovery:async()=>null}});
  assert.deepEqual(await f.service.recoverRun("run-1"),{kind:"NOT_CLAIMED"});assert.equal(f.calls.verify,0);
  await assert.rejects(()=>f.service.recoverRun({runId:"run-1"}));
});

for(const changed of [{runId:"other"},{shopId:"bad"},{generationId:undefined},{leaseToken:undefined},{fence:"0"},{fence:"9223372036854775808"},
  {phase:"bad"},{intent:{}},{intent:{id:"intent",runId:"other"}}]) {
  test(`recovery rejects malformed or cross-scoped claims: ${JSON.stringify(changed)}`,async()=>{
    const f=fixture({repository:{claimRecovery:async()=>({...claim,...changed})}});
    await assert.rejects(()=>f.service.recoverRun("run-1"));assert.equal(f.calls.verify,0);assert.equal(f.calls.finish.length,0);
  });
}

for(const kind of ["CONFIRMED","SAFE_TO_RETRY","UNRESOLVED"]) {
  test(`recovery submits ${kind} evidence to the fenced repository`,async()=>{
    const f=fixture({verifier:{verify:async()=>({kind,authoritative:true,evidence:{receipt:"checked"}})}});
    const result=await f.service.recoverRun("run-1");
    assert.equal(result.kind,kind==="UNRESOLVED"?"REVIEW_REQUIRED":"RESUMED");
    const input=f.calls.finish[0];assert.equal(input.claim.fence,"2");assert.equal(input.claim.intent.id,"intent-1");assert.ok(Object.isFrozen(input.verification.evidence));
  });
}

test("weak or invalid retry evidence records failure without clearing uncertainty",async()=>{
  for(const verification of [null,{kind:"SAFE_TO_RETRY"},{kind:"SAFE_TO_RETRY",authoritative:true,evidence:{}},
    {kind:"SAFE_TO_RETRY",authoritative:true,evidence:[]},{kind:"UNKNOWN"}]) {
    const f=fixture({verifier:{verify:async()=>verification}});
    assert.equal((await f.service.recoverRun("run-1")).kind,"RECOVERY_DEFERRED");
    assert.equal(f.calls.finish.length,0);assert.equal(f.calls.failure[0].reason,"VERIFICATION_INVALID");
  }
});

test("an uncooperative verifier times out without a late recovery write",{timeout:2000},async()=>{
  let resolve,signal;const pending=new Promise(done=>{resolve=done;});
  const f=fixture({settings:{verificationTimeoutMs:10},verifier:{verify:input=>{signal=input.signal;return pending;}}});
  assert.equal((await f.service.recoverRun("run-1")).kind,"RECOVERY_DEFERRED");assert.equal(signal.aborted,true);
  resolve({kind:"SAFE_TO_RETRY",authoritative:true,evidence:{receipt:"late"}});await Promise.resolve();
  assert.equal(f.calls.finish.length,0);assert.equal(f.calls.failure.length,1);
});

test("verifier errors persist a fenced recovery failure and respect supersession",async()=>{
  const f=fixture({verifier:{verify:async()=>{throw new Error("remote unavailable");}},repository:{recordRecoveryFailure:async()=>({kind:"STALE_CLAIM"})}});
  assert.equal((await f.service.recoverRun("run-1")).kind,"STALE_CLAIM");assert.equal(f.calls.finish.length,0);
});

test("unverified commit outcomes are uncertain and unresolved evidence cannot resume execution",async()=>{
  for(const result of [undefined,{kind:"UNKNOWN"},{kind:"RESUMED"}]) {
    const f=fixture({verifier:{verify:async()=>({kind:"UNRESOLVED"})},repository:{finishRecovery:async()=>result}});
    await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
  }
  const f=fixture({verifier:{verify:async()=>{throw new Error("remote");}},repository:{recordRecoveryFailure:async()=>undefined}});
  await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
});

test("accessor evidence is rejected without invoking application code",async()=>{
  const f=fixture({verifier:{verify:async()=>({get kind(){assert.fail("Evidence getter invoked");}})}});
  assert.equal((await f.service.recoverRun("run-1")).kind,"RECOVERY_DEFERRED");assert.equal(f.calls.finish.length,0);
});

test("the explicit orchestrator preserves the existing service factory API",()=>{
  assert.equal(createSyncRecoveryService,createSyncRecoveryOrchestrator);
  for(const repositoryTimeoutMs of [0,30001,1.5,NaN])assert.throws(()=>fixture({settings:{repositoryTimeoutMs}}),/deadline/);
});

test("a claim timeout is uncertain and a late claim cannot start verification",{timeout:2000},async()=>{
  const pending=Promise.withResolvers();
  const f=fixture({settings:{repositoryTimeoutMs:10},repository:{claimRecovery:()=>pending.promise}});
  await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
  pending.resolve(claim);await Promise.resolve();await Promise.resolve();
  assert.equal(f.calls.verify,0);assert.equal(f.calls.finish.length,0);assert.equal(f.calls.failure.length,0);
});

test("a finish timeout never retries or issues a compensating failure write",{timeout:2000},async()=>{
  let writes=0;const pending=Promise.withResolvers();
  const f=fixture({settings:{repositoryTimeoutMs:10},repository:{finishRecovery:()=>{writes++;return pending.promise;}}});
  await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
  pending.resolve({kind:"RESUMED"});await Promise.resolve();
  assert.equal(writes,1);assert.equal(f.calls.failure.length,0);
});

test("a failure-recording timeout is uncertain and cannot resume work",{timeout:2000},async()=>{
  let writes=0;
  const f=fixture({settings:{repositoryTimeoutMs:10},verifier:{verify:async()=>{throw new Error("Unavailable");}},
    repository:{recordRecoveryFailure:()=>{writes++;return new Promise(()=>{});}}});
  await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
  assert.equal(writes,1);assert.equal(f.calls.finish.length,0);
});

test("repository exceptions are surfaced as uncertain outcomes without automatic retries",async()=>{
  for(const method of ["claimRecovery","finishRecovery","recordRecoveryFailure"]) {
    let calls=0;const original=new Error("Persistence acknowledgment unavailable");
    const f=fixture({repository:{[method]:async()=>{calls++;throw original;}},
      ...(method==="recordRecoveryFailure"?{verifier:{verify:async()=>{throw null;}}}:{})});
    await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true&&error.cause===original);
    assert.equal(calls,1);
  }
});

test("cancellation before claiming does no database or external work",async()=>{
  const controller=new AbortController();controller.abort();const f=fixture();
  assert.deepEqual(await f.service.recoverRun("run-1",{signal:controller.signal}),{kind:"RECOVERY_CANCELLED"});
  assert.equal(f.calls.claim,0);assert.equal(f.calls.verify,0);
  await assert.rejects(()=>f.service.recoverRun("run-1",{signal:{aborted:false}}),{code:"INVALID_RECOVERY_CONTRACT"});
});

test("cancellation after a claim records failure before any verifier request",async()=>{
  const controller=new AbortController();
  const f=fixture({repository:{claimRecovery:async()=>{controller.abort();return claim;}}});
  assert.equal((await f.service.recoverRun("run-1",{signal:controller.signal})).kind,"RECOVERY_DEFERRED");
  assert.equal(f.calls.verify,0);assert.equal(f.calls.failure[0].reason,"VERIFICATION_ABORTED");
});

test("cancelling an uncooperative verifier leaves no late final write",async()=>{
  const started=Promise.withResolvers(),pending=Promise.withResolvers(),controller=new AbortController();let signal;
  const f=fixture({verifier:{verify:input=>{signal=input.signal;started.resolve();return pending.promise;}}});
  const recovering=f.service.recoverRun("run-1",{signal:controller.signal});await started.promise;controller.abort();
  assert.equal((await recovering).kind,"RECOVERY_DEFERRED");assert.equal(signal.aborted,true);
  pending.resolve({kind:"CONFIRMED",authoritative:true,evidence:{receipt:"late"}});await Promise.resolve();
  assert.equal(f.calls.failure[0].reason,"VERIFICATION_ABORTED");assert.equal(f.calls.finish.length,0);
});

test("cancellation cannot claim rollback once final persistence has started",async()=>{
  const started=Promise.withResolvers(),pending=Promise.withResolvers(),controller=new AbortController();
  const f=fixture({repository:{finishRecovery:()=>{started.resolve();return pending.promise;}}});
  const recovering=f.service.recoverRun("run-1",{signal:controller.signal});await started.promise;controller.abort();
  pending.resolve({kind:"RESUMED"});assert.equal((await recovering).kind,"RESUMED");assert.equal(f.calls.failure.length,0);
});

test("exhausted recovery failure receipts report terminal review rather than another deferral",async()=>{
  const f=fixture({verifier:{verify:async()=>{throw null;}},repository:{recordRecoveryFailure:async()=>({kind:"RECORDED",reviewRequired:true})}});
  assert.equal((await f.service.recoverRun("run-1")).kind,"REVIEW_REQUIRED");assert.equal(f.calls.finish.length,0);
});

test("cross-scoped verification and evidence never reach final persistence",async()=>{
  for(const extra of [{shopId:"other.myshopify.com"},{phase:"WAITING"},
    {evidence:{runId:"other"}},{evidence:{intentId:"other"}},{evidence:{fence:"3"}}]) {
    const f=fixture({verifier:{verify:async()=>({kind:"SAFE_TO_RETRY",authoritative:true,evidence:{receipt:"checked"},...extra})}});
    assert.equal((await f.service.recoverRun("run-1")).kind,"RECOVERY_DEFERRED");
    assert.equal(f.calls.failure[0].reason,"VERIFICATION_INVALID");assert.equal(f.calls.finish.length,0);
  }
});

test("scope-mismatched, contradictory and accessor acknowledgments remain uncertain",async()=>{
  for(const receipt of [{kind:"RESUMED",runId:"other"},{kind:"RESUMED",phase:"WAITING"},
    {kind:"RESUMED",outcomeUncertain:true},{kind:"RESUMED",reviewRequired:true},
    {kind:"REVIEW_REQUIRED",reviewRequired:false},{get kind(){assert.fail("Receipt getter invoked");}}]) {
    const f=fixture({repository:{finishRecovery:async()=>receipt}});
    await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
    assert.equal(f.calls.failure.length,0);
  }
  for(const receipt of [{kind:"RECORDED",outcomeUncertain:false},{kind:"RECORDED",reviewRequired:true,retryable:true},
    {kind:"RECORDED",shopId:"other.myshopify.com"},{get kind(){assert.fail("Failure receipt getter invoked");}}]) {
    const f=fixture({verifier:{verify:async()=>{throw new Error("Remote");}},repository:{recordRecoveryFailure:async()=>receipt}});
    await assert.rejects(()=>f.service.recoverRun("run-1"),error=>error.outcomeUncertain===true);
  }
});

test("cyclic, oversized and prototype-forged evidence is rejected within a bounded snapshot",async()=>{
  const cycle={};cycle.self=cycle;
  for(const evidence of [cycle,{text:"x".repeat(32769)},Object.create(Array.prototype),{items:new Array(2)},
    {items:Array.from({length:1001},()=>1)}]) {
    const f=fixture({verifier:{verify:async()=>({kind:"CONFIRMED",authoritative:true,evidence})}});
    assert.equal((await f.service.recoverRun("run-1")).kind,"RECOVERY_DEFERRED");assert.equal(f.calls.finish.length,0);
  }
});
