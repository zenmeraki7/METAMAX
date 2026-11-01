// Interface contract (repository root): docs/backend-interface-contracts.md#history-inspection-and-item-completion
import {isDeepStrictEqual} from 'node:util';
import {historyFingerprint,HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {requireResourceWriteContract,resourceTypeForGid} from '../fields/write-capabilities.js';

const equal=(a,b)=>isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
const key=x=>JSON.stringify([x.resourceGid,x.fieldId]);
const hash=x=>typeof x==='string'&&/^sha256:[0-9a-f]{64}$/.test(x);
const incomplete=()=>{throw Object.assign(new Error('Complete field verification required'),{code:'HISTORY_VERIFICATION_INCOMPLETE'});};

/** Repository-internal comparison. No execution authority or brand is issued here. */
export function verifyPersistedItemEvidence({plan,claim,item,approved,result,request,changes}) {
 const writer=requireResourceWriteContract(resourceTypeForGid(item.resource_id));
 if(!Array.isArray(plan.fields)||!plan.fields.length||plan.fields.length>64||!request)incomplete();
 const fields=plan.fields,expected=fields.map(f=>key(f.identity));
 if(new Set(expected).size!==fields.length||request.field_count!==fields.length||changes.length!==fields.length||!Array.isArray(request.resource_field_set))incomplete();
 const values={};
 for(const f of fields){
  const i=f.identity,name=writer.names[i.fieldId];
  if(!name||f.intendedValueKind!=='VALUE'||!equal([i.shopId,i.installationId,i.executionJobId,i.executionItemId,i.mutationId,i.resourceGid],
   [claim.shop_id,claim.installation_version,String(claim.id),String(item.id),plan.mutationId,item.resource_id]))incomplete();
  values[name]=f.intendedValue;
 }
 const persisted=typeof item.intended_values==='string'?JSON.parse(item.intended_values):item.intended_values;
 if(!equal(values,approved)||!equal(values,plan.itemIntendedValues)||!equal(values,persisted))incomplete();
 if(!equal([request.shop_id,request.installation_id,request.execution_job_id,request.execution_item_id,request.operation_id,request.mutation_id,request.attempt_id],
  [claim.shop_id,claim.installation_version,String(claim.id),String(item.id),plan.operationId,plan.mutationId,plan.attemptId])||
  request.request_state!=='VERIFIED'||!request.verified_at||request.purge_requested_at||
  request.approved_contract_fingerprint!==plan.approvedContractFingerprint||request.execution_fingerprint!==plan.executionFingerprint||
  request.outcome_evidence_kind!=='VERIFIED_OBSERVATION'||!hash(request.outcome_evidence_fingerprint)||
  !equal(request.resource_field_set.map(key).sort(),expected.slice().sort()))incomplete();
 for(const name of ['operationId','mutationId','attemptId'])if(result?.[name]&&result[name]!==plan[name])incomplete();
 if(result?.afterValues&&!equal(result.afterValues,values))incomplete();
 if(new Set(changes.map(c=>key({resourceGid:c.resource_gid,fieldId:c.field_id}))).size!==fields.length)incomplete();
 for(const f of fields){
  const c=changes.find(c=>c.resource_gid===f.identity.resourceGid&&c.field_id===f.identity.fieldId);
  if(!c||!equal([c.shop_id,c.installation_id,c.execution_job_id,c.execution_item_id,c.operation_id,c.mutation_id,c.attempt_id],
   [claim.shop_id,claim.installation_version,String(claim.id),String(item.id),plan.operationId,plan.mutationId,plan.attemptId])||
   c.mutation_state!=='VERIFIED'||c.verification_state!=='MATCHED'||!c.verified_at||
   c.mutation_plan_fingerprint!==plan.mutationPlanFingerprint||c.field_definition_revision!==f.binding.fieldDefinitionRevision||
   c.intended_value_fingerprint!==historyFingerprint({valueKind:f.intendedValueKind,value:f.intendedValue},'intended-value-v3')||
   c.last_evidence_kind!=='VERIFIED_OBSERVATION'||c.last_evidence_fingerprint!==request.outcome_evidence_fingerprint||
   !c.after_present)incomplete();
 }
 return true;
}

/** Uses the caller's transaction; never opens or commits another connection. */
export function createItemHistoryAuthority({resolveTenant,loadExecutionPlan,authorizeRecovery,executionAdapter,invokeFor}) {
 return async function inspect({tx,authContext,operationId,mutationId,claim,item,approved,result,completion=false}){
  if(typeof tx?.query!=='function')throw TypeError('Explicit owned transaction required');
  const invoke=invokeFor(tx),tenant=await invoke(resolveTenant,{authContext});
  if(tenant?.shopId!==claim.shop_id||tenant?.installationId!==claim.installation_version)throw new HistoryContractError(C.OWNERSHIP_LOST,'Exact installation authority required');
  await executionAdapter.beginScope({client:tx,write:false});
  await executionAdapter.assertTenant({client:tx,tenant});
  const plan=await invoke(loadExecutionPlan,{authContext,...tenant,operationId,mutationId});
  if(!plan||plan.operationId!==operationId||plan.mutationId!==mutationId||plan.shopId!==tenant.shopId||plan.installationId!==tenant.installationId||plan.executionJobId!==String(claim.id))incomplete();
  const held=await executionAdapter.lockEvidenceItemAuthority({client:tx,tenant,plan,claim:{fenceEpoch:String(claim.fence),leaseToken:claim.lease_token}});
  if(await invoke(authorizeRecovery,{authContext,tenant,plan,contract:held.contract,operation:completion?'verify_item_completion':'inspect_item'})!==true)throw new HistoryContractError(C.UNAUTHORIZED,'Independent history evidence authorization required');
  const params=[tenant.shopId,tenant.installationId,operationId,mutationId,plan.attemptId,String(item.id),String(claim.id)];
  const requests=(await tx.query(`SELECT r.shop_id,r.installation_id,o.execution_job_id::text,r.execution_item_id::text,r.operation_id,r.mutation_id,r.attempt_id,
   r.request_state,r.field_count,r.resource_field_set,r.verified_at,r.outcome_evidence_kind,r.outcome_evidence_fingerprint,
   o.purge_requested_at,o.approved_contract_fingerprint,o.execution_fingerprint
   FROM edit_history.mutation_requests r JOIN edit_history.operations o
    ON o.shop_id=r.shop_id AND o.installation_id=r.installation_id AND o.id=r.operation_id
   WHERE r.shop_id=$1 AND r.installation_id=$2 AND r.operation_id=$3 AND r.mutation_id=$4 AND r.attempt_id=$5
    AND r.execution_item_id=$6 AND o.execution_job_id=$7`,params)).rows;
  const request=requests.length===1?requests[0]:null;
  const other=(await tx.query(`SELECT r.request_state FROM edit_history.mutation_requests r JOIN edit_history.operations o
   ON o.shop_id=r.shop_id AND o.installation_id=r.installation_id AND o.id=r.operation_id
   WHERE r.shop_id=$1 AND r.installation_id=$2 AND o.execution_job_id=$3 AND r.execution_item_id=$4
    AND NOT(r.operation_id=$5 AND r.mutation_id=$6 AND r.attempt_id=$7)
    AND r.request_state<>'FAILED_NO_WRITE' LIMIT 1`,[tenant.shopId,tenant.installationId,String(claim.id),String(item.id),operationId,mutationId,plan.attemptId])).rows;
  if(other.length){if(completion)incomplete();return Object.freeze({state:'UNCERTAIN'});}
  if(!request){if(completion)incomplete();await held.assertClaim();return Object.freeze({state:'NOT_DISPATCHED'});}
  if(request.request_state!=='VERIFIED'){
   if(completion)incomplete();
   return Object.freeze({state:['FAILED_NO_WRITE','CONFLICT'].includes(request.request_state)?'CONFLICT':request.request_state==='PREPARED'?'NOT_DISPATCHED':'UNCERTAIN'});
  }
  const storedItem=(await tx.query(`SELECT intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND id=$3 AND resource_id=$4 FOR SHARE`,
   [tenant.shopId,String(claim.id),String(item.id),item.resource_id])).rows[0];
  if(!storedItem)incomplete();
  const changes=(await tx.query(`SELECT c.shop_id,c.installation_id,o.execution_job_id::text,c.execution_item_id::text,c.operation_id,c.mutation_id,c.attempt_id,
   c.resource_gid,c.field_id,c.mutation_state,c.verification_state,c.verified_at,c.mutation_plan_fingerprint,c.intended_value_fingerprint,
   c.last_evidence_kind,c.last_evidence_fingerprint,c.field_definition_revision,
   EXISTS(SELECT 1 FROM edit_history.snapshots s WHERE s.shop_id=c.shop_id AND s.installation_id=c.installation_id
    AND s.operation_id=c.operation_id AND s.change_id=c.id AND s.resource_gid=c.resource_gid AND s.field_id=c.field_id
    AND s.snapshot_kind='OBSERVED_AFTER' AND s.value_kind='VALUE' AND s.field_definition_revision=c.field_definition_revision
    AND s.execution_fingerprint=o.execution_fingerprint AND s.filter_fingerprint=o.filter_fingerprint
    AND s.field_resolution_fingerprint=$8
    AND s.snapshot_fingerprint IS NOT NULL AND s.evidence_binding_fingerprint IS NOT NULL
    AND s.observation_receipt_id IS NOT NULL AND s.observation_receipt_fingerprint IS NOT NULL) AS after_present
   FROM edit_history.changes c JOIN edit_history.operations o
    ON o.shop_id=c.shop_id AND o.installation_id=c.installation_id AND o.id=c.operation_id
   WHERE c.shop_id=$1 AND c.installation_id=$2 AND c.operation_id=$3 AND c.mutation_id=$4 AND c.attempt_id=$5
    AND ($6::text IS NOT NULL) AND o.execution_job_id=$7 LIMIT 65`,[...params,plan.fieldResolutionFingerprint])).rows;
  verifyPersistedItemEvidence({plan,claim,item:{...item,intended_values:storedItem.intended_values},approved:completion?approved:plan.itemIntendedValues,result,request,changes});
  if(await invoke(authorizeRecovery,{authContext,tenant,plan,contract:held.contract,operation:completion?'verify_item_completion':'inspect_item'})!==true)throw new HistoryContractError(C.UNAUTHORIZED,'Completion authorization changed');
  const current=await invoke(resolveTenant,{authContext});
  if(!equal(current,tenant))throw new HistoryContractError(C.OWNERSHIP_LOST,'Completion installation changed');
  await held.assertClaim();
  return completion?true:Object.freeze({state:'VERIFIED',operationId,mutationId,attemptId:plan.attemptId});
 };
}
