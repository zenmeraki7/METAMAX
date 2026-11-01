/** Disposable PostgreSQL fixture only: records successful import evidence for an
 * already PUBLISHED generation. Does not publish data or weaken admission guards.
 * Input: test admin client and shop. Output: void. Authority: localhost isolated
 * test database owner; durable effect: one completed import fixture row.
 */
import {randomUUID} from 'node:crypto';
export async function recordCompletedCatalogImport(database,shopId){
 if(process.env.FILTER_TEST_DATABASE_ISOLATED!=='1'||!['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.FILTER_TEST_DATABASE_URL).hostname))throw Error('Isolated database fixture required');
 const result=await database.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id,status)
 SELECT $2,s.id,s.installation_version,p.generation_id,'SUCCEEDED' FROM mirror.shops s
 JOIN mirror.publications p ON p.shop_id=s.id JOIN mirror.generations g ON g.shop_id=s.id AND g.id=p.generation_id AND g.status='PUBLISHED'
 WHERE s.id=$1 AND s.uninstalled_at IS NULL RETURNING id`,[shopId,randomUUID()]);
 if(result.rowCount!==1)throw Error('Published fixture generation required before edit admission');
}
