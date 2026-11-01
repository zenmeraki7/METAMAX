/**
 * METAMAX — Operation Worker Supervisor
 *
 * Runs scheduled checks for due bulk edit, row import and undo commands,
 * coordinating with operation.worker.js and history execution.
 */

import { randomUUID } from "node:crypto";
import {assertOperationWorker} from './operation.worker.js';

export function createOperationSupervisor({
  database,
  worker = null,
  intervalMs = 3000,
  logger = console,
} = {}) {
  if(worker!==null)assertOperationWorker(worker);
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw TypeError('Bounded operation poll interval required');
  let timer = null;
  let running = false;
  let stopped = true;
  let inFlight;
  const workerId = `op-supervisor-${randomUUID().slice(0, 8)}`;

  async function tick() {
    if (stopped || running || !database || !worker) return;
    running = true;
    try {
      // Each independent maintenance phase gets a chance even if another fails.
      for(const maintenance of ['discoverRecoveries','reconcileFinalizations']){
        try{await worker[maintenance]?.({workerId});}
        catch(error){try{logger.error?.({code:'OPERATION_MAINTENANCE_FAILED',phase:maintenance},'Independent operation reconciliation failed');}catch{}}
      }
      await worker.processOne({workerId,leaseSeconds:120});
    } catch (error) {
      try{logger.error?.('[operation-supervisor] Tick failed; durable recovery remains available');}catch{}
    } finally {
      running = false;
    }
  }
  const run=()=>{if(!running&&!stopped)inFlight=tick();};

  return Object.freeze({
    start() {
      if (!stopped || !worker || !database) return;
      stopped = false;
      timer = setInterval(run, intervalMs);
      timer.unref?.();
      run();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
  });
}
