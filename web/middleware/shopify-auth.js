/**
 * METAMAX — Shopify Session Authentication Middleware
 *
 * web/middleware/shopify-auth.js
 *
 * Enforces authenticated Shopify sessions on /api routes, rejects missing,
 * expired, or malformed shop identities (never trusting req.query.shop or
 * browser headers), and bridges verified sessions into the Filter Engine's
 * WeakMap-backed authentication context.
 */

import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { createFilterAuthentication } from "./filter-auth.server.js";
import { isValidShopifySession,shopifySessionEvidence,verifyCurrentShopifySession } from "./session-validation.js";
import {createDatabaseInstallationResolver,assertInstallationTenant} from '../security/installation-lifecycle.server.js';
export { SHOP_DOMAIN_PATTERN, isValidShopifyDomain, isValidShopifySession } from "./session-validation.js";

// Only this module can record successful Shopify request verification.
const verifiedRequests = new WeakMap();

export function tenantIdentity(session) {
  const {accessToken,...identity}=shopifySessionEvidence(session);
  return Object.freeze(identity);
}

/** Tenant Authority adapter. Input: officially verified request plus trusted
 * storage/lifecycle resolver. Output: classified identity and current pinned
 * installation coordinates, never credentials. Reloads credential and lifecycle
 * on every call; replacement/reinstall revokes prior evidence. No durable writes.
 */
export function createTenantAdminAuthenticator({sessionStorage,resolveInstallation}={}) {
  if(typeof sessionStorage?.loadSession!=='function'||typeof resolveInstallation!=='function')throw new TypeError('Shopify session storage and installation resolver required');
  return async request=>{
    const verified=verifiedRequests.get(request);
    if(!verified?.identity)throw new FieldError(C.PERMISSION_DENIED,'Verified Shopify request required');
    const session=verifyCurrentShopifySession(await sessionStorage.loadSession(verified.id),verified.evidence);
    const tenant=await revalidateInstallation(verified,resolveInstallation,session.shop);
    verifyCurrentShopifySession(session,verified.evidence);
    return Object.freeze({...tenantIdentity(session),installationId:tenant.installationId,installationVersion:tenant.installationVersion});
  };
}

async function revalidateInstallation(verified,resolveInstallation,shopId) {
  const tenant=assertInstallationTenant(await resolveInstallation(shopId));
  if(tenant.shopId!==shopId||verified.tenant&&verified.tenant.installationVersion!==tenant.installationVersion)
    throw new FieldError(C.PERMISSION_DENIED,'Installation lifecycle changed');
  verified.tenant=tenant;
  return tenant;
}

export function requireVerifiedShopifySession(req, res, next) {
  const verified = verifiedRequests.get(req);
  const session = res.locals?.shopify?.session;
  try {
    if (!verified || session !== verified.session) throw Error('Unverified request');
    verifyCurrentShopifySession(session,verified.evidence);
  } catch {
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", retryable: false } });
  }
  return next();
}

// Mounted once before every protected API router, including legacy handlers.
export function createInstallationGuard({ database, sessionStorage } = {}) {
  const resolveInstallation=database?.connect?createDatabaseInstallationResolver({database}):null;
  return async (req, res, next) => {
    const verified = verifiedRequests.get(req);
    if (!verified) return res.status(401).json({error:'UNAUTHENTICATED'});
    try {
      let current;
      try {current=verifyCurrentShopifySession(await sessionStorage.loadSession(verified.id),verified.evidence);} catch {
        return res.status(401).json({error:'UNAUTHENTICATED'});
      }
      if (!resolveInstallation) return res.status(503).json({error:'INSTALLATION_UNAVAILABLE'});
      try{await revalidateInstallation(verified,resolveInstallation,current.shop);}catch{return res.status(403).json({error:'INSTALLATION_NOT_ACTIVE'});}
      try{verifyCurrentShopifySession(current,verified.evidence);}catch{return res.status(401).json({error:'UNAUTHENTICATED'});}
      res.locals.shopify.installationTenant=verified.tenant;
      return next();
    } catch (error) { return next(error); }
  };
}

/**
 * Wraps shopify.validateAuthenticatedSession() with fail-closed validation of
 * the resolved session object and shop domain. Browser-supplied ?shop= query
 * parameters or headers are never used as tenant authority.
 */
export function createShopifyAuthMiddleware({ shopify } = {}) {
  if (typeof shopify?.validateAuthenticatedSession !== "function") {
    throw new TypeError(
      "shopify.validateAuthenticatedSession() is required",
    );
  }

  const validateSession = shopify.validateAuthenticatedSession();
  if (typeof validateSession !== "function") {
    throw new TypeError(
      "shopify.validateAuthenticatedSession() must return an Express middleware function",
    );
  }

  return function shopifyAuthMiddleware(req, res, next) {
    verifiedRequests.delete(req);
    validateSession(req, res, (error) => {
      if (error) return next(error);
      if (res.headersSent) return undefined;

      const session = res.locals?.shopify?.session;
      if (!isValidShopifySession(session)) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }

      let identity,evidence;
      try { evidence=shopifySessionEvidence(session);identity=tenantIdentity(session); }
      catch {return res.status(401).json({error:'UNAUTHORIZED'});}
      verifiedRequests.set(req, { session, shop: session.shop, id: session.id, identity,evidence });
      return next();
    });
  };
}

/**
 * Provides the WeakMap-backed session authentication service used by both
 * HTTP filter/catalog routes and createFilterEngine({ authenticatedSessionService }).
 */
export function createAuthenticatedSessionService({ sessionStorage,resolveInstallation } = {}) {
  const filterAuth = createFilterAuthentication({ sessionStorage,resolveInstallation });

  return Object.freeze({
    ...filterAuth,
    async requireAuthenticatedShop(authContext) {
      if (!authContext || typeof authContext !== "object") {
        throw new FieldError(
          C.PERMISSION_DENIED,
          "Authenticated session context required",
        );
      }
      const session = await filterAuth.resolveSession(authContext);
      const tenant=await filterAuth.resolveTenant(authContext);
      return Object.freeze({
        shopId: session.shop,
        installationId:tenant.installationId,
        installationVersion:tenant.installationVersion,
        sessionId: session.id,
        scope: typeof session.scope === "string" ? session.scope : "",
      });
    },
  });
}

export { createFilterAuthentication };
export default createShopifyAuthMiddleware;

