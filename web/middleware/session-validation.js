export const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopifyDomain(shop) {
  return typeof shop === "string" && shop.length <= 255 && SHOP_DOMAIN_PATTERN.test(shop);
}

export function isValidShopifySession(session, { requireCredentials = false } = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session) ||
      !isValidShopifyDomain(session.shop)) return false;
  for (const key of ["id", "accessToken"]) {
    if ((requireCredentials || session[key] !== undefined) &&
        (typeof session[key] !== "string" || session[key].trim().length === 0)) return false;
  }
  return session.expires == null ||
    (session.expires instanceof Date && Number.isFinite(session.expires.getTime()) &&
      session.expires.getTime() > Date.now());
}
