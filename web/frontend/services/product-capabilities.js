import {FIELD_CAPABILITY_VERSIONS,getFieldCapability} from '../../fields/capabilities.js';
import {FILTER_BINDING_DEFINITIONS} from '../../fields/sources.js';
const installed=new Map(FILTER_BINDING_DEFINITIONS.map(binding=>[binding.fieldId,binding]));
export function validateProductCapabilities(value,snapshotId,revision){
 if(!value||Object.entries(FIELD_CAPABILITY_VERSIONS).some(([key,expected])=>value[key]!==expected)||value.snapshotId!==snapshotId||value.publishedRevision!==revision||!Array.isArray(value.fields)||value.fields.length>100)throw Error('Incompatible capabilities');
 const ids=new Set();
 for(const field of value.fields){
  const binding=field&&installed.get(field.id);if(!binding||ids.has(field.id)||!Array.isArray(field.operators)||field.operators.length>32||new Set(field.operators).size!==field.operators.length||field.operators.some(operator=>!binding.operators.includes(operator)))throw Error('Invalid capabilities');
  const expected=getFieldCapability(field.id,{bindingOperators:field.operators});
  if(field.type!==expected.type||JSON.stringify(field.enumValues??null)!==JSON.stringify(expected.enumValues))throw Error('Invalid field capability definition');
  ids.add(field.id);
 }
 return value.fields;
}
