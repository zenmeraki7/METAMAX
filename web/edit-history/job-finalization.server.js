// Interface contract (repository root): docs/backend-interface-contracts.md#mutation-and-command-finalization
import {createHistoryHookInvoker} from './transaction-hooks.server.js';
import {HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {getEvidenceContractInTransaction} from '../services/approval.server.js';
import {RESOURCE_WRITE_CONTRACTS} from '../fields/write-capabilities.js';
const fail=(code,message)=>{throw new HistoryContractError(code,message);};

/** Command-wide local reconciliation; never authorizes or sends a mutation. */
export function createHistoryJobFinalizer({database,resolveTenant,authorizeRecovery,executionAdapter}){
 return async function finalize({authContext,executionJobId,expectedTenant}){
  if(!authContext||typeof executionJobId!=='string'||!/^[1-9][0-9]{0,18}$/.test(executionJobId))fail(C.INVALID_INPUT,'Authenticated execution job reference required');
  const tx=await database.connect(),invoke=createHistoryHookInvoker(tx);
  try{
   await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");
   await executionAdapter.beginScope({client:tx,write:true});
   const tenant=await invoke(resolveTenant,{authContext});
   if(tenant?.shopId!==expectedTenant?.shopId||tenant?.installationId!==expectedTenant?.installationId)fail(C.UNAUTHORIZED,'Finalization installation differs');
   await executionAdapter.assertTenant({client:tx,tenant});
   const command=(await tx.query(`SELECT status,contract_id FROM mirror.job_commands WHERE shop_id=$1 AND installation_version=$2 AND id=$3 FOR UPDATE`,[tenant.shopId,tenant.installationId,executionJobId])).rows[0];
   const authorize=()=>invoke(authorizeRecovery,{authContext,tenant,operation:'finalize_execution_job',executionJobId});
   if(await authorize()!==true)fail(C.UNAUTHORIZED,'Independent command finalization permission required');
   if(!command||!['SUCCEEDED','PARTIAL','FAILED','CANCELLED'].includes(command.status)){await tx.query('COMMIT');return Object.freeze({completed:false});}
   const approved=await getEvidenceContractInTransaction({client:tx,shopId:tenant.shopId,contractId:command.contract_id});
   if(!approved||approved.executionAuthority.installationId!==tenant.installationId)fail(C.UNAUTHORIZED,'Finalization approval installation differs');
   const params=[tenant.shopId,tenant.installationId,executionJobId];
   const counts=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE c.mutation_state='VERIFIED')::int AS verified,
    count(*) FILTER(WHERE c.mutation_state NOT IN('VERIFIED','FAILED_NO_WRITE','CONFLICT'))::int AS unresolved
    FROM edit_history.changes c JOIN edit_history.operations o ON o.shop_id=c.shop_id AND o.installation_id=c.installation_id AND o.id=c.operation_id
    WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.execution_job_id=$3`,params)).rows[0];
   const incomplete=(await tx.query(`SELECT i.id FROM mirror.job_items i WHERE i.shop_id=$1 AND i.command_id=$3 AND
     (($4::text='SUCCEEDED' AND i.status<>'SUCCEEDED') OR (i.status='SUCCEEDED' AND NOT EXISTS(
       SELECT 1 FROM edit_history.operations o JOIN edit_history.mutation_requests r ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id
       WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.execution_job_id=$3 AND r.execution_item_id=i.id AND r.request_state='VERIFIED'
        AND r.outcome_evidence_kind='VERIFIED_OBSERVATION'
        AND r.field_count=(SELECT count(*) FROM jsonb_object_keys(i.intended_values))
        AND r.resource_field_set @> (SELECT jsonb_agg(jsonb_build_object('resourceGid',i.resource_id,'fieldId',
          ($5::jsonb->CASE WHEN i.resource_id LIKE 'gid://shopify/ProductVariant/%' THEN 'variant' ELSE 'product' END)->>names.field_name))
          FROM jsonb_object_keys(i.intended_values) AS names(field_name))
        AND r.field_count=(SELECT count(*) FROM edit_history.changes c WHERE c.shop_id=r.shop_id AND c.installation_id=r.installation_id
         AND c.operation_id=r.operation_id AND c.mutation_id=r.mutation_id AND c.attempt_id=r.attempt_id
         AND c.execution_item_id=i.id AND c.resource_gid=i.resource_id AND c.mutation_state='VERIFIED' AND c.verification_state='MATCHED'
         AND c.last_evidence_kind='VERIFIED_OBSERVATION' AND c.last_evidence_fingerprint=r.outcome_evidence_fingerprint
         AND EXISTS(SELECT 1 FROM edit_history.snapshots s WHERE s.shop_id=c.shop_id
          AND s.installation_id=c.installation_id AND s.operation_id=c.operation_id AND s.change_id=c.id
          AND s.resource_gid=c.resource_gid AND s.field_id=c.field_id AND s.snapshot_kind='OBSERVED_AFTER' AND s.value_kind='VALUE'
          AND s.field_resolution_fingerprint=$6 AND s.execution_fingerprint=o.execution_fingerprint AND s.filter_fingerprint=o.filter_fingerprint
          AND s.field_definition_revision=c.field_definition_revision AND s.evidence_binding_fingerprint IS NOT NULL))))) LIMIT 1`,
         [...params,command.status,JSON.stringify(Object.fromEntries(Object.entries(RESOURCE_WRITE_CONTRACTS).map(([kind,writer])=>[kind,writer.bindings]))),approved.executionAuthority.fieldResolutionFingerprint])).rows.length;
   if(incomplete||counts?.unresolved||command.status==='SUCCEEDED'&&!counts?.verified){
    await tx.query('COMMIT');return Object.freeze({completed:false});
   }
   const state=command.status==='CANCELLED'?'CANCELLED':command.status==='SUCCEEDED'?'COMPLETED':counts?.verified?'PARTIAL':'FAILED';
   const inconsistent=(await tx.query(`SELECT id FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND execution_job_id=$3
    AND (purge_requested_at IS NOT NULL OR execution_contract_id IS DISTINCT FROM $4 OR approved_contract_fingerprint IS DISTINCT FROM $6 OR operation_state IN('COMPLETED','PARTIAL','FAILED','CANCELLED') AND operation_state<>$5) LIMIT 1`,[...params,command.contract_id,state,approved.executionAuthority.approvedContractHash])).rows.length;
   if(inconsistent)fail(C.EVIDENCE_CONFLICT,'Command history requires explicit reconciliation');
   const updated=await tx.query(`UPDATE edit_history.operations SET operation_state=$4,completed_at=COALESCE(completed_at,clock_timestamp()),updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND execution_job_id=$3 AND operation_state NOT IN('COMPLETED','PARTIAL','FAILED','CANCELLED') RETURNING id`,[...params,state]);
   if(await authorize()!==true)fail(C.UNAUTHORIZED,'Finalization authorization changed');
   const current=await invoke(resolveTenant,{authContext});
   if(current.shopId!==tenant.shopId||current.installationId!==tenant.installationId)fail(C.UNAUTHORIZED,'Finalization installation changed');
   await tx.query('COMMIT');return Object.freeze({completed:true,state,executionJobId,updatedOperations:updated.rowCount});
  }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
 };
}
