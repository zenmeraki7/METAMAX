/** Trusted provider fixture only. Production reloads and hashes persisted records. */
import {bindExecutionCoordinates,executionAuthorityRecord} from '../../services/execution-contract.server.js';
import {WRITE_CAPABILITY_VERSION} from '../../fields/write-capabilities.js';
export function approvedContractFixture(input,{installationId='install-1'}={}){
 const row={id:'contract',snapshot_id:'snapshot',approval_revision:'approval',contract_hash:'a'.repeat(64),...input};
 const payload=typeof row.contract==='string'?JSON.parse(row.contract):row.contract;
 const coordinates=bindExecutionCoordinates({coordinates:{shopId:row.shop_id,snapshotId:row.snapshot_id,operation:row.operation,
  installationVersion:installationId,targetMode:'EXPLICIT',generationId:'generation',coverageRevision:'coverage',mappingVersion:'mapping',
  registryVersion:'registry',definitionRevisions:[],selectionHash:'selection',installedRegistryVersion:'installed',installedMapping:'mapping',
  normalizationVersion:2,constraintsVersion:5,operatorVersion:1,writerVersion:WRITE_CAPABILITY_VERSION,writerCapabilities:'capabilities'},
  payload,approvalRevision:row.approval_revision});
 row.contract={...payload,executionCoordinates:coordinates};row.executionAuthority=executionAuthorityRecord(row,coordinates);
 return row;
}
