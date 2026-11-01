/** Read-only composition; HTTP requests never supply a tenant or a SQL client. */
import { createHistoryPages } from './history-pages.server.js';
import { operationRecord } from './history-repository.server.js';
import { createHistoryExecutionAdapter } from '../services/history-execution-adapter.server.js';
import { HistoryContractError, HISTORY_ERROR_CODES as C } from './history-contract.js';

const forbidden = () => { throw new HistoryContractError(C.UNAUTHORIZED, 'Current history read authorization required'); };
const productRead = value => typeof value === 'string' && value.split(',').some(scope =>
  ['read_products','write_products'].includes(scope.trim()));

/** Independent metadata-read policy: product-read app scope, and online staff
 * scope when present. Sensitive snapshot values are never exposed here.
 * Deployments with additional RBAC can supply authorizeHistoryRead explicitly.
 * Write permission is never borrowed from a job or an execution contract. */
export function createHistoryReadAuthorization(authentication) {
  return async ({authContext,tenant,operation}) => {
    if (!['list_operations','list_changes','read_operation'].includes(operation)) return false;
    const session = await authentication.resolveSession(authContext);
    if (session.shop !== tenant.shopId || !productRead(session.scope)) return false;
    // Online credentials are constrained by the staff member's own scope too.
    if (session.isOnline && !productRead(session.onlineAccessInfo?.associated_user_scope)) return false;
    return true;
  };
}

export function createHistoryReadService({database,authentication,cursorSecret,
  authorizeHistoryRead = createHistoryReadAuthorization(authentication)} = {}) {
  if (typeof database?.connect !== 'function' || typeof authentication?.resolveShop !== 'function' ||
      typeof authentication?.resolveSession !== 'function' || typeof authorizeHistoryRead !== 'function') {
    throw new TypeError('Authenticated history read dependencies required');
  }
  const resolveTenant = async ({client,authContext}) => {
    const shopId = await authentication.resolveShop(authContext);
    await client.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
    const installed = (await client.query(`SELECT installation_version FROM mirror.shops
      WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE`, [shopId])).rows[0];
    if (!installed?.installation_version) forbidden();
    return {shopId,installationId:installed.installation_version};
  };
  return createHistoryPages({database,resolveTenant,authorizeHistoryRead,
    historyCursorSecret:cursorSecret,executionAdapter:createHistoryExecutionAdapter(),operationRecord});
}
