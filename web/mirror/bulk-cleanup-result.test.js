import test from 'node:test';
import assert from 'node:assert/strict';
import {boundBulkStatus} from './bulk-cleanup-result.server.js';
const id='gid://shopify/BulkOperation/1';
const response=status=>({data:{bulkOperationCancel:{userErrors:[],bulkOperation:{id,status}}}});
test('remote cleanup requires exact identity, complete payload and terminal evidence',()=>{
 for(const raw of [{data:{bulkOperationCancel:null}},{},response('RUNNING'),response('UNKNOWN'),{data:{bulkOperationCancel:{bulkOperation:{id,status:'CANCELLED'}}}},{errors:[{}],...response('CANCELLED')},{data:{bulkOperationCancel:{userErrors:[],bulkOperation:{id:'other',status:'CANCELLED'}}}}])assert.throws(()=>boundBulkStatus(raw,id,{cancellation:true}));
 assert.deepEqual(boundBulkStatus(response('CANCELING'),id,{cancellation:true}),{status:'CANCELING',terminal:false});
 for(const status of ['CANCELLED','COMPLETED','FAILED','EXPIRED'])assert.equal(boundBulkStatus(response(status),id,{cancellation:true}).terminal,true);
 assert.throws(()=>boundBulkStatus({errors:[{}],data:{bulkOperation:{id,status:'CANCELLED'}}},id));
});
