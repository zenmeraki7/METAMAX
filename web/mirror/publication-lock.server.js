// Interface contract (repository root): docs/backend-interface-contracts.md#publication-fencing
/** Transaction-scoped locks work with direct and transaction-pooled Postgres.
 * Readers use READ COMMITTED: the lock SELECT may wait, so the first protected
 * data statement must take a fresh snapshot AFTER acquisition. The held shared
 * lock then prevents same-shop publication/coverage/reclamation changes until
 * commit. Repeatable-read/serializable callers must additionally lock the exact
 * publication row FOR SHARE and verify its pinned coordinates; a snapshot
 * predating a publisher must abort/retry rather than certify the old row.
 * ACCESS SHARE below is a DDL fence only. The advisory lock fences publishers.
 * No session locks or connection-local grants survive pool release.
 */
import {FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';

export async function lockPublication(client,shopId,{write=false,relation='"mirror"."publications"'}={}) {
  if(typeof client?.query!=='function'||typeof shopId!=='string'||!shopId||Buffer.byteLength(shopId)>255||shopId.includes('\0'))
    throw new FieldError(C.PERMISSION_DENIED,'Trusted publication shop required');
  // History hooks expose a bounded lock capability without raw LOCK SQL.
  if(typeof client.publicationLock==='function')return client.publicationLock(shopId,{write,relation});
  // Keep a DDL fence, compatible with ordinary readers and writers. Relation
  // comes only from the installed server-owned schema, never request input.
  // PostgreSQL rejects LOCK TABLE outside an explicit transaction (25P01).
  // Keep this first: no advisory lock or protected work can succeed under
  // autocommit. BEGIN/COMMIT remain owned by the surrounding repository.
  await client.query(`LOCK TABLE ${relation} IN ACCESS SHARE MODE`);
  await client.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
  await client.query(`SELECT pg_catalog.${write?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(
    pg_catalog.hashtextextended($1::text, 581834147::bigint))`,[shopId]);
}
