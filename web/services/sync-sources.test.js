import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSyncSourcesService} from './sync-sources.server.js';
import {FILTER_SQL_SCHEMA} from '../fields/sources.js';

function fixture(overrides={}){
  const session={shop:'sources.myshopify.com',scope:'read_products'};
  const row={installation_version:'current',generation_status:'PUBLISHED',published_at:'2026-10-01T01:02:03Z',
    mirror_schema_version:FILTER_SQL_SCHEMA.mirrorSchemaVersion,source_contract_version:FILTER_SQL_SCHEMA.sourceContractVersion,
    mapping_version:'mapping_v1',products_coverage:'COMPLETE',variants_coverage:'COMPLETE',imported_job_id:'job-1',job_status:'SUCCEEDED',...overrides};
  const queries=[];
  const service=createSyncSourcesService({authentication:{resolveShop:async()=>session.shop,resolveSession:async()=>session},
    repository:{async read(){queries.push({name:'sync_sources.read'});return row;}}});
  return {service,session,queries,row};
}
test('source health requires exact published coverage, compatible versions and a current installation import',async()=>{
  const {service}=fixture();const first=await service.read({authContext:{}}),second=await service.read({authContext:{}});
  assert.equal(first.sources[0].status,'healthy');assert.equal(first.sources[0].lastFullSyncAt,'2026-10-01T01:02:03.000Z');
  assert.equal(first.isUpToDate, true);
  assert.deepEqual(first,second);assert.ok(first.sources.slice(1).every(source=>source.supported===false&&source.status==='unavailable'&&source.lastFullSyncAt===null));
  for(const change of [{job_status:'UNKNOWN'},{imported_job_id:null},{variants_coverage:'FAILED'},{generation_status:'RETIRED'},{mapping_version:'incompatible'},{mirror_schema_version:'incompatible'},{source_contract_version:'incompatible'},{published_at:null}]){
    const value=await fixture(change).service.read({authContext:{}});assert.equal(value.sources[0].status,'unavailable');assert.equal(value.sources[0].lastFullSyncAt,null);
    assert.equal(value.isUpToDate, false);
  }
});
test('durable running, retry, failure and cancellation state overrides healthy status while retaining actual prior completion',async()=>{
  for(const [job_status,status] of [['QUEUED','queued'],['RETRY','queued'],['RUNNING','running'],['FAILED','failed'],['CANCELLED','cancelled']]){
    const result=await fixture({job_status}).service.read({authContext:{}});assert.equal(result.sources[0].status,status);assert.equal(result.sources[0].lastFullSyncAt,'2026-10-01T01:02:03.000Z');
    assert.equal(result.isUpToDate, false);
  }
});
test('source reads require current app and staff scopes before accessing tenant data',async()=>{
  for(const scopes of [{scope:'read_orders'},{isOnline:true,onlineAccessInfo:{associated_user_scope:'read_orders'}}]){
    const f=fixture();Object.assign(f.session,scopes);
    await assert.rejects(()=>f.service.read({authContext:{}}),{code:'FIELD_PERMISSION_DENIED'});assert.equal(f.queries.length,0);
  }
});
