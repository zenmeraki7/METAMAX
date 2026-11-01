import test from 'node:test';
import assert from 'node:assert/strict';
import {startExecutionHeartbeat} from './execution-heartbeat.server.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('execution heartbeat serializes renewals and stopping drains the in-flight renewal',async()=>{
 let release,entered,calls=0;const started=new Promise(resolve=>entered=resolve);
 const heartbeat=startExecutionHeartbeat({intervalMs:1,timeoutMs:500,leaseMs:2000,renew:()=>{calls++;entered();return new Promise(resolve=>release=resolve);}});
 await started;await delay(20);assert.equal(calls,1);
 let stopped=false;const stopping=heartbeat.stop().then(()=>stopped=true);
 await delay(5);assert.equal(stopped,false);release(true);await stopping;
 await delay(5);assert.equal(calls,1);assert.equal(heartbeat.signal.aborted,false);
});
test('a delayed timer cannot authorize work after the local lease deadline',async()=>{
 const heartbeat=startExecutionHeartbeat({intervalMs:1000,timeoutMs:100,leaseMs:1,renew:async()=>true});
 await delay(5);assert.throws(()=>heartbeat.assertOwned(),{code:'HISTORY_OWNERSHIP_LOST'});
 assert.equal(heartbeat.signal.aborted,true);await assert.rejects(()=>heartbeat.stop());
});
