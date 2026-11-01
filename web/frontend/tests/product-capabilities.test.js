import {FIELD_CAPABILITY_CONTRACT_VERSION,FIELD_CAPABILITY_VERSIONS} from '../../fields/capabilities.js';
import {WRITE_CAPABILITY_VERSION} from '../../fields/write-capabilities.js';
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import useProductCapabilities from '../hooks/useProductCapabilities.js';
import {validateProductCapabilities} from '../services/product-capabilities.js';
let dom,root,calls,latest;const original=globalThis.fetch;
function Harness({revision='r1'}){latest=useProductCapabilities('generation',revision,null);return null;}
beforeEach(async()=>{
  dom=new JSDOM('<div id="root"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  calls=[];globalThis.fetch=(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}));root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(Harness)));
});
afterEach(async()=>{await act(async()=>root.unmount());globalThis.fetch=original;dom.window.close();});
const fields=[{id:'product.tags',type:'string_list',operators:['list_contains']}];
const respond=(index,payload,ok=true)=>act(async()=>calls[index].resolve({ok,json:async()=>({...FIELD_CAPABILITY_VERSIONS,...payload})}));
test('filter choices fail closed until the authenticated response matches the current publication',async()=>{
  assert.deepEqual(latest,[]);assert.equal(calls[0].url,'/api/catalog/capabilities');
  await respond(0,{snapshotId:'generation',publishedRevision:'r1',fields});assert.deepEqual(latest,fields);
  await act(async()=>root.render(React.createElement(Harness,{revision:'r2'})));assert.equal(calls[0].options.signal.aborted,true);assert.deepEqual(latest,[]);
  await respond(1,{snapshotId:'generation',publishedRevision:'r1',fields});assert.deepEqual(latest,[]);
});
test('revocation and malformed capability operators never enable filter choices',async()=>{
  await respond(0,{},false);assert.deepEqual(latest,[]);
  await act(async()=>root.render(React.createElement(Harness,{revision:'r2'})));
  await respond(1,{snapshotId:'generation',publishedRevision:'r2',fields:[{id:'product.tags',operators:'all'}]});assert.deepEqual(latest,[]);
});
test('capability versions, canonical types and enum definitions cannot drift silently',()=>{
 const valid={...FIELD_CAPABILITY_VERSIONS,capabilityContractVersion:FIELD_CAPABILITY_CONTRACT_VERSION,writeCapabilityVersion:WRITE_CAPABILITY_VERSION,snapshotId:'generation',publishedRevision:'r1',fields};
 assert.deepEqual(validateProductCapabilities(valid,'generation','r1'),fields);
 for(const patch of [{capabilityContractVersion:99},{writeCapabilityVersion:'old'},{fields:[{id:'product.tags',type:'integer',operators:['gt']}]},{fields:[{id:'product.status',type:'enum',operators:['eq'],enumValues:['INVENTED']}]}])assert.throws(()=>validateProductCapabilities({...valid,...patch},'generation','r1'));
});
