import {FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
export const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopifyDomain(shop) {
  return typeof shop === "string" && shop.length <= 255 && SHOP_DOMAIN_PATTERN.test(shop);
}

// This validates server-loaded session data, not a browser-supplied authority.
// Credentials are mandatory for every consumer; callers cannot weaken policy.
export const SHOPIFY_SESSION_POLICY_VERSION = 'server-session-v3';
export function isValidShopifySession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session) ||
      !isValidShopifyDomain(session.shop)) return false;
  for (const key of ["id", "accessToken"]) {
    if (typeof session[key] !== "string" || session[key].trim().length === 0) return false;
  }
  if(session.isOnline!==undefined&&typeof session.isOnline!=='boolean')return false;
  if(session.isOnline===true&&session.expires==null)return false;
  return session.expires == null ||
    (session.expires instanceof Date && Number.isFinite(session.expires.getTime()) &&
      session.expires.getTime() > Date.now());
}

/** Storage/legacy validation above is not an identity-bearing authorization.
 * Protected requests require explicit online/offline classification and online
 * actor identity. Snapshot primitive evidence so in-place storage mutation
 * cannot rewrite the authenticated request's credential/actor baseline.
 */
export function shopifySessionEvidence(session) {
  if (!isValidShopifySession(session) || typeof session.isOnline !== 'boolean')
    throw new FieldError(C.PERMISSION_DENIED,'Verified Shopify identity required');
  let actorId;
  if (session.isOnline) {
    const id=session.onlineAccessInfo?.associated_user?.id;
    if (!(typeof id==='number'&&Number.isSafeInteger(id)&&id>0 || typeof id==='string'&&/^[1-9][0-9]*$/.test(id)&&id.length<=19&&BigInt(id)<=9223372036854775807n))
      throw new FieldError(C.PERMISSION_DENIED,'Verified Shopify user identity required');
    actorId=String(id);
  }
  return Object.freeze({shopId:session.shop,sessionId:session.id,identityKind:session.isOnline?'USER':'SHOP',...(actorId?{actorId}:{}),accessToken:session.accessToken});
}
export function verifyCurrentShopifySession(session, evidence) {
  const current=shopifySessionEvidence(session);
  if (!evidence || ['shopId','sessionId','identityKind','actorId','accessToken'].some(key=>current[key]!==evidence[key]))
    throw new FieldError(C.PERMISSION_DENIED,'Shopify session changed or revoked');
  return session;
}
