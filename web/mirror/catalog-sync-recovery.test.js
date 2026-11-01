import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_INPUT_HASH} from './catalog-sync-steps.server.js';
let finishGate=null,omitSignal=false;const validations=[],receipts=[];let beforeConsume=null;
const actual=await import('./sync-recovery.server.js');
mock.module('./sync-recovery.server.js',{namedExports:{...actual,createSyncRecoveryOrchestrator(options){
 const verifier=options.externalVerifier;
 return actual.createSyncRecoveryOrchestrator({...options,externalVerifier:{verify:input=>verifier.verify(omitSignal?{...input,signal:undefined}:input)}});
}}});
mock.module('./sync-recovery-repository.server.js',{namedExports:{createSyncRecoveryRepository({verifyRecoveryEvidence}){return {
 async claimRecovery({runId}){const intent={id:runId,operationId:`gid://shopify/BulkOperation/${runId.slice(4)}`,inputHash:CATALOG_INPUT_HASH,installationVersion:'install',recoveryFence:'1'};
 return {runId,shopId:'proof.myshopify.com',generationId:'generation',phase:'WAITING',fence:'1',leaseToken:'lease',intent};},
 async finishRecovery({claim,verification}){if(finishGate)await finishGate;beforeConsume?.();receipts.push({check:verifyRecoveryEvidence,args:{claim,verification,intent:claim.intent}});
 const valid=verifyRecoveryEvidence({claim,verification,intent:claim.intent});validations.push(valid);
 assert.equal(verifyRecoveryEvidence({claim:{...claim,runId:'other'},verification,intent:claim.intent}),false);
 return {kind:valid?'RESUMED':'REVIEW_REQUIRED'};},async recordRecoveryFailure(){return {kind:'RECORDED'};}
};}}});
const {createCatalogSyncRecovery}=await import('./catalog-sync-recovery.server.js');
const create=()=>createCatalogSyncRecovery({database:{},syncRunRepository:{},dispatchRepository:{},
 clientFactory:()=>({async request(_query,{variables}){return {data:{bulkOperation:{id:variables.id,status:'RUNNING'}}};}})});

test('more than 32 simultaneous recoveries retain their own exact evidence through consumption',async()=>{
 let release;finishGate=new Promise(resolve=>{release=resolve;});
 const service=create();const attempts=Array.from({length:64},(_,i)=>service.recoverRun(`run-${i+1}`));
 await new Promise(resolve=>setImmediate(resolve));release();
 const outcomes=await Promise.all(attempts);assert.ok(outcomes.every(result=>result.kind==='RESUMED'));
 assert.equal(validations.filter(Boolean).length,64);assert.ok(receipts.every(r=>r.check(r.args)===false));finishGate=null;
});

test('recovery without a caller or adapter signal has no TypeError and other instances reverify independently',async()=>{
 omitSignal=true;
 try{assert.equal((await create().recoverRun('run-100')).kind,'RESUMED');assert.equal((await create().recoverRun('run-101')).kind,'RESUMED');}
 finally{omitSignal=false;}
});

test('expired invocation evidence cannot authorize recovery and a later call verifies fresh evidence',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);beforeConsume=()=>{now+=45001;};
 const service=create();
 try{assert.equal((await service.recoverRun('run-102')).kind,'REVIEW_REQUIRED');}
 finally{beforeConsume=null;}
 assert.equal((await service.recoverRun('run-103')).kind,'RESUMED');
});
