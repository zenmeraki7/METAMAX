import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {CANONICAL_REGISTRY_INFO} from '../fields/canonical.js';
import {NORMALIZE_CONTRACT_VERSION} from '../fields/normalize.js';
import {CONSTRAINTS_VERSION} from '../fields/constraints.js';
import {OPERATOR_CONTRACT_VERSION} from '../fields/operators.js';
import {FILTER_BINDING_VERSION} from '../filters/bindings.js';
import {FILTER_VALIDATION_VERSION} from '../filters/contracts.js';
// Isolate comparison from the separately exercised issued-service provenance.
const fields=await import('../fields/resolve.js'),filters=await import('../filters/validate.js');
mock.module('../fields/resolve.js',{namedExports:{...fields,assertAuthorizedFieldService(){}}});
mock.module('../filters/validate.js',{namedExports:{...filters,assertAuthorizedFilterService(){}}});
const {createHistorySnapshotService}=await import('../edit-history/snapshot-service.server.js');
function fixture(){
 const common={shopId:'identity.myshopify.com',operation:'bulk_edit',operationId:'operation',phase:'execute',generationId:'generation',coverageRevision:'coverage',
  targetingSnapshotId:'target',executionContractId:'contract',approvalRevision:'approval',mirrorSchemaVersion:'schema',sourceContractVersion:'source'};
 const descriptor={id:'product.title',origin:'canonical',field:{id:'product.title'},source:{revision:'one'}};
 const write={...common,access:'write',registryVersion:'a'.repeat(64),writeCapabilityVersion:'writer',fields:[descriptor],definitionRevisions:[],datasets:['products']};
 const read={...write,access:'read',registryVersion:'b'.repeat(64)};
 const versions={validation:FILTER_VALIDATION_VERSION,ast:1,canonical:CANONICAL_REGISTRY_INFO.registryVersion,operators:OPERATOR_CONTRACT_VERSION,
  bindings:FILTER_BINDING_VERSION,normalization:NORMALIZE_CONTRACT_VERSION,constraints:CONSTRAINTS_VERSION};
 const filter={...common,registryVersion:read.registryVersion,definitionRevisions:[],versions};
 const plan={fieldIds:['product.title'],fields:[descriptor],datasets:['products'],versions};
 const service=createHistorySnapshotService({fieldService:{assertResolution(){},revalidateResolution:async()=>write,requireFields:async()=>read},
  filterService:{revalidateFilter:async()=>filter,getResolutionPlan:()=>plan}});
 return{write,read,filter,plan,run:()=>service.createSnapshot({authContext:{},fieldResolution:structuredClone(write),validatedFilter:filter,
  identity:{shopId:common.shopId,installationId:'installation',executionJobId:'1',executionItemId:'2',mutationId:'mutation',resourceGid:'gid://shopify/Product/1',fieldId:'product.title'},kind:'BEFORE',valueKind:'VALUE',value:'Title',observation:{}})};
}
for(const version of ['validation','ast','canonical','operators','bindings','normalization','constraints'])test(`history rejects stale ${version} code coordinates`,async()=>{
 const f=fixture();f.filter.versions={...f.filter.versions,[version]:-1};await assert.rejects(f.run,{code:'HISTORY_BINDING_CONFLICT'});
});
for(const [label,change] of [
 ['registry',f=>f.read.registryVersion='changed'],['definitions',f=>f.read.definitionRevisions=[{fieldId:'product.title',definitionToken:'other'}]],
 ['mapping descriptor',f=>f.read.fields=[{...f.read.fields[0],source:{revision:'changed'}}]],['datasets',f=>f.read.datasets=['variants']]
])test(`history rejects changed filter ${label}`,async()=>{
 const f=fixture();change(f);await assert.rejects(f.run,{code:'HISTORY_BINDING_CONFLICT'});
});
