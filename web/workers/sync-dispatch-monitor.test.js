import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createSyncDispatchMonitor} from './sync-dispatch-monitor.server.js';

const quiet={info(){},error(){}};
function fixture(options={}) {
  let scans=0;
  const repository={async listExhaustedDispatches(){scans++;return [{dispatchId:'one'}];},
    async markDispatchReviewRequired(){return {kind:'RECORDED'};},async getDispatchMetrics(){return {states:{REVIEW_REQUIRED:'1'},exhausted:'0'};}};
  return {monitor:createSyncDispatchMonitor({repository,logger:quiet,intervalMs:100,...options}),scans:()=>scans,repository};
}
test('monitor requires bounded settings and the full DB-only repository contract',()=>{
  assert.throws(()=>createSyncDispatchMonitor(),/listExhaustedDispatches/);
  assert.throws(()=>fixture({intervalMs:0}),RangeError);
  const f=fixture();for(const method of Object.keys(f.repository))assert.throws(()=>fixture({repository:{...f.repository,[method]:null}}));
});
test('monitor schedules exhaustion checks, publishes state counts, and stops its timer',async()=>{
  const f=fixture();f.monitor.start();f.monitor.start();
  await delay(140);await f.monitor.stop();assert.ok(f.scans()>=2);
  assert.equal(f.monitor.getMetrics().reviewed,1);assert.equal(f.monitor.getMetrics().exhausted,'0');
  const before=f.scans();await delay(130);assert.equal(f.scans(),before);
});
test('monitor refuses overlapping cycles, drains on shutdown and isolates logger failures',async()=>{
  const pending=Promise.withResolvers(),started=Promise.withResolvers();let scans=0;
  const f=fixture({repository:{async listExhaustedDispatches(){scans++;started.resolve();return pending.promise;},
    async markDispatchReviewRequired(){return {kind:'RECORDED'};},async getDispatchMetrics(){return {states:{},exhausted:'0'};}},
    logger:{info(){throw new Error('logger');},error(){return Promise.reject(new Error('logger'));}}});
  const run=f.monitor.runOnce();await started.promise;
  assert.equal((await f.monitor.runOnce()).kind,'ALREADY_RUNNING');const stop=f.monitor.stop();
  pending.resolve([]);await run;await stop;assert.equal(scans,1);
});
