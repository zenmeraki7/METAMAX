import test from 'node:test';
import assert from 'node:assert/strict';
import {bulkInstructions,assertIntendedValues,requireWriteAuthorization} from '../services/operation-instructions.server.js';
import {createOperationWorker} from './operation.worker.js';
const shopId='worker.myshopify.com';
const contract={shop_id:shopId,status:'APPROVED',operation:'bulk_edit',contract:{updates:{title:'Approved'}}};
for(const [label,intended] of [['display metadata',{title:'Approved',targetTitle:'Metadata'}],['unapproved fields',{title:'Approved',vendor:'Injected'}],['changed values',{title:'Changed'}]]){
 test(`operation instructions reject ${label}`,()=>assert.throws(()=>assertIntendedValues(intended,bulkInstructions(contract,shopId))));
}
test('operation instructions reject a different shop or revoked approval',()=>{
 assert.throws(()=>bulkInstructions(contract,'other.myshopify.com'));
 assert.throws(()=>bulkInstructions({...contract,status:'REVOKED'},shopId));
});
test('current write permission must return literal true',async()=>{
 await assert.rejects(()=>requireWriteAuthorization(async()=>false,{}));
 await assert.rejects(()=>requireWriteAuthorization(async()=>({allowed:true}),{}));
});
test('operation worker has no nontransactional or unjournaled construction path',()=>{
 assert.throws(()=>createOperationWorker({database:{async query(){}},approvalService:{async getApprovedContract(){}},authorizeWrite:async()=>true}));
});