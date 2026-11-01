/** Normalized immutable metadata; current database authorization is still required. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {deepFreeze,FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
import {requireResourceWriteContract,HISTORY_EXECUTION_CAPABILITIES,WRITE_CAPABILITY_VERSION} from '../fields/write-capabilities.js';
const fail=()=>{throw new FieldError(C.CONTRACT_MISMATCH,'Execution authority coordinates missing or incompatible; reapproval required');};
const text=x=>typeof x==='string'&&x.length>0&&x.length<=4096;
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const digest=x=>'sha256:'+createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
export function currentMutationAdapterVersion(resourceType='product'){
 const writer=requireResourceWriteContract(resourceType);
 return deepFreeze({id:'HISTORY_RESOURCE_SET',version:HISTORY_EXECUTION_CAPABILITIES.version,resourceType,adapterVersion:writer.adapterVersion,
  writerVersion:WRITE_CAPABILITY_VERSION,capabilityFingerprint:digest({writer,execution:HISTORY_EXECUTION_CAPABILITIES})});
}

export function bindExecutionCoordinates({coordinates,payload,approvalRevision}){
 if(!text(approvalRevision))fail();
 const resourceType=payload.resourceType??'product',writer=Object.hasOwn(HISTORY_EXECUTION_CAPABILITIES.operations,coordinates.operation)?requireResourceWriteContract(resourceType):null;
 let fieldIds=[];
 if(writer){
  fieldIds=coordinates.operation==='import'?payload.fieldIds:
   coordinates.operation==='undo'?payload.fields?.map(name=>writer.bindings[name]):Object.keys(payload.updates??{}).map(name=>writer.bindings[name]);
  if(!Array.isArray(fieldIds)||!fieldIds.length||fieldIds.some(id=>!text(id)||!Object.hasOwn(writer.names,id)))fail();
 }else if(Array.isArray(payload.fields))fieldIds=payload.fields;
 const mutationAdapterVersion=writer?currentMutationAdapterVersion(resourceType):
  {id:'READ_ONLY',version:1,capabilityFingerprint:coordinates.installedMapping};
 const fieldResolutionFingerprint=digest({registry:coordinates.installedRegistryVersion,selectionRegistry:coordinates.registryVersion,
  definitions:coordinates.definitionRevisions,fieldIds:[...new Set(fieldIds)].sort(),mapping:coordinates.installedMapping,
  normalization:coordinates.normalizationVersion,constraints:coordinates.constraintsVersion,operators:coordinates.operatorVersion});
 return deepFreeze({...coordinates,approvalRevision,fieldResolutionFingerprint,mutationAdapterVersion});
}

// This is a projection of a verified persisted approval, never a bearer grant.
// approvedContractHash stays outside the payload that it hashes (no self-reference).
export function executionAuthorityRecord(contract,coordinates){
 const result={contractVersion:1,shopId:contract.shop_id,installationId:coordinates.installationVersion,
  operationKind:contract.operation,selectionSnapshotId:contract.snapshot_id,generationId:coordinates.generationId,
  coverageRevision:coordinates.coverageRevision,mappingVersion:coordinates.mappingVersion,
  fieldRegistryVersion:coordinates.installedRegistryVersion,fieldResolutionFingerprint:coordinates.fieldResolutionFingerprint,
  mutationAdapterVersion:coordinates.mutationAdapterVersion,approvalRevision:contract.approval_revision,
  approvedContractHash:'sha256:'+contract.contract_hash,targetMode:coordinates.targetMode,selectionHash:coordinates.selectionHash};
 if(Object.entries(result).some(([key,value])=>!['contractVersion','mutationAdapterVersion'].includes(key)&&!text(value))||
  !/^[a-f0-9]{64}$/.test(contract.contract_hash)||coordinates.approvalRevision!==result.approvalRevision||!result.mutationAdapterVersion||
  !['EXPLICIT','ALL_MATCHING','ALL_MATCHING_WITH_EXCLUSIONS'].includes(result.targetMode))fail();
 return deepFreeze(result);
}
export function assertExecutionAuthorityContext(contract,{shopId,installationId,operationKind}){
 const payload=typeof contract?.contract==='string'?JSON.parse(contract.contract):contract?.contract;
 const authority=contract?.executionAuthority;
 if(!contract||contract.evidenceOnly||!authority||authority.shopId!==shopId||authority.installationId!==installationId||authority.operationKind!==operationKind||
  !isDeepStrictEqual(authority,executionAuthorityRecord(contract,payload?.executionCoordinates??{})))fail();
 return authority;
}
