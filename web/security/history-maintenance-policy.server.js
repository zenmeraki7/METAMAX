/** Server-owned maintenance budgets and redacted diagnostics; no data access. */
export function historyMaintenanceBudgets(env){
  const read=(name,fallback,min,max)=>{
    const value=env[name]===undefined?fallback:Number(env[name]);
    if(!Number.isSafeInteger(value)||value<min||value>max)throw TypeError(`Invalid ${name}`);
    return value;
  };
  return Object.freeze({
    purgeBatches:read('HISTORY_PURGE_BATCHES_PER_PASS',5,1,20),
    purgeBatchSize:read('HISTORY_PURGE_BATCH_SIZE',250,1,500),
    encryptionBatches:read('HISTORY_ENCRYPTION_BATCHES_PER_PASS',1,1,10),
    encryptionBatchSize:read('HISTORY_ENCRYPTION_BATCH_SIZE',10,1,25),
    passBudgetMs:read('HISTORY_MAINTENANCE_PASS_BUDGET_MS',60000,1000,300000),
  });
}
const databaseCodes=new Set(['40001','40P01','55P03','57P01','57014','08006','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
const historyCodes=new Set(['HISTORY_UNAUTHORIZED','HISTORY_BINDING_CONFLICT','HISTORY_EVIDENCE_CONFLICT','HISTORY_UNSUPPORTED_VERSION']);
export function historyMaintenanceFailure(error,stage){
  const own=key=>{try{return error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,key)?.value:undefined;}catch{return undefined;}};
  const code=own('code'),message=own('message');
  const category=message==='History encryption key unavailable'?'KEY_UNAVAILABLE':databaseCodes.has(code)?'DATABASE':historyCodes.has(code)?'HISTORY_CONTRACT':error instanceof TypeError?'CONFIGURATION':'EXECUTION';
  return Object.freeze({code:databaseCodes.has(code)||historyCodes.has(code)?code:'HISTORY_MAINTENANCE_FAILED',
    category,stage:['startup','retention','encryption','shutdown'].includes(stage)?stage:'startup'});
}
