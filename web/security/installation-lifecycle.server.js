/** Canonical lifecycle coordinates; never accept a browser's installation claim. */
import {isValidShopifyDomain} from '../middleware/session-validation.js';
const issued=new WeakSet();
const deny=()=>{throw Object.assign(Error('Current installation lifecycle required'),{code:'INSTALLATION_NOT_ACTIVE'});};
export function assertInstallationTenant(tenant){if(!tenant||!issued.has(tenant))deny();return tenant;}
export function createInstallationResolver({readInstallation}={}){
 if(typeof readInstallation!=='function')throw TypeError('Trusted active installation reader required');
 return async shopId=>{
  if(!isValidShopifyDomain(shopId))deny();
  const installation=await readInstallation(shopId),version=installation?.installation_version;
  if(installation?.uninstalled_at!=null||typeof version!=='string'||!version||version.length>255||version.trim()!==version)deny();
  const tenant=Object.freeze({shopId,installationId:version,installationVersion:version});issued.add(tenant);return tenant;
 };
}
/** A statement-specific infrastructure repository; the raw pool stays private. */
export function createDatabaseInstallationResolver({database}={}){
 if(typeof database?.connect!=='function')throw TypeError('Transactional installation storage required');
 return createInstallationResolver({readInstallation:async shopId=>{
  const tx=await database.connect();try{
   await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
   await tx.query("SET LOCAL statement_timeout='5000ms'");
   await tx.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
   const row=(await tx.query('SELECT installation_version,uninstalled_at FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL',[shopId])).rows[0];
   await tx.query('COMMIT');return row;
  }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
 }});
}
