import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import useSyncProgress from '../hooks/useSyncProgress.js';

const compiled=await build({stdin:{contents:"export {SyncProgressNotice, default as SyncNotification} from './components/layout/SyncNotification.jsx'; export {SyncProgressProvider} from './hooks/SyncProgressContext.js'; export {default as ProductsSyncProgress} from './components/products/ProductsSyncProgress.jsx'; export {default as ProductsPage} from './pages/ProductsPage.jsx';",
  resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,format:'esm',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-router-dom']});
const entry=new URL(`./.sync-notice-${process.pid}.mjs`,import.meta.url);
await writeFile(entry,compiled.outputFiles[0].text);
let SyncProgressNotice,SyncNotification,SyncProgressProvider,ProductsSyncProgress,ProductsPage;
try{({SyncProgressNotice,SyncNotification,SyncProgressProvider,ProductsSyncProgress,ProductsPage}=await import(entry.href));}finally{await unlink(entry);}
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

test('product page and popup share one poller and render actual increasing product counts through completion',async t=>{
  calls=[];
  await act(async()=>root.render(React.createElement(SyncProgressProvider,null,
    React.createElement(ProductsSyncProgress),React.createElement(SyncNotification))));
  assert.equal(calls.length,1);
  await respond(0,{...job(),progress:{...job().progress,productsSaved:'100'}});
  assert.match(document.body.textContent,/100/);
  assert.match(document.body.textContent,/products saved to this sync/);
  assert.equal(document.querySelector('progress').value,50);
  await act(async()=>t.mock.timers.tick(3000));assert.equal(calls.length,2);
  await respond(1,{...job('RUNNING',55),progress:{...job('RUNNING',55).progress,productsSaved:'125'}});
  assert.match(document.body.textContent,/125/);assert.equal(document.querySelector('progress').value,55);
  await act(async()=>t.mock.timers.tick(3000));await respond(2,null,503);
  assert.match(document.body.textContent,/125/);assert.match(document.body.textContent,/last confirmed count/);
  assert.equal(document.querySelector('.products-sync__track--active'),null);
  await act(async()=>t.mock.timers.tick(6000));
  await respond(3,{...job('SUCCEEDED',100),progress:{...job('SUCCEEDED',100).progress,productsSaved:'130'}});
  assert.match(document.body.textContent,/130/);assert.match(document.body.textContent,/up to date/);
  assert.equal(document.querySelector('progress').value,100);
});

test('missing product counts never masquerade as exported record counts',async()=>{
  calls=[];await act(async()=>root.render(React.createElement(SyncProgressProvider,null,React.createElement(ProductsSyncProgress))));
  await respond(0,job());assert.match(document.body.textContent,/Waiting for a saved product count/);
  assert.doesNotMatch(document.body.textContent,/50 products/);
});

test('invalid product count responses preserve the last confirmed count',async t=>{
 await respond(0,{...job(),progress:{...job().progress,productsSaved:'125'}});
 await act(async()=>t.mock.timers.tick(3000));
 await respond(1,{...job(),progress:{...job().progress,productsSaved:'200 products'}});
 assert.equal(latest.error,true);assert.equal(latest.job.progress.productsSaved,'125');
});

test('revoked permission clears counts and stops polling rather than retaining a stale authorization',async t=>{
  await respond(0,{...job(),progress:{...job().progress,productsSaved:'123'}});
  await act(async()=>t.mock.timers.tick(3000));await respond(1,null,403);
  assert.equal(latest.job,null);assert.equal(latest.lastUpdatedAt,null);
  await act(async()=>t.mock.timers.tick(60000));assert.equal(calls.length,2);
});

test('publishing an observed sync refreshes the Products page immediately and only once',async t=>{
 calls=[];
 await act(async()=>root.render(React.createElement(SyncProgressProvider,null,React.createElement(MemoryRouter,null,React.createElement(ProductsPage)))));
 const catalogCalls=()=>calls.filter(c=>c.url.startsWith('/api/mirror/products'));
 const syncCalls=()=>calls.filter(c=>c.url==='/api/mirror/sync');
 assert.equal(catalogCalls().length,1);assert.equal(syncCalls().length,1);
 await act(async()=>catalogCalls()[0].resolve({ok:true,status:200,json:async()=>({snapshotId:null,publishedRevision:null,syncStatus:'PENDING',products:[],summary:{productCount:0,variantCount:0,activeCount:0},filteredCount:0,pageInfo:{hasNextPage:false,endCursor:null}})}));
 await act(async()=>syncCalls()[0].resolve({ok:true,json:async()=>({data:job()})}));
 await act(async()=>t.mock.timers.tick(3000));
 await act(async()=>syncCalls()[1].resolve({ok:true,json:async()=>({data:job('SUCCEEDED',100)})}));
 assert.equal(catalogCalls().length,2,'completion must not wait for the normal catalog poll');
 await act(async()=>t.mock.timers.tick(15000));
 await act(async()=>syncCalls()[2].resolve({ok:true,json:async()=>({data:job('SUCCEEDED',100)})}));
 assert.equal(catalogCalls().length,2,'repeated completed status must not trigger duplicate reloads');
});

test('50 committed preview products appear during sync with selection and editing locked until completion',async t=>{
 calls=[];
 await act(async()=>root.render(React.createElement(SyncProgressProvider,null,React.createElement(MemoryRouter,null,React.createElement(ProductsPage)))));
 const syncCalls=()=>calls.filter(c=>c.url==='/api/mirror/sync');
 const rows=Array.from({length:50},(_,i)=>({id:`gid://shopify/Product/${i+1}`,title:`Saved product ${i+1}`,status:'ACTIVE',vendor:'Synced vendor',productType:'Preview'}));
 const pending={...job(),generationId:'live-generation',editingAllowed:false,previewProducts:rows,progress:{...job().progress,productsSaved:'50'}};
 const reply=async(index,data)=>act(async()=>syncCalls()[index].resolve({ok:true,status:200,json:async()=>({data})}));
 await reply(0,pending);
 assert.equal(document.querySelectorAll('s-table-body s-table-row').length,50);
 assert.match(document.body.textContent,/Saved product 50/);
 assert.equal(document.querySelectorAll('s-table-body s-link').length,0,'staging rows cannot open the product editor');
 assert.ok([...document.querySelectorAll('s-table s-checkbox')].every(c=>c.hasAttribute('disabled')));
 assert.ok(document.querySelector('s-button[slot="primary-action"]').hasAttribute('disabled'));
 assert.match(document.body.textContent,/Editing is locked/);
 await act(async()=>t.mock.timers.tick(3000));
 await reply(1,{...pending,previewProducts:[{...rows[0],title:'Updated while syncing'},...rows.slice(1)],progress:{...pending.progress,productsSaved:'75'}});
 assert.match(document.body.textContent,/Updated while syncing/);assert.match(document.body.textContent,/75/);
 await act(async()=>t.mock.timers.tick(3000));
 await reply(2,{...pending,editingAllowed:true});
 assert.ok(document.querySelector('s-button[slot="primary-action"]').hasAttribute('disabled'),'a flag cannot unlock a running sync');
 await act(async()=>t.mock.timers.tick(3000));
 await reply(3,{...job('SUCCEEDED',100),generationId:'live-generation',editingAllowed:true,previewProducts:[]});
 assert.equal(document.querySelector('s-button[slot="primary-action"]').hasAttribute('disabled'),false);
});
