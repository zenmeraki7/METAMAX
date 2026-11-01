/** A renewal error is lease loss, including an unknown renewal outcome. */
export function startExecutionHeartbeat({renew,intervalMs,timeoutMs,leaseMs}){
 const controller=new AbortController();let timer,pending=null,closed=false,lost;
 const failure=()=>Object.assign(Error('Execution lease lost'),{code:'HISTORY_OWNERSHIP_LOST'});
 let expiresAt=performance.now()+leaseMs;
 let rejectLoss;const loss=new Promise((_,reject)=>{rejectLoss=reject;});loss.catch(()=>{});
 const lose=()=>{if(!lost){lost=failure();controller.abort(lost);rejectLoss(lost);}return lost;};
 const assertOwned=()=>{if(performance.now()>=expiresAt)lose();if(lost)throw lost;};
 const tick=()=>{
  if(closed||pending)return;
  pending=(async()=>{let deadline;const startedAt=performance.now();try{
   const result=await Promise.race([Promise.resolve().then(renew),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(failure()),timeoutMs);})]);
   if(result!==true)throw failure();
   expiresAt=startedAt+leaseMs;
  }catch{lose();}finally{clearTimeout(deadline);}})().finally(()=>{
   pending=null;if(!closed&&!lost)timer=setTimeout(tick,intervalMs);
  });
 };
 timer=setTimeout(tick,intervalMs);
 return Object.freeze({signal:controller.signal,loss,assertOwned,
  async check(){if(pending)await pending;assertOwned();},
  async stop(){closed=true;clearTimeout(timer);if(pending)await pending;assertOwned();}
 });
}
