import {createTenantAuthority} from '../tenant.server.js';
import {createTenantDatabase} from '../tenant-db.server.js';
import {createTenantDatabaseVerifier,getInstallationInTransaction} from '../tenant-db-adapters.server.js';
import {lockPublication} from '../../mirror/publication-lock.server.js';
import {tenantIdentity} from '../../middleware/shopify-auth.js';
import {SYNC_SOURCES_SQL} from './sync-sources.statement.js';
import {AsyncLocalStorage} from 'node:async_hooks';

export const SOURCE_TABLES=Object.freeze(['mirror.shops','mirror.publications','mirror.generations','mirror.coverage','mirror.catalog_import_jobs']);
const productRead=s=>typeof s==='string'&&s.split(',').some(v=>['read_products','write_products'].includes(v.trim()));
export function createTenantSourcesRepository({pool,authentication}={}){
  if(typeof pool?.connect!=='function'||typeof authentication?.resolveSession!=='function')throw TypeError('Restricted tenant pool and issued authentication required');
  const verify=createTenantDatabaseVerifier({tables:SOURCE_TABLES});
  const currentAuthentication=new AsyncLocalStorage();
  const authority=createTenantAuthority({
    authenticateAdmin:async authContext=>{
      const identity=tenantIdentity(await authentication.resolveSession(authContext));
      return identity;
    },
    getActiveInstallation:async shopId=>{
      const tx=await pool.connect();let discard;
      try{
        await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        await tx.query("SET LOCAL statement_timeout='5000ms'");await tx.query("SET LOCAL lock_timeout='1000ms'");
        if(await verify(tx)!==true)throw Error('Restricted source database required');
        await tx.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
        await lockPublication(tx,shopId);
        const current=await getInstallationInTransaction(tx,shopId,'READ');await tx.query('COMMIT');return current;
      }catch(error){try{await tx.query('ROLLBACK');}catch(failure){discard=failure;}throw error;}
      finally{tx.release(discard);}
    },
    getInstallationInTransaction,
    verifyWorkerClaim:async()=>{throw Error('Source reads do not admit workers');},
    verifyWorkerInTransaction:async()=>{throw Error('Source reads do not admit workers');},
    authorizeAdminInTransaction:async(_tx,identity,operation)=>{
      // adminIdentity copies the scalar record. Bind authentication by immutable
      // session identity instead of treating that copy as a reusable permission.
      const authContext=currentAuthentication.getStore();
      if(!authContext||operation!=='sync_sources.read')return {authorized:false};
      const session=await authentication.resolveSession(authContext),current=tenantIdentity(session);
      return {authorized:current.sessionId===identity.sessionId&&current.shopId===identity.shopId&&current.identityKind===identity.identityKind&&(current.actorId??null)===identity.actorId&&
        productRead(session.scope)&&(!session.isOnline||productRead(session.onlineAccessInfo?.associated_user_scope))};
    },
    operations:[{operation:'sync_sources.read',mode:'READ'}],workerPolicies:[],
  });
  const gateway=createTenantDatabase({pool,authority,verifyDatabase:verify,statements:[{
    name:'sync_sources.read',mode:'READ',operations:['sync_sources.read'],sql:SYNC_SOURCES_SQL,
    validateValues:values=>{if(!Array.isArray(values)||values.length)throw TypeError('No browser parameters accepted');return [];},
  }]});
  return Object.freeze({async read({authContext}){
    return currentAuthentication.run(authContext,async()=>{
      const context=await authority.fromAdminRequest(authContext);
      return await gateway.withTenantRead({context,operation:'sync_sources.read',execute:async repository=>(await repository.run('sync_sources.read')).rows[0]??null});
    });
  }});
}
