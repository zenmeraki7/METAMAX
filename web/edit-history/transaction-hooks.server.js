import {lockPublication} from '../mirror/publication-lock.server.js';
import { HistoryContractError,HISTORY_ERROR_CODES as C } from './history-contract.js';
// Application authority/receipt callbacks can read and lock on this exact
// connection, but cannot commit it or retain a usable client after completion.
export function createHistoryHookInvoker(client,{budgetMs=15000,hookMs=5000}={}) {
 if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>15000||!Number.isSafeInteger(hookMs)||hookMs<1||hookMs>5000)throw new TypeError('Bounded history callback deadlines required');
 const deadline=Date.now()+budgetMs;
 return async (fn,args)=>{
  if(typeof fn!=='function')throw new HistoryContractError(C.UNAUTHORIZED,'Trusted integration callback required');
  const remaining=Math.min(hookMs,deadline-Date.now());
  if(remaining<=0)throw new HistoryContractError(C.OWNERSHIP_LOST,'History transaction deadline exceeded');
  let active=true,timer;
  const controller=new AbortController();
  const scopedShop=args.tenant?.shopId;
  const checkActive=()=>{if(!active||Date.now()>=deadline)throw new HistoryContractError(C.OWNERSHIP_LOST,'Transaction callback capability expired');};
  const guarded=Object.freeze({async publicationLock(shopId,{write=false,relation='"mirror"."publications"'}={}){
   checkActive();
   if(shopId!==scopedShop||write!==false||relation!=='"mirror"."publications"')throw new HistoryContractError(C.UNAUTHORIZED,'Exact tenant publication read lock required');
   await lockPublication(client,shopId);checkActive();
  },async query(sql,values){
   if(!active||Date.now()>=deadline)throw new HistoryContractError(C.OWNERSHIP_LOST,'Transaction callback capability expired');
   if(typeof sql!=='string'||!/^\s*SELECT\b/i.test(sql)||sql.replace(/;\s*$/,'').includes(';'))throw new HistoryContractError(C.UNAUTHORIZED,'Authority callbacks require one parameterized SELECT statement');
   const result=await client.query(sql,values);
   if(!active||Date.now()>=deadline)throw new HistoryContractError(C.OWNERSHIP_LOST,'Transaction callback capability expired');
   return result;
  }});
  try{return await Promise.race([
   Promise.resolve().then(()=>fn({...args,client:guarded,signal:controller.signal})),
   new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;controller.abort();reject(new HistoryContractError(C.OWNERSHIP_LOST,'History integration callback deadline exceeded'));},remaining);})
  ]);}finally{active=false;clearTimeout(timer);controller.abort();}
 };
}
