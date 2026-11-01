/** Exact-result checks; accepted cancellation is not terminal cleanup. */
const terminal=new Set(['CANCELLED','COMPLETED','FAILED','EXPIRED']);
const statuses=new Set([...terminal,'CREATED','RUNNING','CANCELING']);
export function boundBulkStatus(response,id,{cancellation=false}={}){
 const fail=()=>{throw Object.assign(Error('Exact remote bulk operation result required'),{code:'REMOTE_CANCEL_OUTCOME_UNKNOWN'});};
 if(!response||response.errors!=null&&(!Array.isArray(response.errors)||response.errors.length))fail();
 const payload=cancellation?response.data?.bulkOperationCancel:null;
 if(cancellation&&(!payload||!Array.isArray(payload.userErrors)||payload.userErrors.length))fail();
 const op=cancellation?payload.bulkOperation:response.data?.bulkOperation;
 if(!op||op.id!==id||!statuses.has(op.status))fail();
 if(cancellation&&!terminal.has(op.status)&&op.status!=='CANCELING')fail();
 return {status:op.status,terminal:terminal.has(op.status)};
}
