import { createHmac,timingSafeEqual } from 'node:crypto';
import { canonicalHistoryJson,normalizeHistoryPageSize,HistoryContractError,HISTORY_ERROR_CODES as C } from './history-contract.js';
import { createHistoryHookInvoker } from './transaction-hooks.server.js';
const fail=(code,message)=>{throw new HistoryContractError(code,message);};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const time=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)&&Number.isFinite(Date.parse(value));
function input(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(C.INVALID_INPUT,'Plain history page request required');for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))fail(C.INVALID_INPUT,'Unsupported history page property');}return value;}
export function createHistoryPages({database,executionAdapter,resolveTenant,authorizeHistoryRead,historyCursorSecret,operationRecord}){
 const key=typeof historyCursorSecret==='string'||Buffer.isBuffer(historyCursorSecret)?Buffer.from(historyCursorSecret):null;
 function encode(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return body+'.'+createHmac('sha256',key).update('history-page-v1:'+body).digest('base64url');}
 function decode(cursor,context){
  if(typeof cursor!=='string'||cursor.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))fail(C.INVALID_INPUT,'Invalid history cursor');
  const [body,signature]=cursor.split('.'),provided=Buffer.from(signature,'base64url'),expected=createHmac('sha256',key).update('history-page-v1:'+body).digest();
  if(provided.length!==expected.length||!timingSafeEqual(provided,expected))fail(C.INVALID_INPUT,'Invalid history cursor signature');
  let payload;try{payload=canonicalHistoryJson(JSON.parse(Buffer.from(body,'base64url').toString('utf8')));}catch{fail(C.INVALID_INPUT,'Invalid history cursor payload');}
  if(payload.version!==1||payload.shopId!==context.shopId||payload.installationId!==context.installationId||payload.action!==context.action||payload.operationId!==context.operationId||!time(payload.asOf)||!time(payload.lastTime)||!uuid(payload.lastId))fail(C.UNAUTHORIZED,'Cursor is not valid for this tenant and read operation');
  return payload;
 }
 async function page(raw,action){
  input(raw,['authContext','operationId','limit','cursor']);
  if(!raw.authContext||typeof authorizeHistoryRead!=='function')fail(C.UNAUTHORIZED,'Independent history read authorization required');
  if(!key||key.length<32)fail(C.UNAUTHORIZED,'A private cursor signing key of at least 32 bytes is required');
  if(action==='list_changes'&&!uuid(raw.operationId))fail(C.INVALID_INPUT,'History operation UUID required');
  if(action==='list_operations'&&raw.operationId!==undefined)fail(C.INVALID_INPUT,'Operation overrides are not supported for operation pages');
  const limit=normalizeHistoryPageSize(raw.limit),authContext=raw.authContext,operationId=raw.operationId??null;
  const tx=await database.connect(),invoke=createHistoryHookInvoker(tx);
  try{
   await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await tx.query("SET LOCAL lock_timeout='2000ms'");await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
   await executionAdapter.beginScope({client:tx,write:false});const tenant=canonicalHistoryJson(await invoke(resolveTenant,{authContext}));await executionAdapter.assertTenant({client:tx,tenant});
   const context={shopId:tenant.shopId,installationId:tenant.installationId,action,operationId};
   const cursor=raw.cursor==null?null:decode(raw.cursor,context);
   let operation=null;
   if(operationId){const row=(await tx.query(`SELECT * FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[tenant.shopId,tenant.installationId,operationId])).rows[0];if(!row||row.purge_requested_at!=null){await tx.query('COMMIT');return Object.freeze({items:Object.freeze([]),nextCursor:null});}operation=operationRecord(row);}
   const request=Object.freeze({...(operationId?{operationId}:{}),limit});
   const authorize=()=>invoke(authorizeHistoryRead,{authContext,tenant,operation:action,operationRecord:operation,request});
   if(await authorize()!==true)fail(C.UNAUTHORIZED,'History page read is not authorized');
   const asOf=cursor?.asOf??(await tx.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`)).rows[0].instant;
   const table=action==='list_operations'?'operations':'changes',column=action==='list_operations'?'created_at':'prepared_at';
   const params=[tenant.shopId,tenant.installationId,asOf,cursor?.lastTime??null,cursor?.lastId??null,limit+1];
   if(operationId)params.push(operationId);
   const rows=(await tx.query(`SELECT *,to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_time
    FROM edit_history.${table} WHERE shop_id=$1 AND installation_id=$2 ${action==='list_operations'?'AND purge_requested_at IS NULL':''} AND ${column}<=$3::timestamptz
    AND ($4::timestamptz IS NULL OR (${column},id)<($4::timestamptz,$5::uuid)) ${operationId?'AND operation_id=$7':''}
    ORDER BY ${column} DESC,id DESC LIMIT $6`,params)).rows;
   const visible=rows.slice(0,limit),items=visible.map(row=>action==='list_operations'?operationRecord(row):canonicalHistoryJson({changeId:row.id,fieldId:row.field_id,resourceGid:row.resource_gid,
    executionItemId:row.execution_item_id,mutationId:row.mutation_id,attemptId:row.attempt_id,attemptNumber:row.attempt_number,state:row.mutation_state,verificationState:row.verification_state,preparedAt:row.page_time}));
   if(await authorize()!==true)fail(C.UNAUTHORIZED,'History page permission changed');
   const current=canonicalHistoryJson(await invoke(resolveTenant,{authContext}));if(current.shopId!==tenant.shopId||current.installationId!==tenant.installationId)fail(C.UNAUTHORIZED,'History page tenant changed');
   const last=visible.at(-1),nextCursor=rows.length>limit?encode({...context,version:1,asOf,lastTime:last.page_time,lastId:last.id}):null;
   await tx.query('COMMIT');return Object.freeze({items:Object.freeze(items),nextCursor});
  }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
 }
 return Object.freeze({listOperations:raw=>page(raw,'list_operations'),listChanges:raw=>page(raw,'list_changes')});
}
