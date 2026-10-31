/** Only compose into authenticated Shopify webhook callbacks, never a route. */
import { protectedHistoryDatabase } from './database-security.server.js';
export function createHistoryPrivacyService({database}){
 const pool=protectedHistoryDatabase(database,'privacy');
 return Object.freeze({async redactShop(shop){
  if(typeof shop!=='string'||shop.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))throw TypeError('Authenticated webhook shop required');
  const client=await pool.connect();try{
   const result=await client.query('SELECT edit_history.request_shop_redaction($1) AS queued',[shop]);
   return Object.freeze({queuedScopes:result.rows[0].queued});
  }catch{throw Error('History privacy request could not be persisted');}finally{client.release();}
 }});
}
