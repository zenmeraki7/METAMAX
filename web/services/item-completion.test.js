import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPersistedItemEvidence,createItemHistoryAuthority} from '../edit-history/item-completion.server.js';
import {historyFingerprint} from '../edit-history/history-contract.js';
import {createHistoryHookInvoker} from '../edit-history/transaction-hooks.server.js';

function fixture(){
 const H=`sha256:${'a'.repeat(64)}`;
 const claim={shop_id:'completion.myshopify.com',installation_version:'installation',id:'1',fence:'2',lease_token:'lease'};
 const item={id:'3',resource_id:'gid://shopify/Product/4',intended_values:{title:'Title',vendor:'Vendor'}};
 const plan={shopId:claim.shop_id,installationId:claim.installation_version,executionJobId:'1',operationId:'operation',mutationId:'mutation',attemptId:'attempt',approvedContractFingerprint:H,executionFingerprint:H,mutationPlanFingerprint:H,itemIntendedValues:item.intended_values,
  fields:Object.entries(item.intended_values).map(([name,value])=>({identity:{shopId:claim.shop_id,installationId:claim.installation_version,executionJobId:'1',executionItemId:'3',mutationId:'mutation',resourceGid:item.resource_id,fieldId:`product.${name}`},binding:{fieldDefinitionRevision:'registry'},intendedValueKind:'VALUE',intendedValue:value}))};
 const request={shop_id:claim.shop_id,installation_id:claim.installation_version,execution_job_id:'1',execution_item_id:'3',operation_id:'operation',mutation_id:'mutation',attempt_id:'attempt',request_state:'VERIFIED',verified_at:new Date(),field_count:2,resource_field_set:plan.fields.map(f=>({resourceGid:f.identity.resourceGid,fieldId:f.identity.fieldId})),outcome_evidence_kind:'VERIFIED_OBSERVATION',outcome_evidence_fingerprint:H,approved_contract_fingerprint:H,execution_fingerprint:H};
 const changes=plan.fields.map(f=>({...request,resource_gid:f.identity.resourceGid,field_id:f.identity.fieldId,field_definition_revision:'registry',mutation_state:'VERIFIED',verification_state:'MATCHED',mutation_plan_fingerprint:H,intended_value_fingerprint:historyFingerprint({valueKind:'VALUE',value:f.intendedValue},'intended-value-v3'),last_evidence_kind:'VERIFIED_OBSERVATION',last_evidence_fingerprint:H,after_present:true}));
 return {claim,item,plan,request,changes,approved:item.intended_values};
}
test('two approved fields require two exact terminal evidence members',()=>{
 const f=fixture();assert.equal(verifyPersistedItemEvidence(f),true);
 for(const changes of [f.changes.slice(0,1),[...f.changes,f.changes[0]],[f.changes[0],f.changes[0]]])
  assert.throws(()=>verifyPersistedItemEvidence({...f,changes}),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
});
for(const name of ['shop_id','installation_id','execution_job_id','execution_item_id','operation_id','mutation_id','attempt_id','resource_gid','field_id'])
 test(`completion rejects evidence from another ${name}`,()=>{
  const f=fixture();f.changes[1][name]='other';assert.throws(()=>verifyPersistedItemEvidence(f),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
 });
for(const [name,value] of [['mutation_state','ACKNOWLEDGED'],['verification_state','PENDING'],['verified_at',null],['after_present',false],['intended_value_fingerprint','different'],['last_evidence_fingerprint','different']])
 test(`completion rejects incomplete ${name}`,()=>{
  const f=fixture();f.changes[1][name]=value;assert.throws(()=>verifyPersistedItemEvidence(f),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
 });
test('completion rejects approval subsets, added fields, changed values and request membership drift',()=>{
 for(const approved of [{title:'Title'},{title:'Title',vendor:'Vendor',status:'ACTIVE'},{title:'Changed',vendor:'Vendor'}])
  assert.throws(()=>verifyPersistedItemEvidence({...fixture(),approved}),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
 const f=fixture();f.request.resource_field_set.pop();assert.throws(()=>verifyPersistedItemEvidence(f),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
});
test('repository completion reads authority and evidence on the supplied transaction without committing it',async()=>{
 const f=fixture(),calls=[];
 const tx={async query(sql){calls.push(sql);
  if(sql.includes('SELECT r.shop_id'))return{rows:[f.request]};
  if(sql.includes('SELECT r.request_state'))return{rows:[]};
  if(sql.includes('SELECT intended_values'))return{rows:[{intended_values:f.item.intended_values}]};
  if(sql.includes('SELECT c.shop_id'))return{rows:f.changes};
  return{rows:[]};
 }};
 const check=createItemHistoryAuthority({invokeFor:createHistoryHookInvoker,
  resolveTenant:async({client})=>{await client.query('SELECT tenant');return{shopId:f.claim.shop_id,installationId:f.claim.installation_version};},
  loadExecutionPlan:async({client})=>{await client.query('SELECT plan');return f.plan;},authorizeRecovery:async()=>true,
  executionAdapter:{async beginScope({client}){assert.equal(client,tx);},async assertTenant({client}){assert.equal(client,tx);},async lockEvidenceItemAuthority({client}){assert.equal(client,tx);return{contract:{},async assertClaim(){await client.query('SELECT ownership');}};}}});
 assert.equal(await check({...f,tx,authContext:{},operationId:'operation',mutationId:'mutation',completion:true}),true);
 assert.ok(calls.includes('SELECT plan'));assert.equal(calls.at(-1),'SELECT ownership');
 assert.equal(calls.some(sql=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)),false);
});
