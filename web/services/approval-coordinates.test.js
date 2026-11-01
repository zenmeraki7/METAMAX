import test from 'node:test';
import assert from 'node:assert/strict';
import {bindExecutionCoordinates} from './execution-contract.server.js';
import {readApprovalCoordinates} from './approval-coordinates.server.js';
import {getApprovedContractInTransaction,getEvidenceContractInTransaction,computeContractHash,canonicalApproval} from './approval.server.js';
import {assertExecutionAuthorityContext} from './execution-contract.server.js';
import {WRITE_CAPABILITY_VERSION} from '../fields/write-capabilities.js';
async function fixture(){
 const shopId='coordinates.myshopify.com',snapshot={id:'snapshot',shop_id:shopId,operation:'bulk_edit',filter_fingerprint:'filter',status:'APPROVED',expires_at:new Date(Date.now()+60000),selection_hash:'selection',
  generation_id:'generation',coverage_revision:'coverage',mapping_version:'mapping',registry_version:'resolved-registry',definition_revisions:[{fieldId:'product.title',revision:'one'}],operation_id:'logical',
  installation_version:'installation',target_mode:'EXPLICIT',coordinate_installation:'installation',coordinate_coverage:'coverage',coordinate_mapping:'mapping',coordinate_schema:'schema',coordinate_source:'source'};
 let contract;const client={async query(sql,params){assert.equal(params[0],shopId);
  if(sql.includes('FROM mirror.execution_contracts'))return {rows:[structuredClone(contract)]};
  assert.match(sql,/sh.uninstalled_at IS NULL/);assert.match(sql,/g.shop_id=s.shop_id/);return {rows:[structuredClone(snapshot)]};
 }};
 const {coordinates:base}=await readApprovalCoordinates({client,shopId,snapshotId:snapshot.id});
 const coordinates=bindExecutionCoordinates({coordinates:base,payload:{updates:{title:'Approved'}},approvalRevision:'revision'});
 contract={approval_revision:'revision',id:'contract',shop_id:shopId,snapshot_id:snapshot.id,status:'APPROVED',operation:'bulk_edit',expires_at:new Date(Date.now()+60000),selection_hash:snapshot.selection_hash,approved_by:'merchant',hash_version:'canonical-v2',
  contract:{approvalSchemaVersion:1,updates:{title:'Approved'},writeCapabilityVersion:WRITE_CAPABILITY_VERSION,executionCoordinates:structuredClone(coordinates)}};
 const rehash=()=>{const context={shopId,snapshotId:snapshot.id,operation:contract.operation,selectionHash:contract.selection_hash,approvedBy:contract.approved_by,contract:contract.contract};contract.contract_hash=computeContractHash(context);contract.canonical_contract=canonicalApproval(context);};rehash();
 return {snapshot,contract,coordinates,rehash,getWithOptions:options=>getApprovedContractInTransaction({client,shopId,contractId:'contract',...options}),get:()=>getApprovedContractInTransaction({client,shopId,contractId:'contract'}),evidence:()=>getEvidenceContractInTransaction({client,shopId,contractId:'contract'})};
}
test('approved coordinates remain explicit, frozen metadata and verify on contract retrieval',async()=>{
 const f=await fixture();assert.ok(Object.isFrozen(f.coordinates));assert.equal((await f.get()).contract.executionCoordinates.installationVersion,'installation');
 assert.equal(f.coordinates.registryVersion,'resolved-registry');assert.ok(f.coordinates.installedRegistryVersion);assert.ok(f.coordinates.installedMapping);assert.ok(f.coordinates.writerCapabilities);
});

test('the normalized authority binds final hash, approval revision, field resolution and adapter without a circular hash',async()=>{
 const f=await fixture(),approved=await f.get(),a=approved.executionAuthority;
 assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.mutationAdapterVersion));
 assert.equal(a.approvedContractHash,'sha256:'+f.contract.contract_hash);assert.equal(a.approvalRevision,'revision');
 assert.equal(a.installationId,'installation');assert.equal(a.selectionSnapshotId,'snapshot');assert.equal(a.targetMode,'EXPLICIT');
 assert.match(a.fieldResolutionFingerprint,/^sha256:[a-f0-9]{64}$/);assert.equal(a.mutationAdapterVersion.id,'HISTORY_RESOURCE_SET');
 assert.equal(Object.hasOwn(approved.contract.executionCoordinates,'approvedContractHash'),false);
 assert.equal(assertExecutionAuthorityContext(approved,{shopId:a.shopId,installationId:a.installationId,operationKind:a.operationKind}),a);
 assert.throws(()=>assertExecutionAuthorityContext(approved,{shopId:a.shopId,installationId:'reinstalled',operationKind:a.operationKind}),{code:'FIELD_CONTRACT_MISMATCH'});
});

test('expiry and adapter replacement stop new execution but allow evidence-only reconciliation',async()=>{
 for(const modify of [f=>f.contract.expires_at=new Date(0),f=>f.contract.contract.executionCoordinates.mutationAdapterVersion.adapterVersion=999]){
  const f=await fixture();modify(f);f.rehash();await assert.rejects(f.get);await assert.rejects(()=>f.getWithOptions({historical:true}));
  const archived=await f.evidence();assert.equal(archived.evidenceOnly,true);assert.equal(archived.executionAuthority.installationId,'installation');
  assert.throws(()=>assertExecutionAuthorityContext(archived,{shopId:archived.shop_id,installationId:'installation',operationKind:'bulk_edit'}),{code:'FIELD_CONTRACT_MISMATCH'});
 }
});
test('validly hashed approvals still fail closed on every stale capability and snapshot coordinate',async()=>{
 for(const key of ['version','approvalRevision','fieldResolutionFingerprint','mutationAdapterVersion','targetMode','executionCapabilities','normalizationVersion','constraintsVersion','operatorVersion','fieldCapabilityVersion','operation','filterFingerprint','installationVersion','snapshotId','logicalOperationId','generationId','coverageRevision','mappingVersion','registryVersion','definitionRevisions','selectionHash','installedRegistryVersion','writerVersion','writerCapabilities','installedMapping','mirrorSchemaVersion','sourceContractVersion']){
  const f=await fixture();f.contract.contract.executionCoordinates[key]=key==='version'?99:key==='definitionRevisions'?[]:'obsolete';f.rehash();
  await assert.rejects(f.get,{code:'FIELD_CONTRACT_MISMATCH'},key);
 }
 for(const key of ['coordinate_installation','generation_id','registry_version','coordinate_schema','coordinate_source','selection_hash','operation_id']){
  const f=await fixture();f.snapshot[key]='replaced';await assert.rejects(f.get,{code:'FIELD_CONTRACT_MISMATCH'},key);
 }
});
test('unbound approvals, expired snapshots and inconsistent generation mappings require reapproval',async()=>{
 for(const change of [f=>delete f.contract.contract.approvalSchemaVersion,f=>f.contract.contract.approvalSchemaVersion=99,f=>delete f.contract.contract.executionCoordinates,f=>f.contract.contract.writeCapabilityVersion='product-set-v1',
  f=>f.snapshot.expires_at=new Date(0),f=>f.snapshot.coordinate_mapping='different',f=>f.snapshot.coordinate_coverage='different']){
  const f=await fixture();change(f);f.rehash();await assert.rejects(f.get,{code:'FIELD_CONTRACT_MISMATCH'});
 }
});
