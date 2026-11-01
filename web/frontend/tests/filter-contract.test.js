import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {filterOperand,filterOperators} from '../data/products.filters.js';
import {listOperatorsForType} from '../../fields/operators.js';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
test('UI presence operators exactly follow backend compatibility',()=>{
 for(const type of ['string','string_list','id_list','integer','datetime','boolean'])assert.deepEqual(filterOperators[type].map(([id])=>id),listOperatorsForType(type).map(op=>op.id));
 for(const type of ['text','list'])for(const op of ['is_empty','is_not_empty'])assert.equal(filterOperand(type,op,''),undefined);
});
test('strict calendar dates retain date-only form and timestamps require a zone',()=>{
 assert.equal(filterOperand('date','eq','2024-02-29'),'2024-02-29');
 assert.equal(filterOperand('datetime','eq','2026-10-31T12:30:00+05:30'),'2026-10-31T07:00:00.000Z');
 for(const value of ['2026-02-29','2026-04-31','10/31/2026','2026-10-31T00:00:00Z'])assert.throws(()=>filterOperand('date','eq',value));
 for(const value of ['2026-10-31','2026-10-31T12:00:00','2026-02-30T12:00:00Z','2026-10-31T24:00:00Z','2026-10-31T12:00:00+14:01'])assert.throws(()=>filterOperand('datetime','eq',value));
});
test('between rejects malformed and reversed exact ranges and operators match canonical types',()=>{
 assert.deepEqual(filterOperand('integer','between','2,10'),[2,10]);assert.deepEqual(filterOperand('integer','between','-10,-2'),[-10,-2]);
 for(const value of ['10,2','9007199254740993,9007199254740992','NaN,2','Infinity,3','1e3,2','1,','1,2,3'])assert.throws(()=>filterOperand('integer','between',value));
 assert.throws(()=>filterOperand('decimal','between','9007199254740993.000000000000000001,9007199254740993.000000000000000000'));
 for(const [type,op] of [['boolean','between'],['datetime','contains'],['money','is_empty'],['id','gt']])assert.throws(()=>filterOperand(type,op,'1,2'));
});
test('the browser contract executes without Node Buffer or a Node crypto shim',async()=>{
 const result=await build({stdin:{contents:"import {filterOperand,getFieldType} from './data/products.filters.js';window.fieldCheck={filterOperand,getFieldType};",resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'field-browser-test.js'},bundle:true,platform:'browser',format:'iife',write:false});
 const dom=new JSDOM('',{runScripts:'outside-only'});dom.window.TextEncoder=TextEncoder;dom.window.Buffer=undefined;
 try{dom.window.eval(result.outputFiles[0].text);assert.equal(dom.window.fieldCheck.getFieldType('product.createdAt'),'datetime');assert.equal(JSON.stringify(dom.window.fieldCheck.filterOperand('integer','between','2,10')),'[2,10]');assert.equal(dom.window.fieldCheck.filterOperand('date','eq','2024-02-29'),'2024-02-29');}
 finally{dom.window.close();}
});
