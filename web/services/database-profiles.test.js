import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRuntimeDatabase,createVerifiedRuntimePool,assertRuntimeDatabaseProfile} from '../security/runtime-database.server.js';
function state(role='metamax_engine_runtime'){
 return {roles:[{oid:1,rolname:role}],tables:[{oid:2,nspname:'mirror',relname:'shops',relkind:'r',relowner:99,relrowsecurity:true,tenant_owned:false}],policies:[{polrelid:2,polname:'metamax_tenant_isolation',polcmd:'*',polpermissive:true,using_expr:"(id = current_setting('app.shop_id'::text, true))",check_expr:"(id = current_setting('app.shop_id'::text, true))"}]};
}
const client=value=>({query:async()=>({rows:[value]})});
test('merchant runtime rejects broad policies, mixed profiles and catalog mutation grants',async()=>{
 await verifyRuntimeDatabase(client(state()));
 for(const change of [s=>s.roles.push({oid:3,rolname:'metamax_catalog_worker'}),s=>s.policies.push({polrelid:2,polname:'metamax_control_plane',polcmd:'*',polpermissive:true,using_expr:'true',check_expr:'true'}),s=>Object.assign(s.tables[0],{can_update:true,update_columns:['installation_version']})]){
  const current=state();change(current);await assert.rejects(()=>verifyRuntimeDatabase(client(current)));
 }
});
test('worker profiles cannot inherit each other and cannot mutate outside their domain',async()=>{
 const operation=state('metamax_operation_worker');await verifyRuntimeDatabase(client(operation),{profile:'operationWorker'});
 await assert.rejects(()=>verifyRuntimeDatabase(client(operation),{profile:'catalogWorker'}));
 operation.tables.push({oid:4,nspname:'mirror',relname:'products',can_update:true,update_columns:['title']});
 await assert.rejects(()=>verifyRuntimeDatabase(client(operation),{profile:'operationWorker'}));
});
test('bulk gateways cannot substitute raw pools or another profile facade',async()=>{
 const raw={connect(){throw Error('No acquisition needed');}},merchant=createVerifiedRuntimePool(raw),worker=createVerifiedRuntimePool(raw,{profile:'operationWorker'});
 assertRuntimeDatabaseProfile(merchant,'merchant');assertRuntimeDatabaseProfile(worker,'operationWorker');
 assert.throws(()=>assertRuntimeDatabaseProfile(raw,'merchant'));assert.throws(()=>assertRuntimeDatabaseProfile(worker,'merchant'));
 assert.throws(()=>assertRuntimeDatabaseProfile(merchant,'operationWorker'));
});

test('merchant cannot claim commands, certify delivery or delete dispatch evidence',async()=>{
 for(const [table,column] of [['job_commands','lease_token'],['job_commands','status'],['outbox_events','dispatched_at'],['edit_operations','preview_id']]){
  const current=state();current.tables.push({oid:4,nspname:'mirror',relname:table,can_update:true,update_columns:[column]});
  await assert.rejects(()=>verifyRuntimeDatabase(client(current)),/cannot claim commands/);
 }
 for(const table of ['job_commands','outbox_events','edit_operations']){
  const current=state();current.tables.push({oid:4,nspname:'mirror',relname:table,can_delete:true});
  await assert.rejects(()=>verifyRuntimeDatabase(client(current)),/cannot delete/);
 }
 const current=state();current.tables.push({oid:4,nspname:'mirror',relname:'job_commands',can_update:true,update_columns:['cancel_requested_at','updated_at']});
 await verifyRuntimeDatabase(client(current));
});
