/** Only capture requests AFTER Shopify validateAuthenticatedSession middleware. */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { isValidShopifySession } from "./session-validation.js";

export function createFilterAuthentication({ sessionStorage } = {}) {
  if (typeof sessionStorage?.loadSession !== "function")
    throw new TypeError("Shopify session storage required");
  const requests = new WeakMap(),
    sessions = new WeakMap();
  const valid = session => isValidShopifySession(session, { requireCredentials: true });
  async function resolveSession(authContext) {
    const identity = authContext && sessions.get(authContext);
    if (!identity)
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Authenticated filter session required",
      );
    const stored = await sessionStorage.loadSession(identity.id);
    if (
      !valid(stored) ||
      stored.id !== identity.id ||
      stored.shop !== identity.shop
    ) {
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Filter session expired or revoked",
      );
    }
    return stored;
  }
  async function resolveShop(authContext) {
    return (await resolveSession(authContext)).shop;
  }
  return Object.freeze({
    capture(req, res, next) {
      const session = res.locals.shopify?.session;
      if (valid(session)) {
        const authContext = Object.freeze({});
        sessions.set(
          authContext,
          Object.freeze({ id: session.id, shop: session.shop }),
        );
        requests.set(req, authContext);
      }
      next();
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
  });
}
