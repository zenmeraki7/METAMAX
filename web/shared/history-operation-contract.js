/** Pure presentation of persisted history kinds/states. No authority, effects or
 * lifecycle transitions are issued here. API and embedded UI share these labels;
 * unknown persisted states must remain visible as Unknown, never Pending.
 */
const operations=Object.freeze({
  undo:Object.freeze({type:'Undo',title:'Undo Operation'}),
  export:Object.freeze({type:'Export',title:'Product Export'}),
  import:Object.freeze({type:'Import',title:'Product Import'}),
  bulk_edit:Object.freeze({type:'Edit',title:'Bulk Product Edit'}),
});
const states=Object.freeze({
  SUCCEEDED:'Completed',COMPLETED:'Completed',
  RUNNING:'In Progress',ACTIVE:'In Progress',RECONCILING:'In Progress',
  CANCELLED:'Cancelled',FAILED:'Failed',PARTIAL:'Partial',
  RECORDING:'Pending',PENDING:'Pending',QUEUED:'Pending',
});
export function historyOperationPresentation(kind){
  const key=typeof kind==='string'?kind.toLowerCase():'';
  return Object.hasOwn(operations,key)?operations[key]:operations.bulk_edit;
}
export function historyStatusPresentation(state){
  const key=typeof state==='string'?state.toUpperCase():'';
  return Object.hasOwn(states,key)?states[key]:'Unknown';
}
export const HISTORY_STATUS_VISUALS=Object.freeze(Object.fromEntries(Object.entries({
  Running:{tone:'info',icon:'refresh'},Queued:{tone:'attention',icon:'clock'},
  Pending:{tone:'attention',icon:'clock'},Retrying:{tone:'warning',icon:'refresh'},
  Completed:{tone:'success',icon:'check-circle'},Partial:{tone:'warning',icon:'alert-circle'},
  Unknown:{tone:'neutral',icon:'info'},Cancelled:{tone:'neutral',icon:'x-circle'},
  Failed:{tone:'critical',icon:'alert-circle'},Expired:{tone:'neutral',icon:'alert-circle'},
}).map(([key,value])=>[key,Object.freeze(value)])));
export const HISTORY_STATUS_OPTIONS=Object.freeze(['All',...Object.keys(HISTORY_STATUS_VISUALS)]);
export function historyUiStatus(label){
  if(label==='In Progress')return 'Running';
  return Object.hasOwn(HISTORY_STATUS_VISUALS,label)?label:'Unknown';
}
