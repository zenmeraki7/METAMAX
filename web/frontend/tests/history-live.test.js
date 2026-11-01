import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';

const compiled=await build({stdin:{contents:"export {default as useHistoryOperations,normalizeHistoryResponse} from './hooks/useHistoryOperations.js';export {default as HistoryStats} from './components/history/HistoryStats.jsx';export {default as HistoryRow} from './components/history/HistoryRow.jsx';",resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'jsx'},bundle:true,write:false,platform:'node',format:'esm',external:['react'],define:{'import.meta.env.VITE_HISTORY_DEMO_MODE':'"false"'},jsx:'automatic'});
const entry=new URL(`.history-test-${process.pid}.mjs`,import.meta.url);await writeFile(entry,compiled.outputFiles[0].text);
let useHistoryOperations,HistoryStats,HistoryRow,normalizeHistoryResponse;
try{({useHistoryOperations,HistoryStats,HistoryRow,normalizeHistoryResponse}=await import(entry.href));}finally{await unlink(entry);}
const originalFetch=globalThis.fetch;let root,dom,calls,latest;
function Harness({demoMode=false}){latest=useHistoryOperations({demoMode});return React.createElement(HistoryStats,{operations:latest.operations});}
beforeEach(async()=>{
  dom=new JSDOM('<div id="root"></div>',{url:'https://app.example.test'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  calls=[];globalThis.fetch=(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}));
  root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Harness)));
});
afterEach(async()=>{await act(async()=>root.unmount());globalThis.fetch=originalFetch;dom.window.close();});
const row={id:'real-operation',title:'Actual edit',type:'Bulk Edit',status:'Completed',processedCount:7,totalCount:7,startedAt:'2026-10-31T00:00:00Z'};
const respond=(index,data,ok=true)=>act(async()=>calls[index].resolve({ok,json:async()=>({pageInfo:{hasNextPage:false,endCursor:null},...data})}));
test('live records drive statistics and the progress fields used by CSV export',async()=>{
  assert.deepEqual(latest.operations,[]);assert.equal(latest.loading,true);
  await respond(0,{operations:[row]});assert.equal(latest.isLive,true);assert.equal(latest.error,null);
  assert.equal(latest.operations.length,1);assert.equal(latest.operations[0].processed,7);assert.equal(latest.operations[0].total,7);
  assert.equal(document.querySelector('.mh-stat s-text[type="strong"]').textContent,'1');
  assert.doesNotMatch(document.body.textContent,/12%/);
});
test('an empty live response stays empty; failed requests expose an error without sample records',async()=>{
  await respond(0,{operations:[]});assert.equal(latest.isLive,true);assert.equal(latest.operations.length,0);assert.equal(latest.error,null);
  await act(async()=>{void latest.refetch();});await respond(1,{},false);
  assert.equal(latest.isLive,false);assert.ok(latest.error);assert.equal(latest.operations.length,0);
});
test('reload and unmount abort stale requests, while demo data requires explicit mode',async()=>{
  const first=calls[0];await act(async()=>{void latest.refetch();});assert.equal(first.options.signal.aborted,true);
  await respond(1,{operations:[row]});await respond(0,{operations:[]});assert.equal(latest.operations.length,1);
  await act(async()=>root.render(React.createElement(Harness,{demoMode:true})));assert.equal(latest.isDemo,true);assert.ok(latest.operations.length>0);assert.equal(calls.length,2);
  await act(async()=>root.render(React.createElement(Harness)));const signal=calls.at(-1).options.signal;
  await act(async()=>root.render(null));assert.equal(signal.aborted,true);
});
test('malformed history responses fail closed and running backend status normalizes consistently',()=>{
  assert.throws(()=>normalizeHistoryResponse({operations:[{...row,processedCount:-1}]}));
  assert.equal(normalizeHistoryResponse({operations:[{...row,status:'In Progress'}]})[0].status,'Running');
});
test('signed server continuation appends older records, avoids overlapping loads and reports the complete loaded scope',async()=>{
  await respond(0,{operations:[row],pageInfo:{hasNextPage:true,endCursor:'signed:first'}});
  await act(async()=>{void latest.loadMore();void latest.loadMore();});
  assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/history?cursor=signed%3Afirst');
  await respond(1,{operations:[{...row,id:'older-operation'}],pageInfo:{hasNextPage:false,endCursor:null}});
  assert.equal(latest.hasNextPage,false);assert.deepEqual(latest.operations.map(row=>row.id),['real-operation','older-operation']);
  assert.equal(document.querySelector('.mh-stat s-text[type="strong"]').textContent,'2');
});
test('failed or looping continuation preserves loaded records and can retry the same cursor',async()=>{
  await respond(0,{operations:[row],pageInfo:{hasNextPage:true,endCursor:'signed:first'}});
  await act(async()=>{void latest.loadMore();});await respond(1,{},false);
  assert.equal(latest.operations.length,1);assert.ok(latest.error);
  await act(async()=>{void latest.loadMore();});assert.equal(calls[2].url,calls[1].url);
  await respond(2,{operations:[{...row,id:'older'}],pageInfo:{hasNextPage:true,endCursor:'signed:first'}});
  assert.match(latest.error,/pagination/);assert.equal(latest.operations.length,1);
});

test('partial and unknown history states stay distinct and show actual outcome counts',async()=>{
 await respond(0,{operations:[{...row,type:'Import',status:'Partial',processedCount:7,failedCount:2,uncertainCount:1,totalCount:10},
  {...row,id:'unknown',status:'Unknown',failedCount:0}]});
 assert.equal(latest.operations[0].status,'Partial');assert.equal(latest.operations[0].failedCount,2);
 assert.equal(latest.operations[1].status,'Unknown');
 const partial=latest.operations[0];
 const cards=[...document.querySelectorAll('.mh-stat')];
 assert.match(cards.find(card=>card.textContent.includes('Partially completed')).textContent,/1/);
 assert.match(cards.find(card=>card.textContent.includes('Failed / Expired')).textContent,/0/);
 assert.throws(()=>normalizeHistoryResponse({operations:[{...row,failedCount:8}]}));
 assert.throws(()=>normalizeHistoryResponse({operations:[{...row,processedCount:8}]}));
 await act(async()=>root.render(React.createElement(HistoryRow,{item:partial,checkboxId:'partial-row'})));
 assert.equal(document.querySelector('s-badge').textContent,'Partial');
 assert.match(document.body.textContent,/7 verified \u00b7 2 failed \u00b7 10 total/);
 assert.match(document.body.textContent,/1 uncertain/);
});

test('field-level history counts are labeled without being confused with resource outcomes',async()=>{
 await respond(0,{operations:[{...row,type:'Edit',status:'Partial',countUnit:'fields',processedCount:9,failedCount:1,uncertainCount:0,totalCount:10}]});
 const partial=latest.operations[0];await act(async()=>root.render(React.createElement(HistoryRow,{item:partial,checkboxId:'field-count-row'})));
 assert.match(document.body.textContent,/9 verified fields/);assert.match(document.body.textContent,/1 failed fields/);assert.match(document.body.textContent,/10 recorded fields/);
 assert.equal(document.querySelector('s-badge').textContent,'Partial');
});
