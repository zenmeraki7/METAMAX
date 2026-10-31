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
import { isValidShopifySession } from "./session-validation.js";
export { SHOP_DOMAIN_PATTERN, isValidShopifyDomain, isValidShopifySession } from "./session-validation.js";

// Only this module can record successful Shopify request verification.
const verifiedRequests = new WeakMap();

export function requireVerifiedShopifySession(req, res, next) {
  const verified = verifiedRequests.get(req);
  const session = res.locals?.shopify?.session;
  if (!verified || session !== verified.session || session.shop !== verified.shop ||
      session.id !== verified.id || !isValidShopifySession(session)) {
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", retryable: false } });
  }
  return next();
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

      verifiedRequests.set(req, { session, shop: session.shop, id: session.id });
      return next();
    });
  };
}

/**
 * Provides the WeakMap-backed session authentication service used by both
 * HTTP filter/catalog routes and createFilterEngine({ authenticatedSessionService }).
 */
export function createAuthenticatedSessionService({ sessionStorage } = {}) {
  const filterAuth = createFilterAuthentication({ sessionStorage });

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
      return Object.freeze({
        shopId: session.shop,
        sessionId: session.id,
        scope: typeof session.scope === "string" ? session.scope : "",
      });
    },
  });
}

export { createFilterAuthentication };
export default createShopifyAuthMiddleware;

