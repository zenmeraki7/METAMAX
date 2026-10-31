/** Transaction-local composition. Never accepts an authority from request JSON. */
import { createHistoryExecutionAuthority } from './execution-authority.server.js';
import { historyMemberKey } from './request-members.server.js';
import { HistoryContractError,HISTORY_ERROR_CODES as C } from './history-contract.js';
import { assertHistoryExecutionAdapter } from '../services/history-execution-adapter.server.js';

export function createRepositoryAdmissionAuthority({executionAdapter,invoke,resolveTenant,authorizePlan,verifyObservation,
 tenant,plan,contract,ownedMirror,replay}) {
 assertHistoryExecutionAdapter(executionAdapter);
 const project=()=>({...Object.fromEntries(['shopId','installationId','executionJobId','editOperationId','executionContractId',
  'mutationId','mutationPlanFingerprint','executionFingerprint','filterFingerprint','approvedContractFingerprint',
  'attemptId','attemptNumber','fenceEpoch','executionClaimId','startedAt'].map(key=>[key,plan[key]])),
  executionItemId:plan.fields[0].identity.executionItemId,
  fields:plan.fields.map(f=>({...Object.fromEntries(['identity','binding','resourceFamilyGid','intendedValueKind',
   ...(Object.hasOwn(f,'intendedValue')?['intendedValue']:[])].map(key=>[key,f[key]])),mutationPlanFingerprint:plan.mutationPlanFingerprint}))});
 return createHistoryExecutionAuthority({
  resolveTenant:context=>invoke(resolveTenant,context),
  async verifyInstallation(context){await executionAdapter.assertTenant(context);return{verified:true,current:true,...context.tenant};},
  async loadApprovedExecutionPlan(){return project();},
  async verifyExecutionOwnership(context){
   // lockAuthority and item/target checks have already acquired protecting locks
   // on this connection. Revalidate the real private engine lease with FOR UPDATE.
   await executionAdapter.assertExecutionClaim({client:context.client,tenant,jobId:plan.executionJobId,claim:context.claim});
   return{verified:true,...tenant,executionJobId:plan.executionJobId,executionItemId:context.plan.executionItemId,
    mutationId:plan.mutationId,...context.claim,lockScope:'AUTHORITATIVE_EXECUTION_JOB_UNTIL_TRANSACTION_END'};
  },
  async verifyFieldAuthorization(context){return{verified:await invoke(authorizePlan,{...context,tenant,plan,contract}),
   ...tenant,executionJobId:plan.executionJobId,mutationId:plan.mutationId,approvedPlanFingerprint:plan.mutationPlanFingerprint};},
  async verifyObservationProvenance(context){
   const snapshot=context.beforeSnapshot;
   if(await invoke(verifyObservation,{...context,tenant,plan,snapshot,mirrorSnapshot:ownedMirror.get(historyMemberKey(snapshot.identity))})!==true)
    throw new HistoryContractError(C.EVIDENCE_REQUIRED,replay?'Persisted observation receipt is not authentic':'Authenticated BEFORE observation required');
   return{verified:true,...tenant,observationId:snapshot.observation.observationId,snapshotFingerprint:snapshot.fingerprint,
    evidenceBindingFingerprint:snapshot.evidenceBindingFingerprint,receiptFingerprint:snapshot.observation.receiptFingerprint};
  },
 });
}
