import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
const actualRuntime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...actualRuntime,assertRuntimeDatabaseProfile(){}}});
const {createOperationSupervisor}=await import('./operation-supervisor.server.js');
const {createOperationWorker}=await import('./operation.worker.js');
import {createHistoryRepository} from '../edit-history/history-repository.server.js';
import {createHistoryExecution} from '../edit-history/history-execution.server.js';
test('unconfigured operation supervisor does not poll or start a writer',async()=>{
 let queries=0;const supervisor=createOperationSupervisor({database:{async query(){queries++;}}});
 supervisor.start();await supervisor.stop();assert.equal(queries,0);
});
test('operation supervisor rejects an unissued worker adapter',()=>{
 assert.throws(()=>createOperationSupervisor({worker:{async processOne(){}}}),/Issued journaled operation worker/);
});
test('supervisor isolates maintenance failures and waits for the current claim transaction on shutdown',async()=>{
 let release,scanning;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{scanning=resolve;});
 const errors=[];
 const database={async query(sql){
  if(sql.includes('WITH interrupted AS')||sql.includes('INSERT INTO mirror.operation_finalizations'))throw Error('Maintenance unavailable');
  if(sql.includes('FOR UPDATE OF c SKIP LOCKED')){scanning();await gate;}return{rows:[],rowCount:0};},
  async connect(){return{query:database.query,release(){}};}};
 const historyRepository=createHistoryRepository({database,resolveTenant:async()=>null,loadExecutionPlan:async()=>null,
  authorizePlan:async()=>false,verifyObservation:async()=>false,authorizeDispatch:async()=>false,loadMutationEvidence:async()=>null,
  verifyMutationEvidence:async()=>false,authorizeRecovery:async()=>false});
 const historyExecution=createHistoryExecution({historyRepository,loadExecutionRequest:async()=>null,persistEvidence:async()=>null});
 const worker=createOperationWorker({database,historyExecution,shopifyClientFactory:async()=>null,
  approvalService:{async getApprovedContract(){return null;}},authorizeWrite:async()=>false});
 const supervisor=createOperationSupervisor({database,worker,intervalMs:60000,logger:{error(data){errors.push(data);}}});supervisor.start();await started;
 assert.deepEqual(errors.map(error=>error.phase),['discoverRecoveries','reconcileFinalizations']);
 let stopped=false;const stopping=supervisor.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
 release();await stopping;assert.equal(stopped,true);
});
