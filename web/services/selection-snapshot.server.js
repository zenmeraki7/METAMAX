import {deepFreeze,FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
/** The service boundary exposes this shape for both creation and stored reads. */
export function selectionSnapshotRecord(row){
 if(!row)return null;
 const selectedCount=Number(row.selected_count);
 if(!Number.isSafeInteger(selectedCount)||selectedCount<0||typeof row.installation_version!=='string'||!row.installation_version||
  !['EXPLICIT','ALL_MATCHING','ALL_MATCHING_WITH_EXCLUSIONS'].includes(row.target_mode))throw new FieldError(C.CONTRACT_MISMATCH,'Invalid persisted selection coordinates');
 return deepFreeze({snapshotId:row.id,shopId:row.shop_id,installationId:row.installation_version,
  generationId:row.generation_id,coverageRevision:row.coverage_revision,mappingVersion:row.mapping_version,
  operation:row.operation,operationId:row.operation_id,targetMode:row.target_mode,status:row.status,
  selectedCount,selectionHash:row.selection_hash,registryVersion:row.registry_version,definitionRevisions:row.definition_revisions,
  frozenAt:row.frozen_at?new Date(row.frozen_at).toISOString():null,expiresAt:new Date(row.expires_at).toISOString()});
}
