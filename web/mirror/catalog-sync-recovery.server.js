import {AsyncLocalStorage} from 'node:async_hooks';
import { randomUUID } from "node:crypto";
import { createSyncRecoveryOrchestrator } from "./sync-recovery.server.js";
import { createSyncRecoveryRepository } from "./sync-recovery-repository.server.js";
import { BULK_STATUS_QUERY } from "./bulk-sync.server.js";
import { CATALOG_INPUT_HASH } from "./catalog-sync-steps.server.js";

// Input: opaque run ID and optional AbortSignal. Output: durable orchestrator
// disposition. Each call owns its own short-lived evidence; no cache, queue ticket
// or cross-process handoff exists. Other workers claim/reverify durable intent
// independently. Repository lease/fence/intent checks authorize every final write.
// Restart/timeout discards evidence and leaves durable recovery eligible again.
export function createCatalogSyncRecovery({database,clientFactory,syncRunRepository,dispatchRepository}) {
  const invocationScope=new AsyncLocalStorage();
  const scope=(runId,shopId,generationId,phase,fence,intentId)=>JSON.stringify([runId,shopId,generationId,phase,fence,intentId]);
  const repository=createSyncRecoveryRepository({database,syncRunRepository,dispatchRepository,inputHash:CATALOG_INPUT_HASH,
    verifyRecoveryEvidence({claim,verification,intent}) {
      const invocation=invocationScope.getStore(),proof=invocation?.proof;
      return Boolean(invocation&&!invocation.closed&&proof&&proof.ticket===verification.evidence?.ticket&&proof.until>Date.now()&&proof.kind===verification.kind&&
        proof.scope===scope(claim.runId,claim.shopId,claim.generationId,claim.phase,claim.fence,intent.id)&&
        (!['STARTING','WAITING'].includes(claim.phase)||proof.operationId===intent.operationId));
    },
  });
  const externalVerifier={async verify({runId,shopId,generationId,phase,intent,signal}) {
    let kind='SAFE_TO_RETRY',operationId=null;
    if(phase==='STARTING'||phase==='WAITING') {
      if(intent.operationId) {
        if(intent.inputHash!==CATALOG_INPUT_HASH)return {kind:'UNRESOLVED'};
        const client=clientFactory({shopId,installationVersion:intent.installationVersion});
        signal?.throwIfAborted();
        const response=await client.request(BULK_STATUS_QUERY,{variables:{id:intent.operationId},signal});
        signal?.throwIfAborted();
        if(response.errors||response.data?.bulkOperation?.id!==intent.operationId)return {kind:'UNRESOLVED'};
        operationId=intent.operationId;kind='CONFIRMED';
      } else if(phase==='WAITING'||(intent.state&&!['PREPARED','REJECTED'].includes(intent.state)))return {kind:'UNRESOLVED'};
    }
    // Remaining phases replay fenced DB operations and validated checkpoints,
    // revision acknowledgments and publication checks, never a remote start.
    const ticket=randomUUID();
    signal?.throwIfAborted();
    const invocation=invocationScope.getStore();
    if(!invocation||invocation.closed)return {kind:'UNRESOLVED'};
    invocation.proof={ticket,scope:scope(runId,shopId,generationId,phase,intent.recoveryFence,intent.id),
      until:Date.now()+45000,kind,operationId};
    return {kind,authoritative:true,evidence:{ticket}};
  }};
  const orchestrator=createSyncRecoveryOrchestrator({recoveryRepository:repository,externalVerifier});
  return Object.freeze({recoverRun(runId,options){
    return invocationScope.run({proof:null,closed:false},async()=>{
      const invocation=invocationScope.getStore();
      try{return await orchestrator.recoverRun(runId,options);}
      finally{invocation.closed=true;invocation.proof=null;}
    });
  }});
}
