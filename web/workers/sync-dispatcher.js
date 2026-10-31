/** Durable sync notifications. PostgreSQL owns eligibility, tenant fairness,
 * reservation fencing/expiry and outcome reconciliation; BullMQ only wakes a
 * worker with {runId}. The host owns scheduling and shutdown.
 *
 * Repository: reserveDispatchBatch({limit:1,reservationSeconds}) returns at most
 * one {dispatchId,dispatchToken,kind,runId,deliveryKey}. deliveryKey is derived
 * from durable shop/run/execution-or-phase revision and stays stable across
 * reservation expiry/retries, changing only for a new logical delivery.
 * markDispatched({...reservation,jobId})
 * and markDispatchFailure({...reservation,code}) return {kind:'RECORDED'} or
 * {kind:'STALE_CLAIM'}. These receipts never authorize phase execution.
 */
import { createHash } from "node:crypto";

export const SYNC_DISPATCH_QUEUE = "metamax-catalog-sync";
export const RECOVERY_DISPATCH_QUEUE = "metamax-catalog-sync-recovery";
export const DISPATCH_KINDS = Object.freeze({ SYNC:"SYNC", RECOVERY:"RECOVERY" });
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_OPTIONS = Object.freeze({maxDeliveriesPerCycle:25,reservationSeconds:60,queueTimeoutMs:10000,ackTimeoutMs:10000});
// Retries and eligibility are durable DB decisions, not queue retry policy.
const JOB_OPTIONS = Object.freeze({attempts:1,removeOnComplete:true,removeOnFail:true});

export class SyncDispatcherError extends Error {
  constructor(code, message, {outcomeUncertain=false}={}) {
    super(message); this.name="SyncDispatcherError"; this.code=code; this.outcomeUncertain=outcomeUncertain;
  }
}
function assertMethod(object, method, name) {
  if (typeof object?.[method] !== 'function') throw new TypeError(`${name}.${method} is required`);
}
function positiveInteger(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
}
function validId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new SyncDispatcherError('INVALID_RESERVATION',`Invalid ${name}`);
  }
  return value;
}
function ownData(value, key) {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor || !Object.hasOwn(descriptor,'value')) throw new SyncDispatcherError('INVALID_RECEIPT','Repository data properties required');
  return descriptor.value;
}
function data(value, keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    throw new SyncDispatcherError('INVALID_RECEIPT','Plain repository data required');
  }
  return Object.fromEntries(keys.map(key => [key,ownData(value,key)]));
}
function normalizeReservation(value) {
  const reservation=data(value,['dispatchId','dispatchToken','kind','runId']);
  const deliveryKey=validId(ownData(value,'deliveryKey'),'deliveryKey');
  for (const key of ['dispatchId','dispatchToken','runId']) {
    validId(reservation[key],key);
  }
  if (!Object.values(DISPATCH_KINDS).includes(reservation.kind)) throw new SyncDispatcherError('INVALID_RESERVATION','Known dispatch kind required');
  return Object.freeze({...reservation,deliveryKey});
}
function acknowledge(value) {
  const {kind}=data(value,['kind']);
  if (!['RECORDED','STALE_CLAIM'].includes(kind)) throw new SyncDispatcherError('ACK_UNKNOWN','Verified dispatch acknowledgment required');
  return kind;
}
function safeLog(logger, level, value) {
  try { Promise.resolve(logger?.[level]?.(value)).catch(()=>{}); } catch {}
}
function errorCode(error) {
  try {
    const code=error?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  } catch {}
  return 'DELIVERY_OUTCOME_UNKNOWN';
}
export function dispatchJobId({kind,deliveryKey}) {
  validId(deliveryKey,'deliveryKey');
  if (kind !== 'SYNC' && kind !== 'RECOVERY') throw new SyncDispatcherError('INVALID_KIND','Invalid dispatch kind');
  const digest=createHash('sha256').update(kind).update('\0').update(deliveryKey).digest('hex');
  return `metamax-${kind.toLowerCase()}-${digest}`;
}

export function createSyncDispatcher({repository,syncQueue,recoveryQueue,
  maxDeliveriesPerCycle=DEFAULT_OPTIONS.maxDeliveriesPerCycle,
  reservationSeconds=DEFAULT_OPTIONS.reservationSeconds,
  queueTimeoutMs=DEFAULT_OPTIONS.queueTimeoutMs,
  ackTimeoutMs=DEFAULT_OPTIONS.ackTimeoutMs,logger=console}={}) {
  for (const method of ['reserveDispatchBatch','markDispatched','markDispatchFailure']) assertMethod(repository,method,'repository');
  assertMethod(syncQueue,'add','syncQueue');assertMethod(recoveryQueue,'add','recoveryQueue');
  positiveInteger(maxDeliveriesPerCycle,1,250,'maxDeliveriesPerCycle');
  positiveInteger(reservationSeconds,10,3600,'reservationSeconds');
  positiveInteger(queueTimeoutMs,100,60000,'queueTimeoutMs');
  positiveInteger(ackTimeoutMs,100,60000,'ackTimeoutMs');
  if (reservationSeconds*1000 <= queueTimeoutMs+ackTimeoutMs+5000) throw new RangeError('Reservation period is too short');

  let running=false,cycleTimedOut=false;
  let pendingQueueCall=null;
  const pending=new Set();
  async function withinDeadline(action, milliseconds) {
    const operation=Promise.resolve().then(action);
    pending.add(operation);
    // Observe late rejection and retain the local exclusion until actual
    // settlement. A timeout ends our wait; it does not cancel Redis or SQL.
    operation.then(()=>pending.delete(operation),()=>pending.delete(operation));
    let handle;
    try {
      return await Promise.race([operation,new Promise((_,reject)=>{
        handle=setTimeout(()=>{
          cycleTimedOut=true;
          reject(new SyncDispatcherError('OPERATION_TIMEOUT','Dispatch operation deadline exceeded',{outcomeUncertain:true}));
        },milliseconds);
      })]);
    } finally { clearTimeout(handle); }
  }
  async function enqueueTracked(queue,queueName,reservation,jobId) {
    if (pendingQueueCall) throw new SyncDispatcherError('QUEUE_OPERATION_PENDING','Previous enqueue remains unresolved',{outcomeUncertain:true});
    const operation=Promise.resolve().then(()=>queue.add(queueName,{runId:reservation.runId},{...JOB_OPTIONS,jobId}));
    pendingQueueCall=operation;
    const settled=()=>{if(pendingQueueCall===operation)pendingQueueCall=null;};
    void operation.then(settled,settled);
    return withinDeadline(()=>operation,queueTimeoutMs);
  }
  async function recordUncertainDelivery(reservation,error) {
    try {
      return acknowledge(await withinDeadline(()=>repository.markDispatchFailure({...reservation,code:errorCode(error)}),ackTimeoutMs));
    } catch (recordError) {
      safeLog(logger,'error',{event:'sync_dispatch_failure_record_unknown',dispatchId:reservation.dispatchId,code:errorCode(recordError)});
      return 'UNKNOWN';
    }
  }
  async function deliver(reservation) {
    const recovery=reservation.kind===DISPATCH_KINDS.RECOVERY;
    const queue=recovery?recoveryQueue:syncQueue;
    const queueName=recovery?RECOVERY_DISPATCH_QUEUE:SYNC_DISPATCH_QUEUE;
    const jobId=dispatchJobId(reservation);
    try {
      const job=await enqueueTracked(queue,queueName,reservation,jobId);
      if (job?.id !== jobId) throw new SyncDispatcherError('DELIVERY_OUTCOME_UNKNOWN','Queue receipt does not match logical job identity');
    } catch (error) {
      const recorded=await recordUncertainDelivery(reservation,error);
      safeLog(logger,'error',{event:'sync_dispatch_uncertain',runId:reservation.runId,dispatchId:reservation.dispatchId,code:errorCode(error),recorded});
      return 'UNCERTAIN';
    }
    // A failed DB acknowledgment must never repeat enqueue or issue a
    // compensating failure write in this invocation: COMMIT may have succeeded.
    try {
      const result=acknowledge(await withinDeadline(()=>repository.markDispatched({...reservation,jobId}),ackTimeoutMs));
      return result==='RECORDED'?'DISPATCHED':'STALE';
    } catch (error) {
      safeLog(logger,'error',{event:'sync_dispatch_ack_unknown',runId:reservation.runId,dispatchId:reservation.dispatchId,code:errorCode(error)});
      return 'ACK_UNKNOWN';
    }
  }
  async function reserveOne() {
    // Discovery is bounded too. A late reservation is left for DB expiry;
    // there is no continuation that enqueues it after this wait times out.
    const batch=await withinDeadline(()=>repository.reserveDispatchBatch({limit:1,reservationSeconds}),ackTimeoutMs);
    if (!Array.isArray(batch) || batch.length>1) throw new SyncDispatcherError('INVALID_BATCH','Expected at most one reservation');
    if (!batch.length) return null;
    const descriptor=Object.getOwnPropertyDescriptor(batch,'0');
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw new SyncDispatcherError('INVALID_BATCH','Reservation data required');
    return normalizeReservation(descriptor.value);
  }
  async function runOnce() {
    if (running) return Object.freeze({kind:'ALREADY_RUNNING'});
    if (pendingQueueCall || pending.size) return Object.freeze({kind:'ASYNC_OPERATION_PENDING'});
    running=true;cycleTimedOut=false;
    const totals={dispatched:0,uncertain:0,stale:0,ackUnknown:0,errors:0};
    let scanned=0,stopReason=null;
    const seen=new Set();
    try {
      for (let index=0;index<maxDeliveriesPerCycle;index++) {
        let reservation;
        try { reservation=await reserveOne(); }
        catch (error) {
          totals.errors++;stopReason='RESERVATION_FAILED';
          safeLog(logger,'error',{event:'sync_dispatch_reserve_failed',code:errorCode(error)});break;
        }
        if (!reservation) { stopReason='NO_DUE_WORK';break; }
        if (seen.has(reservation.dispatchId)) {
          totals.errors++;stopReason='DUPLICATE_RESERVATION';
          safeLog(logger,'error',{event:'sync_dispatch_duplicate_reservation',dispatchId:reservation.dispatchId});break;
        }
        seen.add(reservation.dispatchId);scanned++;
        try {
          const kind=await deliver(reservation);
          const counter={DISPATCHED:'dispatched',UNCERTAIN:'uncertain',STALE:'stale',ACK_UNKNOWN:'ackUnknown'}[kind];
          totals[counter??'errors']++;
        } catch (error) {
          totals.errors++;
          safeLog(logger,'error',{event:'sync_dispatch_record_failed',dispatchId:reservation.dispatchId,code:errorCode(error)});
        }
        if (cycleTimedOut || pendingQueueCall || pending.size) { stopReason='UNRESOLVED_ASYNC_OPERATION';break; }
      }
      const outcome=Object.freeze({kind:totals.errors||totals.uncertain||totals.ackUnknown?'PARTIAL':'COMPLETED',scanned,...totals,stopReason});
      safeLog(logger,'info',{event:'sync_dispatch_cycle',...outcome});
      return outcome;
    } finally { running=false; }
  }
  return Object.freeze({runOnce});
}
