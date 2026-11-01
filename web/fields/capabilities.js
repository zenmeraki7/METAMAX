/** Authoritative pure metadata. Installed capability never grants permission. */
import {requireCanonicalField} from './canonical.js';
import {listOperatorsForType,OPERATOR_CONTRACT_VERSION} from './operators.js';
import {getFieldConstraints,listFieldWriteOperations,CONSTRAINTS_VERSION} from './constraints.js';
import {NORMALIZE_CONTRACT_VERSION} from './normalize.js';
import {INSTALLED_WRITE_CAPABILITIES,WRITE_CAPABILITY_VERSION} from './write-capabilities.js';
import {deepFreeze} from './types.js';
export const FIELD_CAPABILITY_CONTRACT_VERSION=1;
export const FIELD_CAPABILITY_VERSIONS=deepFreeze({capabilityContractVersion:FIELD_CAPABILITY_CONTRACT_VERSION,normalizationVersion:NORMALIZE_CONTRACT_VERSION,constraintsVersion:CONSTRAINTS_VERSION,operatorVersion:OPERATOR_CONTRACT_VERSION,writeCapabilityVersion:WRITE_CAPABILITY_VERSION});
export function getFieldCapability(fieldId,{bindingOperators}={}){
 const field=requireCanonicalField(fieldId),compatible=listOperatorsForType(field.type).map(operator=>operator.id);
 if(bindingOperators!==undefined&&(!Array.isArray(bindingOperators)||new Set(bindingOperators).size!==bindingOperators.length||bindingOperators.some(operator=>!compatible.includes(operator))))throw TypeError('Verified compatible binding operators required');
 return deepFreeze({id:field.id,type:field.type,label:field.label,operators:bindingOperators??compatible,enumValues:getFieldConstraints(field.id,'filter').enumValues??null,
  installedWriteOperations:listFieldWriteOperations(field.id),writeCapabilityVersion:WRITE_CAPABILITY_VERSION,writeAdapter:INSTALLED_WRITE_CAPABILITIES.fields[field.id]??null});
}
