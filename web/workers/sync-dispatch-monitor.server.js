/** Scheduled DB-only exhaustion worker. Recovery evidence is handled by a
 * separate processor; this worker never infers queue absence from a timeout. */
export function createSyncDispatchMonitor({repository,intervalMs=30000,logger=console}={}) {
  for(const method of ['listExhaustedDispatches','markDispatchReviewRequired','getDispatchMetrics']) {
    if(typeof repository?.[method]!=='function')throw new TypeError(`${method} required`);
  }
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>3600000)throw new RangeError('Invalid monitor interval');
  let timer,running,latest=null;
  const log=(level,message)=>{try{Promise.resolve(logger?.[level]?.(message)).catch(()=>{});}catch{}};
  async function runOnce() {
    if(running)return {kind:'ALREADY_RUNNING'};
    running=(async()=>{
      let reviewed=0;
      for(const {dispatchId} of await repository.listExhaustedDispatches({limit:100})) {
        if((await repository.markDispatchReviewRequired({dispatchId})).kind==='RECORDED')reviewed++;
      }
      latest=Object.freeze({reviewed,...await repository.getDispatchMetrics()});
      log('info',{event:'sync_dispatch_monitor',...latest});return latest;
    })();
    try{return await running;}finally{running=null;}
  }
  return Object.freeze({runOnce,getMetrics:()=>latest,
    start(){if(timer)return;const tick=()=>{void runOnce().catch(error=>log('error',{event:'sync_dispatch_monitor_failed',code:error.code||'UNKNOWN'}));};
      timer=setInterval(tick,intervalMs);timer.unref?.();tick();},
    async stop(){clearInterval(timer);timer=null;try{await running;}catch(error){log('error',{event:'sync_dispatch_monitor_failed',code:error.code||'UNKNOWN'});}},
  });
}
