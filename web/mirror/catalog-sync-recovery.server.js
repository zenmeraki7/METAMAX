import { randomUUID } from "node:crypto";
import { createSyncRecoveryOrchestrator } from "./sync-recovery.server.js";
import { createSyncRecoveryRepository } from "./sync-recovery-repository.server.js";
import { BULK_STATUS_QUERY } from "./bulk-sync.server.js";
import { CATALOG_INPUT_HASH } from "./catalog-sync-steps.server.js";

// No HTTP recovery setter or exported receipt issuer. The verifier's private
// receipts are checked against the repository's freshly locked durable intent.
export function createCatalogSyncRecovery({database,clientFactory,syncRunRepository,dispatchRepository}) {
  const proofs=new Map();
  const scope=(runId,shopId,generationId,phase,fence,intentId)=>JSON.stringify([runId,shopId,generationId,phase,fence,intentId]);
  const repository=createSyncRecoveryRepository({database,syncRunRepository,dispatchRepository,inputHash:CATALOG_INPUT_HASH,
    verifyRecoveryEvidence({claim,verification,intent}) {
      const proof=proofs.get(verification.evidence?.ticket);
      return Boolean(proof&&proof.until>Date.now()&&proof.kind===verification.kind&&
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
        signal.throwIfAborted();
        const response=await client.request(BULK_STATUS_QUERY,{variables:{id:intent.operationId}});
        signal.throwIfAborted();
        if(response.errors||response.data?.bulkOperation?.id!==intent.operationId)return {kind:'UNRESOLVED'};
        operationId=intent.operationId;kind='CONFIRMED';
      } else if(phase==='WAITING'||(intent.state&&!['PREPARED','REJECTED'].includes(intent.state)))return {kind:'UNRESOLVED'};
    }
    // Remaining phases replay fenced DB operations and validated checkpoints,
    // revision acknowledgments and publication checks, never a remote start.
    const ticket=randomUUID();
    if(proofs.size>=32)proofs.clear();
    proofs.set(ticket,{scope:scope(runId,shopId,generationId,phase,intent.recoveryFence,intent.id),
      until:Date.now()+45000,kind,operationId});
    return {kind,authoritative:true,evidence:{ticket}};
  }};
  return createSyncRecoveryOrchestrator({recoveryRepository:repository,externalVerifier});
}
