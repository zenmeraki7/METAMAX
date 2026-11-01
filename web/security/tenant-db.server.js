import {lockPublication} from '../mirror/publication-lock.server.js';

export class TenantDatabaseError extends Error {
  constructor(code,status=403,options){super(code,options);this.name='TenantDatabaseError';this.code=code;this.status=status;}
}
const fail=code=>{throw new TenantDatabaseError(code);};
export function classifyTenantDatabaseError(error){
  if(error instanceof TenantDatabaseError||error?.name==='TenantSecurityError')return 'PERMANENT';
  if(['40001','40P01','P2034'].includes(error?.code))return 'RETRYABLE_TRANSACTION';
  if(['55P03','57014','P2024'].includes(error?.code))return 'TRANSIENT_CAPACITY';
  // Network/commit failures may have committed: never replay automatically.
  if(/^08/.test(error?.code??'')||['ECONNRESET','ETIMEDOUT'].includes(error?.code))return 'OUTCOME_UNKNOWN';
  return 'PERMANENT';
}
const bounded=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

/** Trusted bootstrap only. Actual application driver is pg, not Prisma.
 * Repositories receive named statements, never a client/pool/raw SQL method.
 * No retries: callbacks may have effects outside this transaction. */
export function createTenantDatabase({pool,authority,statements,verifyDatabase,operationTimeouts={}}={}){
  if(typeof pool?.connect!=='function'||typeof authority?.assertOperation!=='function'||typeof authority?.runAuthorized!=='function'||
    typeof authority?.describe!=='function'||typeof verifyDatabase!=='function'||!Array.isArray(statements))throw TypeError('Trusted gateway dependencies required');
  const registry=new Map(),timeouts=new Map();
  for(const item of statements){
    if(!item||typeof item.name!=='string'||!item.name||registry.has(item.name)||typeof item.sql!=='string'||
      !['READ','WRITE'].includes(item.mode)||!Array.isArray(item.operations)||!item.operations.length||
      typeof item.validateValues!=='function')throw TypeError('Invalid trusted statement registration');
    registry.set(item.name,Object.freeze({...item,operations:Object.freeze([...item.operations])}));
  }
  for(const [operation,value] of Object.entries(operationTimeouts)){
    if(!value||!bounded(value.statementMs,100,30000)||!bounded(value.lockMs,100,5000)||value.lockMs>value.statementMs)
      throw TypeError('Bounded operation timeouts required');
    timeouts.set(operation,Object.freeze({...value}));
  }
  async function run({context,operation,mode,execute}){
    if(typeof execute!=='function')throw TypeError('Protected callback required');
    authority.assertOperation(context,operation,mode);
    const tenant=authority.describe(context),limits=timeouts.get(operation)??{statementMs:mode==='READ'?5000:15000,lockMs:1000};
    const client=await pool.connect();let active=false,discard,timer;
    const pending=new Set(),failures=[];
    try{
      // READ COMMITTED is required: advisory lock acquisition can wait, and the
      // installation read after it must see the lifecycle writer's latest commit.
      await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED ${mode==='READ'?'READ ONLY':'READ WRITE'}`);active=true;
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
        [String(limits.statementMs),String(limits.lockMs),String(Math.min(60000,limits.statementMs*2))]);
      if(await verifyDatabase(client)!==true)fail('TENANT_DATABASE_NOT_VERIFIED');
      await client.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true),set_config('app.installation_version',$3,true)",
        [tenant.shopId,tenant.installationId,tenant.installationVersion]);
      // Same lock used by install/uninstall/publication writers. Shared advisory
      // locks work in READ ONLY transactions without SELECT FOR UPDATE.
      await lockPublication(client,tenant.shopId,{write:mode==='WRITE'});
      const work=authority.runAuthorized({context,tx:client,operation,mode,execute:async tx=>{
        if(tx!==client)fail('TRANSACTION_IDENTITY_MISMATCH');
        const settings=(await client.query("SELECT current_setting('app.shop_id',true) AS shop_id,current_setting('app.installation_id',true) AS installation_id,current_setting('app.installation_version',true) AS installation_version")).rows;
        if(settings.length!==1||settings[0].shop_id!==tenant.shopId||settings[0].installation_id!==tenant.installationId||settings[0].installation_version!==tenant.installationVersion)
          fail('TENANT_CONTEXT_MISMATCH');
        const repository=Object.freeze({async run(name,values=[]){
          if(!active)fail('TENANT_TRANSACTION_ENDED');
          const statement=registry.get(name);
          if(!statement||!statement.operations.includes(operation)||statement.mode!==mode)fail('TENANT_STATEMENT_DENIED');
          // Trusted validators return detached, bounded pg parameter arrays.
          const parameters=statement.validateValues(values);
          if(!Array.isArray(parameters)||parameters.length>100)fail('TENANT_PARAMETERS_INVALID');
          // Registry SQL must explicitly bind all three tenant/lifecycle values.
          const request=client.query(statement.sql,[tenant.shopId,tenant.installationId,tenant.installationVersion,...parameters]);
          pending.add(request);
          let response;
          try{response=await request;}catch(error){failures.push(error);throw error;}finally{pending.delete(request);}
          if(!active)fail('TENANT_TRANSACTION_ENDED');
          return response;
        }});
        return execute(repository);
      }});
      const result=await Promise.race([work,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new TenantDatabaseError('TENANT_TRANSACTION_TIMEOUT',503)),Math.min(60000,limits.statementMs*2));
      })]);
      if(pending.size)fail('TENANT_UNAWAITED_QUERY');
      if(failures.length)throw failures[0];
      active=false;await client.query('COMMIT');return result;
    }catch(error){
      active=false;await Promise.allSettled([...pending]);
      try{await client.query('ROLLBACK');}catch(failure){discard=failure;}
      throw error;
    }finally{clearTimeout(timer);active=false;client.release(discard);}
  }
  return Object.freeze({withTenantRead:input=>run({...input,mode:'READ'}),withTenantWrite:input=>run({...input,mode:'WRITE'})});
}
