import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
mock.module('../edit-history/history-repository.server.js',{namedExports:{assertHistoryRepository(){},assertHistoryExecutionReady(){}}});
const {createHistoryExecution}=await import('../edit-history/history-execution.server.js');

function fixture(mode){
 const before={title:'Before',vendor:'Old'},intended={title:'After',vendor:'New'};
 const claim={id:'10',shop_id:'unknown.myshopify.com',installation_version:'installed',kind:'bulk_edit',fence:'2',lease_token:'lease'};
 const item={id:'11',resource_id:'gid://shopify/Product/1'},evidence=new Map();
 const request={authContext:{},operationId:'operation',mutationId:'mutation',claim:{fenceEpoch:'2',leaseToken:'lease'},entries:Object.keys(before).map(name=>({
  resourceFamilyGid:item.resource_id,intent:{identity:{shopId:claim.shop_id,installationId:'installed',executionJobId:'10',executionItemId:'11',resourceGid:item.resource_id,fieldId:`product.${name}`},intendedValueKind:'VALUE',intendedValue:intended[name]},
  attempt:{attemptId:'attempt'},beforeSnapshot:{valueKind:'VALUE',value:before[name]}
 }))};
 const journal={state:'PREPARED',consumed:false,scheduled:false,writes:0,reads:0,verifications:0,persistenceOffline:mode==='recovery-persistence'};
 let remote={id:item.resource_id,...before};
 const client={async readProduct(){journal.reads++;return {...remote};},async applyMutation({values}){
  journal.writes++;remote={id:item.resource_id,...values};
  if(mode==='response')throw Error('Shopify accepted; reply lost');return {...remote};
 }};
 const persistEvidence=async input=>{
  if(mode==='evidence'&&input.kind==='SHOPIFY_ACKNOWLEDGEMENT')throw Error('Evidence storage unavailable');
  const id=`evidence-${evidence.size+1}`;evidence.set(id,input);return id;
 };
 const repository={
  async prepareRequest(){return {state:journal.state};},
  async beginDispatch(_request,{dispatchGuard}){await dispatchGuard({});journal.state='DISPATCH_AUTHORIZED';return {dispatchToken:'one-use',dispatchHandoffKey:'handoff'};},
  async consumeDispatch(){assert.equal(journal.consumed,false);journal.consumed=true;},
  async recordMutationOutcome({evidenceId}){
   const receipt=evidence.get(evidenceId);assert.ok(receipt);
   if(journal.persistenceOffline||mode==='outcome'&&receipt.kind==='SHOPIFY_ACKNOWLEDGEMENT')throw Error('Outcome commit unavailable');
   journal.state=receipt.kind==='AMBIGUOUS'?'OUTCOME_UNKNOWN':'ACKNOWLEDGED';
  },
  async scheduleOutcomeRecovery(){if(journal.persistenceOffline)throw Error('Recovery scheduling unavailable');journal.scheduled=true;},
  async recordVerification({evidenceId}){
   const receipt=evidence.get(evidenceId);assert.equal(journal.consumed,true);assert.equal(receipt.kind,'VERIFIED_OBSERVATION');
   assert.deepEqual(receipt.observation,{id:item.resource_id,...intended});journal.verifications++;journal.state='VERIFIED';
  },
 };
 const execution=createHistoryExecution({historyRepository:repository,loadExecutionRequest:async()=>request,persistEvidence});
 const run=()=>execution.execute({claim,item,workerId:'worker',shopifyClient:client,approved:intended,dispatchGuard:async()=>{}});
 // Models the independently authorized read/evidence side of recovery; no write
 // method is supplied. Real repository transitions are exercised in PostgreSQL.
 const recover=async()=>{
  const observation=await client.readProduct();
  if(!Object.keys(intended).every(name=>observation[name]===intended[name]))return {state:'OUTCOME_UNKNOWN'};
  await repository.recordVerification({evidenceId:await persistEvidence({kind:'VERIFIED_OBSERVATION',observation})});
  return {state:'VERIFIED'};
 };
 return {run,recover,journal,changeRemote(values){remote={...remote,...values};}};
}
for(const mode of ['response','evidence','outcome','recovery-persistence'])test(`accepted mutation with ${mode} loss reconciles the observed remote state without another write`,async()=>{
 const f=fixture(mode);
 if(mode==='recovery-persistence')await assert.rejects(f.run,{code:'HISTORY_RECOVERY_PERSISTENCE_FAILED'});
 else assert.equal((await f.run()).state,'OUTCOME_UNKNOWN');
 assert.equal(f.journal.writes,1);assert.equal(f.journal.consumed,true);
 // Even with both uncertainty stores unavailable, consumed admission is not a
 // new permission to send. Restoring persistence permits read-only recovery.
 f.journal.persistenceOffline=false;
 assert.equal((await f.run()).state,'OUTCOME_UNKNOWN');assert.equal(f.journal.writes,1);
 assert.equal((await f.recover()).state,'VERIFIED');assert.equal(f.journal.verifications,1);
 const reads=f.journal.reads;assert.equal((await f.run()).state,'VERIFIED');assert.equal(f.journal.reads,reads);
 assert.equal(f.journal.writes,1);
});
test('a different remote value after an uncertain send never authorizes an automatic replacement write',async()=>{
 const f=fixture('response');await f.run();f.changeRemote({title:'External merchant edit'});
 assert.equal((await f.recover()).state,'OUTCOME_UNKNOWN');assert.equal(f.journal.verifications,0);
 assert.equal((await f.run()).state,'OUTCOME_UNKNOWN');assert.equal(f.journal.writes,1);
});
