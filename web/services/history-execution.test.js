import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
mock.module('../edit-history/history-repository.server.js',{namedExports:{assertHistoryRepository(){},assertHistoryExecutionReady(){}}});
const {createHistoryExecution}=await import('../edit-history/history-execution.server.js');
function fixture({variant=false,conflictRead=0,staleAt,failMethods=[],writeFails=false,guardFails=false,ackCommitLost=false,undo=false,preparedState='PREPARED'}={}){
 const calls=[],kind=variant?'variant':'product',name=variant?'price':'title',before=variant?'10':'Before',after=variant?'20':'After';
 const resourceId=`gid://shopify/${variant?'ProductVariant/2':'Product/1'}`,family='gid://shopify/Product/1';
 const claim={id:'10',shop_id:'execution.myshopify.com',installation_version:'install',fence:'2',lease_token:'lease',kind:undo?'undo':'bulk_edit'};
 const item={id:'11',resource_id:resourceId};
 const request={authContext:{},operationId:'operation',mutationId:'mutation',claim:{fenceEpoch:'2',leaseToken:'lease'},entries:[{
  resourceFamilyGid:family,intent:{identity:{shopId:claim.shop_id,installationId:'install',executionJobId:'10',executionItemId:'11',resourceGid:resourceId,fieldId:`${kind}.${name}`},intendedValueKind:'VALUE',intendedValue:after},
  attempt:{attemptId:'attempt'},beforeSnapshot:{valueKind:'VALUE',value:before}}]};
 const stale=Object.assign(Error('Lost ownership'),{code:'STALE_CLAIM'});
 const repository={};
 for(const method of ['prepareRequest','recordVerifiedNoWrite','beginDispatch','consumeDispatch','recordMutationOutcome','recordVerification','scheduleOutcomeRecovery'])repository[method]=async (input,options)=>{
  calls.push({method,input,options});if(ackCommitLost&&method==='recordMutationOutcome'&&input.evidenceId==='evidence-SHOPIFY_ACKNOWLEDGEMENT')throw Object.assign(Error('Acknowledgment commit response lost'),{code:'ECONNRESET'});if(method==='beginDispatch')await options.dispatchGuard({query:async()=>({rows:[]})});if(staleAt===method)throw stale;if(failMethods.includes(method))throw Error('storage failed');
  if(method==='prepareRequest')return {state:preparedState};
  if(method==='beginDispatch')return {dispatchToken:'private-token',dispatchHandoffKey:'exact-handoff'};
 };
 let reads=0,sent=false;
 const shape=value=>({id:resourceId,...(variant?{productId:family}:{}),[name]:value});
 const client={
  async [variant?'readVariant':'readProduct'](){calls.push({method:'read'});reads++;return shape(reads===conflictRead?'Changed':sent?after:before);},
  async [variant?'applyVariantMutation':'applyMutation'](input){calls.push({method:'write',input});sent=true;if(writeFails)throw Error('uncertain send');return shape(after);}
 };
 const execution=createHistoryExecution({historyRepository:repository,loadExecutionRequest:async()=>request,persistEvidence:async input=>{
  calls.push({method:'evidence',input});return `evidence-${input.kind}`;
 }});
 return {execution,calls,run:()=>execution.execute({claim,item,workerId:'worker',shopifyClient:client,approved:{[name]:after},dispatchGuard:async()=>{calls.push({method:'guard'});if(guardFails)throw Object.assign(Error('Guard revoked'),{code:'HISTORY_OWNERSHIP_LOST'});},captureBefore:async()=>calls.push({method:'capture'})})};
}
for(const variant of [false,true])test(`${variant?'variant':'product'} history uses the matching writer and verifies its result`,async()=>{
 const f=fixture({variant});assert.equal((await f.run()).state,'VERIFIED');
 assert.equal(f.calls.filter(x=>x.method==='write').length,1);
 const write=f.calls.find(x=>x.method==='write').input;assert.equal(write.productId,'gid://shopify/Product/1');
 assert.deepEqual(write.values,variant?{price:'20'}:{title:'After'});
 assert.deepEqual(f.calls.filter(x=>['consumeDispatch','write','recordMutationOutcome','recordVerification'].includes(x.method)).map(x=>x.method),['consumeDispatch','write','recordMutationOutcome','recordVerification']);
});
for(const conflictRead of [1,2])test(`preflight conflict at read ${conflictRead} proves no write without consuming the handoff`,async()=>{
 const f=fixture({conflictRead});assert.equal((await f.run()).state,'CONFLICT');
 assert.equal(f.calls.some(x=>['write','consumeDispatch','recordMutationOutcome','scheduleOutcomeRecovery'].includes(x.method)),false);
 const proof=f.calls.find(x=>x.method==='recordVerifiedNoWrite').input;
 assert.equal(proof.evidenceId,'evidence-AUTHORITATIVE_NO_WRITE');
 assert.equal(proof.dispatchToken,conflictRead===2?'private-token':undefined);
 assert.equal(proof.dispatchHandoffKey,conflictRead===2?'exact-handoff':undefined);
 assert.equal(f.calls.find(x=>x.method==='evidence').input.contacted,false);
});
for(const staleAt of ['consumeDispatch','recordMutationOutcome','recordVerification'])test(`stale ${staleAt} stops all subsequent journal and recovery work`,async()=>{
 const f=fixture({staleAt});await assert.rejects(f.run,{code:'STALE_CLAIM'});
 assert.equal(f.calls.at(-1).method,staleAt);
 assert.equal(f.calls.some(x=>x.method==='scheduleOutcomeRecovery'),false);
});
for(const failMethods of [['recordMutationOutcome'],['scheduleOutcomeRecovery'],['recordMutationOutcome','scheduleOutcomeRecovery']])test(`uncertainty persistence failure in ${failMethods.join('/')} is explicit`,async()=>{
 const f=fixture({writeFails:true,failMethods});
 await assert.rejects(f.run,error=>error.code==='HISTORY_RECOVERY_PERSISTENCE_FAILED'&&error.ambiguousRecorded===!failMethods.includes('recordMutationOutcome')&&error.recoveryScheduled===!failMethods.includes('scheduleOutcomeRecovery'));
 assert.equal(f.calls.filter(x=>x.method==='write').length,1);assert.equal(f.calls.at(-1).method,'scheduleOutcomeRecovery');
});
test('independent discovery requires a separate recovery authenticator',async()=>{
 const f=fixture();await assert.rejects(()=>f.execution.discoverRecovery({shopId:'execution.myshopify.com',installationId:'install',workerId:'scanner'}),{code:'HISTORY_RECOVERY_AUTH_REQUIRED'});
});

test('command-wide finalization uses independent authentication and never a last-item mutation request',async()=>{
 const authContext={},calls=[];
 const execution=createHistoryExecution({historyRepository:{async finalizeExecutionJob(input){calls.push(input);return{completed:true,updatedOperations:2};}},
  loadExecutionRequest:async()=>assert.fail('Command finalization must not select one item request'),persistEvidence:async()=>assert.fail('No Shopify evidence is fabricated'),
  resolveRecoveryAuth:async input=>{assert.equal(input.operation,'finalize_execution_job');return authContext;}});
 const result=await execution.finalize({claim:{shop_id:'finalize.myshopify.com',installation_version:'installation',id:'12'},workerId:'finalizer'});
 assert.equal(result.updatedOperations,2);assert.deepEqual(calls,[{authContext,executionJobId:'12',expectedTenant:{shopId:'finalize.myshopify.com',installationId:'installation'}}]);
});

test('lost acknowledgment COMMIT response schedules recovery without another mutation send',async()=>{
 const f=fixture({ackCommitLost:true});assert.equal((await f.run()).state,'OUTCOME_UNKNOWN');
 assert.equal(f.calls.filter(call=>call.method==='write').length,1);
 assert.equal(f.calls.at(-1).method,'scheduleOutcomeRecovery');
 assert.equal(f.calls.some(call=>call.method==='recordVerification'),false);
 assert.ok(f.calls.some(call=>call.method==='recordMutationOutcome'&&call.input.evidenceId==='evidence-AMBIGUOUS'));
});

test('dispatch guard is an out-of-band capability and revocation prevents consume and send',async()=>{
 const f=fixture({guardFails:true});await assert.rejects(f.run,{code:'HISTORY_OWNERSHIP_LOST'});
 const dispatch=f.calls.find(c=>c.method==='beginDispatch');
 assert.equal(Object.hasOwn(dispatch.input,'dispatchGuard'),false);
 assert.equal(typeof dispatch.options.dispatchGuard,'function');
 assert.equal(f.calls.some(c=>['consumeDispatch','write'].includes(c.method)),false);
});
test('independent discovery binds recovered auth to the exact discovered tenant without a stale claim',async()=>{
 const authContext={},calls=[];
 const execution=createHistoryExecution({historyRepository:{async discoverOutcomeRecovery(input){calls.push(input);return{scheduledRequests:1};}},loadExecutionRequest:async()=>assert.fail('No old worker request needed'),persistEvidence:async()=>assert.fail('No worker evidence needed'),
  resolveRecoveryAuth:async input=>{assert.equal(input.shopId,'recovery.myshopify.com');assert.equal(input.installationId,'install');assert.equal(input.claim,undefined);return authContext;}});
 assert.equal((await execution.discoverRecovery({shopId:'recovery.myshopify.com',installationId:'install',executionJobId:'42',workerId:'scanner'})).scheduledRequests,1);
 assert.deepEqual(calls[0],{authContext,limit:25,executionJobId:'42',expectedTenant:{shopId:'recovery.myshopify.com',installationId:'install'}});
});

for(const variant of [false,true])test(`${variant?'variant':'product'} Undo records no-write without reading, consuming or sending an unconditional mutation`,async()=>{
 const f=fixture({variant,undo:true}),result=await f.run();assert.equal(result.state,'CONFLICT');assert.equal(result.reason,'UNDO_ATOMICITY_UNAVAILABLE');
 assert.equal(f.calls.some(call=>['read','write','beginDispatch','consumeDispatch'].includes(call.method)),false);
 assert.ok(f.calls.some(call=>call.method==='recordVerifiedNoWrite'));
 assert.equal(f.calls.find(call=>call.method==='evidence').input.reason,'UNDO_ATOMICITY_UNAVAILABLE');
});

test('already verified Undo evidence can complete without an installed conditional mutation adapter',async()=>{
 const f=fixture({undo:true,preparedState:'VERIFIED'});assert.equal((await f.run()).state,'VERIFIED');
 assert.equal(f.calls.some(call=>['read','write','recordVerifiedNoWrite'].includes(call.method)),false);
});
