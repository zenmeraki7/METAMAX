import test from 'node:test';
import assert from 'node:assert/strict';
import {detectUndoConflicts} from '../undo-conflict-detector.server.js';
const snapshot=value=>({valueKind:'VALUE',value,fingerprint:`sha256:${'a'.repeat(64)}`});
const fields=[{resourceGid:'p1',fieldId:'product.title',before:snapshot('Original'),after:snapshot('Edited')},
 {resourceGid:'p1',fieldId:'product.vendor',before:snapshot('Old'),after:snapshot('New')},
 {resourceGid:'p2',fieldId:'product.title',before:snapshot('Original 2'),after:snapshot('Edited 2')}];
const current=()=>fields.map(f=>({resourceGid:f.resourceGid,fieldId:f.fieldId,...f.after}));
test('undo restores verified before values only when every expected after value still matches',()=>{
 const result=detectUndoConflicts({fields,observations:current()});assert.equal(result.inverse.length,3);
 assert.equal(result.inverse[0].value,'Original');assert.equal(result.conflicts.length,0);
});
test('abort policy does not generate any inverse after an intervening edit',()=>{
 const observations=current();observations[0].value='Merchant edit';
 const result=detectUndoConflicts({fields,observations});assert.equal(result.inverse.length,0);assert.deepEqual(result.conflicts,['p1']);
});
test('skip policy excludes all fields of a conflicted resource',()=>{
 const observations=current();observations[0].value='Merchant edit';
 const result=detectUndoConflicts({fields,observations,conflictPolicy:'SKIP_CONFLICTED'});
 assert.equal(result.inverse.length,1);assert.equal(result.inverse[0].resourceGid,'p2');
});
test('undo comparisons preserve NULL and ABSENT distinctions',()=>{
 const one=[{...fields[0],after:snapshot(null)}];
 assert.equal(detectUndoConflicts({fields:one,observations:[{resourceGid:'p1',fieldId:'product.title',valueKind:'ABSENT'}]}).inverse.length,0);
});
test('undo rejects missing, duplicate and mismatched resource/field observations',()=>{
 assert.throws(()=>detectUndoConflicts({fields,observations:current().slice(1)}));
 const observations=current();observations[0]={...observations[1]};assert.throws(()=>detectUndoConflicts({fields,observations}));
 observations[0]={...observations[0],resourceGid:'foreign'};assert.throws(()=>detectUndoConflicts({fields,observations}));
});

test('two variants sharing variant.price retain separate observations and inverse values',()=>{
 const variants=[{resourceGid:'gid://shopify/ProductVariant/1',fieldId:'variant.price',before:snapshot('10'),after:snapshot('20')},
  {resourceGid:'gid://shopify/ProductVariant/2',fieldId:'variant.price',before:snapshot('30'),after:snapshot('40')}];
 const observations=variants.map(f=>({resourceGid:f.resourceGid,fieldId:f.fieldId,...f.after})).reverse();
 const inverse=detectUndoConflicts({fields:variants,observations}).inverse;
 assert.deepEqual(inverse.map(f=>[f.resourceGid,f.value]),[['gid://shopify/ProductVariant/1','10'],['gid://shopify/ProductVariant/2','30']]);
 observations[0].value='Merchant change';
 const skipped=detectUndoConflicts({fields:variants,observations,conflictPolicy:'SKIP_CONFLICTED'});
 assert.deepEqual(skipped.inverse.map(f=>f.resourceGid),['gid://shopify/ProductVariant/1']);
});
