import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogImportProgress} from './catalog-import-progress.server.js';

test('progress uses committed counts, supports bigint totals and reserves 100 for publication',()=>{
  assert.equal(catalogImportProgress({status:'QUEUED'}).percent,0);
  assert.equal(catalogImportProgress({phase:'WAITING',status:'RUNNING'}).percent,15);
  assert.equal(catalogImportProgress({phase:'INGESTING',status:'RUNNING',processed_lines:'500000000000000000',expected_lines:'1000000000000000000'}).percent,50);
  assert.equal(catalogImportProgress({phase:'INGESTING',processed_lines:'100',expected_lines:'100'}).percent,80);
  assert.equal(catalogImportProgress({phase:'INGESTING',processed_lines:'0',expected_lines:'0'}).percent,20);
  assert.equal(catalogImportProgress({phase:'INGESTING',processed_lines:'5',expected_lines:null}).percent,20);
  assert.equal(catalogImportProgress({status:'SUCCEEDED',generation_status:'VERIFIED',phase:'PUBLISHING'}).percent,95);
  assert.deepEqual(catalogImportProgress({status:'SUCCEEDED',generation_status:'PUBLISHED'}),{
    percent:100,estimated:false,stage:'Your catalog mirror is ready',processedLines:null,expectedLines:null});
});
test('retry, review, cancellation and uncertainty retain phase progress without claiming completion',()=>{
  assert.match(catalogImportProgress({status:'RETRY',phase:'INGESTING'}).stage,/retry/);
  assert.match(catalogImportProgress({status:'RUNNING',review_required:true,phase:'PUBLISHING'}).stage,/attention/);
  assert.match(catalogImportProgress({status:'RUNNING',outcome_uncertain:true}).stage,/Verifying/);
  assert.match(catalogImportProgress({status:'CANCELLED'}).stage,/cancelled/);
  assert.match(catalogImportProgress({status:'FAILED'}).stage,/could not/);
});
