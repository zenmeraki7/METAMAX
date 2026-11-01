import test from 'node:test';
import assert from 'node:assert/strict';
import {CANONICAL_FIELDS} from './canonical.js';
import {getFieldCapability} from './capabilities.js';
import {listFieldWriteOperations,listStructuralFieldWriteOperations,getFieldPolicy} from './constraints.js';
import {INSTALLED_WRITE_CAPABILITIES} from './write-capabilities.js';
import {normalizeOperatorOperand} from './normalize.js';
test('every advertised write operation is in both structural policy and the installed adapter',()=>{
 for(const field of Object.values(CANONICAL_FIELDS)){
  const effective=listFieldWriteOperations(field.id),installed=INSTALLED_WRITE_CAPABILITIES.fields[field.id]?.operations??[];
  assert.deepEqual(effective,listStructuralFieldWriteOperations(field.id).filter(op=>installed.includes(op)));
  assert.deepEqual(getFieldPolicy(field.id,'write').operations,effective);assert.deepEqual(getFieldCapability(field.id).installedWriteOperations,effective);
 }
 assert.deepEqual(listFieldWriteOperations('variant.price'),['set']);assert.ok(listStructuralFieldWriteOperations('variant.price').includes('increase'));
});
test('integer between accepts canonical numbers, orders negatives and rejects malformed operands',()=>{
 const field={id:'variant.inventoryQuantity',type:'integer',nullable:false};
 for(const pair of [[2,10],[-10,-2],[Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER]]){
  assert.deepEqual(normalizeOperatorOperand(field,'between',pair),pair);
  assert.throws(()=>normalizeOperatorOperand(field,'between',[...pair].reverse()));
 }
 for(const pair of [[],[1],[1,2,3],['','2'],['NaN','2'],[1,null],[1,Number.MAX_SAFE_INTEGER+1],new Array(2)])assert.throws(()=>normalizeOperatorOperand(field,'between',pair));
 const accessor=['1','2'];Object.defineProperty(accessor,'0',{get(){assert.fail('Operand accessor executed');}});assert.throws(()=>normalizeOperatorOperand(field,'between',accessor));
});
