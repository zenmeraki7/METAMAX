import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAfterBinding} from '../edit-history/after-binding.server.js';
import {normalizeHistoryBinding} from '../edit-history/history-contract.js';
const H='sha256:'+'a'.repeat(64);
const binding=normalizeHistoryBinding({mode:'MIRROR_PINNED',executionFingerprint:H,filterFingerprint:H,fieldResolutionFingerprint:H,
 fieldDefinitionRevision:'registry',generationId:'generation',coverageRevision:'coverage',mappingVersion:'mapping'});
const before={field_resolution_fingerprint:H,binding_mode:binding.mode,generation_id:binding.generationId,coverage_revision:binding.coverageRevision,
 mapping_version:binding.mappingVersion,execution_snapshot_id:binding.executionSnapshotId};
const operation={execution_fingerprint:H,filter_fingerprint:H},change={field_definition_revision:'registry'};
test('AFTER evidence retains all original pinned coordinates',()=>assert.doesNotThrow(()=>assertAfterBinding(binding,before,operation,change)));
for(const key of ['executionFingerprint','filterFingerprint','fieldResolutionFingerprint','fieldDefinitionRevision','mode','generationId','coverageRevision','mappingVersion','executionSnapshotId'])
 test(`AFTER evidence rejects a changed ${key}`,()=>assert.throws(()=>assertAfterBinding({...binding,[key]:'different'},before,operation,change),{code:'HISTORY_BINDING_CONFLICT'}));
