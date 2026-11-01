import {createPublicationRepository} from '../mirror/publication-repository.server.js';
import {transaction} from '../mirror/transactions.server.js';
/** Bounded background reclamation. No authorization or external-outcome guesses. */
export function createCatalogMaintenance({database,logger=console,intervalMs=60000}={}){
 if(typeof database?.query!=='function'||typeof database?.connect!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw TypeError('Catalog maintenance storage and interval required');
 const repository=createPublicationRepository({database});let timer,running,stopped=true,cursor='';
 const service=Object.freeze({
  async verifyStorage(){await database.query('SELECT shop_id,generation_id,summary,reclaimed_at FROM mirror.catalog_retention_audit LIMIT 0');},
  runOnce(){if(running)return running;
   running=(async()=>{
    const shops=(await database.query('SELECT id AS shop_id FROM mirror.shops WHERE id>$1 ORDER BY id LIMIT 5',[cursor])).rows;
    cursor=shops.at(-1)?.shop_id??'';let reclaimed=0;
    for(const {shop_id:shopId} of shops){
     try{reclaimed+=(await repository.cleanupGenerations({shopId})).length;
      await transaction(database,async client=>{
       await client.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
       await client.query(`DELETE FROM mirror.catalog_retention_audit WHERE shop_id=$1 AND generation_id IN(
        SELECT generation_id FROM mirror.catalog_retention_audit WHERE shop_id=$1 AND reclaimed_at<clock_timestamp()-interval '90 days' ORDER BY reclaimed_at LIMIT 100)`,[shopId]);
      },shopId);
     }catch(error){logger.error?.({code:error.code},'Catalog reclamation deferred');}
    }
    return {shops:shops.length,reclaimed};
   })().finally(()=>{running=null;});return running;
  },
  start(){if(!stopped)return;stopped=false;const tick=()=>service.runOnce().catch(error=>logger.error?.({code:error.code},'Catalog maintenance failed'));void tick();timer=setInterval(tick,intervalMs);timer.unref?.();},
  async stop(){stopped=true;clearInterval(timer);await running;}
 });return service;
}
