import test from 'node:test';
import assert from 'node:assert/strict';
import {lockPublication} from './publication-lock.server.js';

test('publication helper fails before any advisory lock if the transaction-only table fence fails',async()=>{
 const statements=[];
 const client={async query(sql){statements.push(sql);if(sql.startsWith('LOCK TABLE'))throw Object.assign(Error('No transaction'),{code:'25P01'});}};
 await assert.rejects(()=>lockPublication(client,'fence.myshopify.com'),{code:'25P01'});
 assert.equal(statements.length,1);assert.match(statements[0],/^LOCK TABLE/);
});
