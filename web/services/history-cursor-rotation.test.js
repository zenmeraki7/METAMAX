import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryPages} from '../edit-history/history-pages.server.js';
function pages(secret){
 const calls=[],instant='2026-11-01T00:00:00.000000Z';
 const query=async sql=>{calls.push(sql);
  if(sql.startsWith('SELECT to_char(clock_timestamp'))return {rows:[{instant}]};
  if(sql.includes('FROM edit_history.operations'))return {rows:[1,2].map(n=>({id:`00000000-0000-4000-8000-00000000000${n}`,page_time:instant}))};
  return {rows:[]};};
 const service=createHistoryPages({historyCursorSecret:secret,database:{connect:async()=>({query,release(){}})},
  executionAdapter:{async beginScope(){},async assertTenant(){}},resolveTenant:async()=>({shopId:'cursor.myshopify.com',installationId:'installed'}),
  authorizeHistoryRead:async()=>true,operationRecord:row=>({operationId:row.id})});
 return {service,calls};
}
test('history signing-key rotation invalidates old cursors and restarting pagination uses the new key',async()=>{
 const old=pages('old-history-cursor-key-with-at-least-32-bytes'),current=pages('new-history-cursor-key-with-at-least-32-bytes');
 const input={authContext:{},limit:1};const first=await old.service.listOperations(input);assert.ok(first.nextCursor);
 assert.ok((await old.service.listOperations({...input,cursor:first.nextCursor})).nextCursor);
 await assert.rejects(current.service.listOperations({...input,cursor:first.nextCursor}),{code:'HISTORY_INVALID_INPUT'});
 assert.equal(current.calls.at(-1),'ROLLBACK');
 const restarted=await current.service.listOperations(input);assert.ok(restarted.nextCursor);assert.notEqual(restarted.nextCursor,first.nextCursor);
 await assert.rejects(old.service.listOperations({...input,cursor:restarted.nextCursor}),{code:'HISTORY_INVALID_INPUT'});
});
