/** Explicit immutable approval coordinates. No authorization grants are cached. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {getInstalledFieldRegistryVersion} from '../fields/resolve.js';
import {WRITE_CAPABILITY_VERSION,INSTALLED_WRITE_CAPABILITIES,RESOURCE_WRITE_CONTRACTS,HISTORY_EXECUTION_CAPABILITIES} from '../fields/write-capabilities.js';
import {getInstalledFilterSchemaOptions} from './filter-schema.server.js';
import {NORMALIZE_CONTRACT_VERSION} from '../fields/normalize.js';
import {CONSTRAINTS_VERSION} from '../fields/constraints.js';
import {OPERATOR_CONTRACT_VERSION} from '../fields/operators.js';
import {FIELD_CAPABILITY_CONTRACT_VERSION} from '../fields/capabilities.js';
import {deepFreeze,FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
import {bindExecutionCoordinates} from './execution-contract.server.js';
const fail=()=>{throw new FieldError(C.CONTRACT_MISMATCH,'Approval execution coordinates missing or incompatible; reapproval required');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalar=value=>typeof value==='string'&&value.length>0&&value.length<=512;
export const APPROVAL_SCHEMA_VERSION=1;
export async function readApprovalCoordinates({client,shopId,snapshotId}={}){
 const snapshot=(await client.query(`SELECT s.*,sh.installation_version AS coordinate_installation,
  g.coverage_revision AS coordinate_coverage,g.mapping_version AS coordinate_mapping,
  g.mirror_schema_version AS coordinate_schema,g.source_contract_version AS coordinate_source
  FROM mirror.selection_snapshots s JOIN mirror.shops sh ON sh.id=s.shop_id AND sh.uninstalled_at IS NULL
  JOIN mirror.generations g ON g.shop_id=s.shop_id AND g.id=s.generation_id
  WHERE s.shop_id=$1 AND s.id=$2 FOR SHARE OF s,sh,g`,[shopId,snapshotId])).rows[0];
 if(!snapshot||snapshot.id!==snapshotId||snapshot.shop_id!==shopId||snapshot.status!=='APPROVED'||snapshot.installation_version!==snapshot.coordinate_installation||
  !['EXPLICIT','ALL_MATCHING','ALL_MATCHING_WITH_EXCLUSIONS'].includes(snapshot.target_mode)||
  !Number.isFinite(new Date(snapshot.expires_at).getTime())||new Date(snapshot.expires_at).getTime()<=Date.now()||
  ['coordinate_installation','generation_id','coverage_revision','mapping_version','registry_version','operation','operation_id','filter_fingerprint','selection_hash','coordinate_schema','coordinate_source'].some(key=>!scalar(snapshot[key]))||
  snapshot.coordinate_coverage!==snapshot.coverage_revision||snapshot.coordinate_mapping!==snapshot.mapping_version||!Array.isArray(snapshot.definition_revisions))fail();
 const coordinates={version:1,targetMode:snapshot.target_mode,executionCapabilities:HISTORY_EXECUTION_CAPABILITIES,normalizationVersion:NORMALIZE_CONTRACT_VERSION,constraintsVersion:CONSTRAINTS_VERSION,operatorVersion:OPERATOR_CONTRACT_VERSION,fieldCapabilityVersion:FIELD_CAPABILITY_CONTRACT_VERSION,shopId,installationVersion:snapshot.installation_version,snapshotId,
  operation:snapshot.operation,logicalOperationId:snapshot.operation_id,filterFingerprint:snapshot.filter_fingerprint,generationId:snapshot.generation_id,coverageRevision:snapshot.coverage_revision,
  mappingVersion:snapshot.mapping_version,registryVersion:snapshot.registry_version,definitionRevisions:snapshot.definition_revisions,
  selectionHash:snapshot.selection_hash,installedRegistryVersion:getInstalledFieldRegistryVersion(),
  writerVersion:WRITE_CAPABILITY_VERSION,writerCapabilities:digest({capabilities:INSTALLED_WRITE_CAPABILITIES,resources:RESOURCE_WRITE_CONTRACTS}),
  installedMapping:digest(getInstalledFilterSchemaOptions()),mirrorSchemaVersion:snapshot.coordinate_schema,sourceContractVersion:snapshot.coordinate_source};
 return {snapshot,coordinates:deepFreeze(coordinates)};
}
export async function verifyApprovalCoordinates({client,shopId,contract}={}){
 const payload=typeof contract.contract==='string'?JSON.parse(contract.contract):contract.contract;
 if(payload?.approvalSchemaVersion!==APPROVAL_SCHEMA_VERSION||!payload.executionCoordinates||payload.writeCapabilityVersion!==WRITE_CAPABILITY_VERSION)fail();
 const {coordinates:base}=await readApprovalCoordinates({client,shopId,snapshotId:contract.snapshot_id});
 const coordinates=bindExecutionCoordinates({coordinates:base,payload,approvalRevision:contract.approval_revision});
 if(!isDeepStrictEqual(payload.executionCoordinates,coordinates)||contract.selection_hash!==coordinates.selectionHash||contract.operation!==coordinates.operation)fail();
 return coordinates;
}
