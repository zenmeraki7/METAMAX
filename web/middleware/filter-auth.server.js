/** Only capture AFTER official Shopify verification. Input: server session and
 * opaque request; output: private request context/current stored session/tenant.
 * Authority requires classified identity, exact credential and branded active
 * installation at capture and every resolution. Missing resolver issues no
 * context. No durable effects; token/actor/classification/reinstall changes
 * revoke the context; scope/expiry are reloaded and checked by current policy.
 */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { shopifySessionEvidence,verifyCurrentShopifySession } from "./session-validation.js";
import {assertInstallationTenant} from '../security/installation-lifecycle.server.js';

export function createFilterAuthentication({ sessionStorage,resolveInstallation } = {}) {
  if (typeof sessionStorage?.loadSession !== "function")
    throw new TypeError("Shopify session storage required");
  const requests = new WeakMap(),
    sessions = new WeakMap();
  async function resolveSession(authContext) {
    const identity = authContext && sessions.get(authContext);
    if (!identity)
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Authenticated filter session required",
      );
    const stored = await sessionStorage.loadSession(identity.id);
    verifyCurrentShopifySession(stored,identity.evidence);
    const tenant=assertInstallationTenant(await resolveInstallation(identity.shop));
    if(tenant.shopId!==identity.shop||identity.tenant.installationVersion!==tenant.installationVersion)
      throw new FieldError(C.PERMISSION_DENIED,'Session belongs to another installation lifecycle');
    verifyCurrentShopifySession(stored,identity.evidence);
    return stored;
  }
  async function resolveShop(authContext) {
    return (await resolveSession(authContext)).shop;
  }
  return Object.freeze({
    capture(req, res, next) {
      requests.delete(req);
      const session = res.locals.shopify?.session;
      let evidence;
      try {evidence=shopifySessionEvidence(session);} catch {next();return;}
      const authContext = Object.freeze({});
      const requestTenant=res.locals.shopify?.installationTenant;
      if(typeof resolveInstallation!=='function')return next(new FieldError(C.MISSING_DEPENDENCY,'Installation-bound authentication required'));
      return Promise.resolve().then(()=>resolveInstallation(evidence.shopId)).then(tenant=>{
        assertInstallationTenant(tenant);if(tenant.shopId!==evidence.shopId)throw new FieldError(C.PERMISSION_DENIED,'Installation identity mismatch');
        if(requestTenant){
          assertInstallationTenant(requestTenant);
          if(requestTenant.shopId!==tenant.shopId||requestTenant.installationVersion!==tenant.installationVersion)
            throw new FieldError(C.PERMISSION_DENIED,'Request installation lifecycle changed');
        }
        verifyCurrentShopifySession(session,evidence);
        sessions.set(authContext,Object.freeze({id:evidence.sessionId,shop:evidence.shopId,tenant,evidence}));requests.set(req,authContext);next();
      }).catch(next);
    },
    // Resolve once for routes that need the session rather than an opaque context.
    // This does not cache authority: each call rechecks current storage.
    async authenticateSession(req) {
      const authContext = requests.get(req);
      return authContext ? resolveSession(authContext) : null;
    },
    async authenticate(req) {
      const authContext = requests.get(req);
      if (!authContext) return null;
      await resolveShop(authContext);
      return authContext;
    },
    resolveShop,
    resolveSession,
    async resolveTenant(authContext){
      if(typeof resolveInstallation!=='function')throw new FieldError(C.PERMISSION_DENIED,'Installation-bound authentication required');
      await resolveSession(authContext);return sessions.get(authContext).tenant;
    },
  });
}
