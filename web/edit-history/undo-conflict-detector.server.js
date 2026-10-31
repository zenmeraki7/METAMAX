/** Pure comparison; the caller authenticates observations before comparing. */
import {canonicalHistoryJson,historyFingerprint,HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
const key=o=>JSON.stringify([o.resourceGid,o.fieldId]);
const value=o=>JSON.stringify(canonicalHistoryJson({valueKind:o.valueKind,...(o.valueKind==='VALUE'?{value:o.value}:{})}));
export function detectUndoConflicts({fields,observations,conflictPolicy='ABORT_ON_CONFLICT'}={}){
 if(!Array.isArray(fields)||!fields.length||fields.length>64||!Array.isArray(observations)||fields.length!==observations.length||
  !['ABORT_ON_CONFLICT','SKIP_CONFLICTED'].includes(conflictPolicy))throw new HistoryContractError(C.INVALID_INPUT,'Bounded undo field set required');
 const current=new Map(observations.map(o=>[key(o),o]));
 if(current.size!==fields.length||new Set(fields.map(key)).size!==fields.length)throw new HistoryContractError(C.BINDING_CONFLICT,'Duplicate undo field');
 const conflicts=new Set();for(const f of fields){const o=current.get(key(f));
  if(!o)throw new HistoryContractError(C.BINDING_CONFLICT,'Missing exact undo observation');
  if(value(o)!==value(f.after))conflicts.add(f.resourceGid);
 }
 const eligible=conflictPolicy==='ABORT_ON_CONFLICT'&&conflicts.size?[]:fields.filter(f=>!conflicts.has(f.resourceGid));
 const inverse=eligible.map(f=>({resourceGid:f.resourceGid,fieldId:f.fieldId,beforeFingerprint:f.before.fingerprint,
  expectedFingerprint:f.after.fingerprint,valueKind:f.before.valueKind,...(f.before.valueKind==='VALUE'?{value:f.before.value}:{})}));
 return Object.freeze({conflicts:Object.freeze([...conflicts].sort()),inverse:Object.freeze(inverse),fingerprint:historyFingerprint({inverse,conflictPolicy},'undo-inverse-v3')});
}
