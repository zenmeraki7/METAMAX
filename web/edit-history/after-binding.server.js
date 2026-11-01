import {isDeepStrictEqual} from 'node:util';
import {HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
/** Compare evidence coordinates; this issues no permission or execution grant. */
export function assertAfterBinding(binding,before,operation,change){
 if(!before||!isDeepStrictEqual(
  [binding.executionFingerprint,binding.filterFingerprint,binding.fieldResolutionFingerprint,binding.fieldDefinitionRevision,
   binding.mode,binding.generationId,binding.coverageRevision,binding.mappingVersion,binding.executionSnapshotId],
  [operation.execution_fingerprint,operation.filter_fingerprint,before.field_resolution_fingerprint,change.field_definition_revision,
   before.binding_mode,before.generation_id,before.coverage_revision,before.mapping_version,before.execution_snapshot_id]))
  throw new HistoryContractError(C.BINDING_CONFLICT,'After observation coordinates differ from admitted authority');
}
