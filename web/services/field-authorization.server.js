/**
 * METAMAX Field Authorization Service
 *
 * Enforces server-side authorization boundaries:
 * 1. Authenticated merchant identity matching.
 * 2. Installed shop verification (mirror.shops).
 * 3. Required Shopify scope enforcement (accessAnyOf, accessAllOf, entity write scopes).
 * 4. Field access permissions (read/write eligibility, mutationAdapterId).
 * 5. Intended operation validation (filter, bulk_edit, export, catalog).
 *
 * Never permits the browser to supply authorization decisions or bypass checks.
 */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { FIELD_SOURCES } from "../fields/sources.js";

const SHOP_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const READ_ONLY_OPERATIONS = Object.freeze(new Set([
  "filter",
  "export",
  "catalog",
  "audit",
  "preview",
]));

export const WRITE_OPERATIONS = Object.freeze(new Set([
  "bulk_edit",
  "scheduled_edit",
  "recurring_edit",
  "undo",
  "mutation",
  "import",
]));

export const ALL_SUPPORTED_OPERATIONS = Object.freeze(new Set([
  ...READ_ONLY_OPERATIONS,
  ...WRITE_OPERATIONS,
]));

export function validateShopDomain(shopId) {
  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    shopId.length > 255 ||
    shopId.trim() !== shopId ||
    /[\u0000-\u001f\u007f]/.test(shopId) ||
    !SHOP_REGEX.test(shopId)
  ) {
    throw new FieldError(C.PERMISSION_DENIED, "Valid authenticated shop domain required");
  }
}

export function createFieldAuthorizationService({
  database,
  sessionStorage,
  resolveShop,
  allowedOperations = null,
  getShopScopes = null,
  defaultScopes = null,
} = {}) {
  if (typeof database?.query !== "function" || typeof resolveShop !== "function" ||
      typeof getShopScopes !== "function" || defaultScopes !== null || sessionStorage !== undefined) {
    throw new TypeError("Merchant field authorization requires installed-shop storage, verified identity and a trusted current-scope resolver; scope defaults and session objects are unsupported");
  }
  const operationsAllowlist = allowedOperations ? new Set(allowedOperations) : null;

  /**
   * Helper to retrieve granted scopes for a shop.
   * Fails closed by returning an empty set if scopes cannot be verified.
   */
  async function resolveGrantedScopes(shopId, authContext) {
    try {
      // Backend capability: reload authenticated session/installation data on
      // every decision. Never read a caller's session or grant defaults.
      const scopes = await getShopScopes(shopId, authContext);
      if (await resolveShop(authContext) !== shopId) return new Set();
      const values = typeof scopes === "string" && scopes.length <= 16384 ? scopes.split(",").map(s => s.trim()) : scopes;
      if (!Array.isArray(values) || values.length > 256 || values.some(s => typeof s !== "string" || !/^[a-z][a-z0-9_]*$/.test(s))) return new Set();
      return new Set(values);
    } catch { return new Set(); }
  }

  return Object.freeze({
    /**
     * Implements the authorizeAccess contract required by createFieldService.
     * Returns true if and only if all authorization checks succeed; otherwise false.
     */
    async authorizeAccess({
      shopId,
      actor,
      authContext,
      access,
      operation,
      field,
      source,
      policy,
      verification,
      executionContext,
    } = {}) {
      // 1. Authenticated Merchant Identity
      try {
        validateShopDomain(shopId);
      } catch {
        return false;
      }

      // Merchant identity verification is mandatory, including read operations.
      {
        if (!authContext) {
          return false;
        }
        try {
          const resolved = await resolveShop(authContext);
          if (resolved !== shopId) {
            return false;
          }
        } catch {
          return false;
        }
      }

      // If actor has a shop identity, it must match shopId
      if (actor != null && typeof actor === "object") {
        const actorShop = actor.shopId || actor.shop;
        if (actorShop && actorShop !== shopId) {
          return false;
        }
      }

      // 2. Installed Status (mirror.shops)
      if (database && typeof database.query === "function") {
        try {
          const { rows } = await database.query(
            `SELECT id, uninstalled_at FROM mirror.shops WHERE id = $1`,
            [shopId]
          );
          if (rows.length === 0 || rows[0].uninstalled_at !== null) {
            return false;
          }
        } catch {
          return false;
        }
      }

      // 3. Intended Operation Validation
      if (typeof operation !== "string" || operation.length === 0) {
        return false;
      }

      if (!ALL_SUPPORTED_OPERATIONS.has(operation)) {
        return false;
      }

      if (operationsAllowlist && !operationsAllowlist.has(operation)) {
        return false;
      }

      if (access === "write") {
        // Write access is never permitted for read-only operations (e.g. filter, export, catalog)
        if (READ_ONLY_OPERATIONS.has(operation)) {
          return false;
        }
        if (!WRITE_OPERATIONS.has(operation)) {
          return false;
        }
        // Write operations require a valid executionContext with operationId
        if (!executionContext || typeof executionContext !== "object" || !executionContext.operationId) {
          return false;
        }
      }

      // 4. Field Access Permissions
      if (access !== "read" && access !== "write") {
        return false;
      }

      if (!field || typeof field !== "object" || !source || typeof source !== "object") {
        return false;
      }

      if (access === "write") {
        // Field must be writable and mutation adapter must be bound
        if (field.readOnly === true || field.editable === false) {
          return false;
        }
        if (!source.mutationAdapterId || typeof source.mutationAdapterId !== "string") {
          return false;
        }
      }

      const grantedScopes = await resolveGrantedScopes(shopId, authContext);
      if (grantedScopes.size === 0) return false;
      if (access === "read") {
        const canonical = FIELD_SOURCES[field.id];
        if (canonical === source && source.kind === "column") {
          // Fixed mappings are server-owned; dynamic adapter metadata cannot
          // impersonate one. Scope checks below still apply to every request.
          if (!grantedScopes.has("read_products") && !grantedScopes.has("write_products")) return false;
        } else if (!source.adapterId || typeof source.adapterId !== "string") {
          return false;
        }
      }

      // 5. Required Shopify Scopes Check
      // Verify source.accessAllOf
      if (Array.isArray(source.accessAllOf) && source.accessAllOf.length > 0) {
        for (const scope of source.accessAllOf) {
          if (!grantedScopes.has(scope)) {
            return false;
          }
        }
      }

      // Verify source.accessAnyOf
      if (Array.isArray(source.accessAnyOf) && source.accessAnyOf.length > 0) {
        const hasAny = source.accessAnyOf.some(scope => grantedScopes.has(scope));
        if (!hasAny) {
          return false;
        }
      }

      // If write access, ensure standard write scope for entity
      if (access === "write") {
        const entity = field.entity || (source.entity ?? "product");
        if (["product", "variant"].includes(entity) && !grantedScopes.has("write_products")) {
          return false;
        }
        if (entity === "inventory" && !grantedScopes.has("write_inventory")) {
          return false;
        }
      }

      return true;
    },
  });
}
