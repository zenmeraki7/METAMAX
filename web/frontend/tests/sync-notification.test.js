import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import useSyncProgress from '../hooks/useSyncProgress.js';

const compiled=await build({stdin:{contents:"export {SyncProgressNotice} from './components/layout/SyncNotification.jsx';",
  resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,format:'esm',jsx:'automatic',external:['react','react/jsx-runtime']});
const entry=new URL(`./.sync-notice-${process.pid}.mjs`,import.meta.url);
await writeFile(entry,compiled.outputFiles[0].text);
let SyncProgressNotice;
try{({SyncProgressNotice}=await import(entry.href));}finally{await unlink(entry);}
const originalFetch=globalThis.fetch;
let dom,root,calls,latest,visibility;
const job=(status='RUNNING',percent=50,id='run-one')=>({id,status,phase:'INGESTING',progress:{percent,estimated:percent!==100,stage:status==='SUCCEEDED'?'Your catalog mirror is ready':'Saving products and variants',processedLines:'50',expectedLines:'100'}});
function Harness(){latest=useSyncProgress();return null;}
beforeEach(async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  dom=new JSDOM('<div id="root"></div>',{url:'https://app.example.test',pretendToBeVisual:true});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  visibility='visible';Object.defineProperty(document,'visibilityState',{get:()=>visibility,configurable:true});
  calls=[];globalThis.fetch=(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}));
  root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(Harness)));
});
afterEach(async()=>{await act(async()=>root.unmount());globalThis.fetch=originalFetch;dom.window.close();});
const respond=async(index,data,status=200)=>act(async()=>calls[index].resolve({ok:status===200,status,json:async()=>({data})}));

test('polling discovers sync globally, never overlaps requests and aborts on unmount',async t=>{
  assert.equal(calls[0].url,'/api/mirror/sync');assert.equal(calls[0].options.cache,'no-store');
  await act(async()=>t.mock.timers.tick(5000));assert.equal(calls.length,1);
  await respond(0,job());
  await act(async()=>t.mock.timers.tick(3000));assert.equal(calls.length,2);
  await act(async()=>t.mock.timers.tick(5000));assert.equal(calls.length,2);
  const signal=calls[1].options.signal;
  await act(async()=>root.render(null));assert.equal(signal.aborted,true);
});
test('failed polling preserves progress and backs off; visibility resumes discovery',async t=>{
  await respond(0,job());await act(async()=>t.mock.timers.tick(3000));
  await respond(1,null,503);assert.equal(latest.job.progress.percent,50);assert.equal(latest.error,true);
  await act(async()=>t.mock.timers.tick(3000));assert.equal(calls.length,2);
  await act(async()=>t.mock.timers.tick(3000));assert.equal(calls.length,3);
  visibility='hidden';document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await respond(2,job());await act(async()=>t.mock.timers.tick(30000));assert.equal(calls.length,3);
  visibility='visible';await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));
  assert.equal(calls.length,4);
});
test('idle and completed runs use slower discovery; malformed percentages are rejected',async t=>{
  await respond(0,null);await act(async()=>t.mock.timers.tick(3000));assert.equal(calls.length,1);
  await act(async()=>t.mock.timers.tick(12000));assert.equal(calls.length,2);
  await respond(1,job('SUCCEEDED',100));assert.equal(latest.job.progress.percent,100);
  await act(async()=>t.mock.timers.tick(15000));await respond(2,job('RUNNING',150));
  assert.equal(latest.error,true);assert.equal(latest.job.progress.percent,100);
});
test('popup announces progress, collapses, completes and can be dismissed without hiding a new run',async()=>{
  const render=(value,error=false)=>act(async()=>root.render(React.createElement(SyncProgressNotice,{job:value,error})));
  await render(job());assert.match(document.body.textContent,/Syncing in progress/);
  assert.equal(document.querySelector('progress').value,50);assert.ok(document.querySelector('[role="status"]'));
  await act(async()=>document.querySelector('.sync-notification__header').click());assert.equal(document.querySelector('progress'),null);
  await act(async()=>document.querySelector('.sync-notification__header').click());
  await render(job(),true);assert.match(document.body.textContent,/Retrying/);
  await render(job('SUCCEEDED',100));assert.match(document.body.textContent,/Sync complete/);
  await act(async()=>document.querySelector('.sync-notification__dismiss').click());assert.equal(document.querySelector('aside'),null);
  await render(job('RUNNING',5,'run-two'));assert.ok(document.querySelector('aside'));
});
test('old completed runs do not reappear on page load; review is clearly flagged',async()=>{
  await act(async()=>root.render(React.createElement(SyncProgressNotice,{job:job('SUCCEEDED',100)})));
  assert.equal(document.querySelector('aside'),null);
  await act(async()=>root.render(React.createElement(SyncProgressNotice,{job:{...job(),reviewRequired:true}})));
  assert.match(document.body.textContent,/Sync needs attention/);
});
