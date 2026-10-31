import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {createFilterAuthentication} from "../middleware/filter-auth.server.js";
import {
  createFieldAuthorizationService as createMerchantFieldAuthorizationService,
  validateShopDomain,
  READ_ONLY_OPERATIONS,
  WRITE_OPERATIONS,
} from "./field-authorization.server.js";

const VALID_SHOP = "merchant-store.myshopify.com";
const OTHER_SHOP = "other-merchant.myshopify.com";

// Policy fixtures explicitly install trusted identity/storage dependencies.
// Production does not support defaultScopes or caller-supplied sessions.
function createFieldAuthorizationService({defaultScopes, ...options} = {}) {
  const service = createMerchantFieldAuthorizationService({
    database: createMockDatabase(), resolveShop: async ctx => ctx.shop,
    getShopScopes: async () => defaultScopes ?? [], ...options,
  });
  return {authorizeAccess: input => service.authorizeAccess({authContext: {shop: VALID_SHOP}, ...input})};
}

function createMockDatabase({ rows = [{ id: VALID_SHOP, uninstalled_at: null }] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows };
    },
  };
}

test("merchant authorization rejects optional identity, ambient sessions and default grants", () => {
  const options={database:createMockDatabase(),resolveShop:async()=>VALID_SHOP,getShopScopes:async()=>["read_products"]};
  for(const missing of ["database","resolveShop","getShopScopes"])assert.throws(()=>createMerchantFieldAuthorizationService({...options,[missing]:undefined}));
  for(const extra of [{defaultScopes:["write_products"]},{sessionStorage:{loadSession:async()=>({scope:"write_products"})}}])assert.throws(()=>createMerchantFieldAuthorizationService({...options,...extra}));
});

test("opaque merchant identity and current stored scopes are required on every decision", async () => {
  let stored={id:"merchant",shop:VALID_SHOP,scope:"read_products",accessToken:"secret"};
  const authentication=createFilterAuthentication({sessionStorage:{loadSession:async()=>stored}});
  const req={};authentication.capture(req,{locals:{shopify:{session:stored}}},()=>{});
  const context=await authentication.authenticate(req);
  const service=createMerchantFieldAuthorizationService({database:createMockDatabase(),resolveShop:authentication.resolveShop,
    getShopScopes:async(shop,auth)=>(await authentication.resolveSession(auth)).scope});
  const input={shopId:VALID_SHOP,authContext:context,access:"read",operation:"filter",field:{id:"product.title"},source:{adapterId:"reader",accessAnyOf:["read_products"]}};
  assert.equal(await service.authorizeAccess(input),true);
  for(const authContext of [null,{shop:VALID_SHOP},{session:{...stored,scope:"read_products,write_products"}},{system:true,shop:VALID_SHOP}])assert.equal(await service.authorizeAccess({...input,authContext}),false);
  assert.equal(await service.authorizeAccess({...input,shopId:OTHER_SHOP}),false);
  stored={...stored,scope:""};assert.equal(await service.authorizeAccess(input),false);
  stored={...stored,scope:"read_products"};assert.equal(await service.authorizeAccess(input),true);
  stored=null;assert.equal(await service.authorizeAccess(input),false);
});

describe("Field Authorization Service", () => {
  describe("validateShopDomain", () => {
    test("accepts valid myshopify.com domains", () => {
      assert.doesNotThrow(() => validateShopDomain("store.myshopify.com"));
      assert.doesNotThrow(() => validateShopDomain("store-123.myshopify.com"));
    });

    test("rejects invalid domains", () => {
      assert.throws(() => validateShopDomain(null));
      assert.throws(() => validateShopDomain(""));
      assert.throws(() => validateShopDomain("store.com"));
      assert.throws(() => validateShopDomain("-store.myshopify.com"));
      assert.throws(() => validateShopDomain("store.myshopify.com/path"));
      assert.throws(() => validateShopDomain("store.myshopify.com\0"));
    });
  });

  describe("Merchant Identity and Tenant Isolation", () => {
    test("rejects when shop domain is invalid", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products"],
      });
      const allowed = await auth.authorizeAccess({
        shopId: "invalid-shop",
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(allowed, false);
    });

    test("enforces resolveShop verification against authContext", async () => {
      const auth = createFieldAuthorizationService({
        resolveShop: async (ctx) => ctx.shop,
        defaultScopes: ["read_products"],
      });

      // Mismatch between authenticated session and target shop
      const denied = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        authContext: { shop: OTHER_SHOP },
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(denied, false);

      // Missing authContext when resolveShop is configured fails closed
      const noAuth = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        authContext: null,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(noAuth, false);

      // Matching authContext succeeds
      const approved = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        authContext: { shop: VALID_SHOP },
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(approved, true);
    });

    test("rejects actor shop mismatch", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products"],
      });

      const denied = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        actor: { shopId: OTHER_SHOP },
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(denied, false);
    });
  });

  describe("Installed Status Verification", () => {
    test("rejects uninstalled shop from mirror.shops", async () => {
      const db = createMockDatabase({
        rows: [{ id: VALID_SHOP, uninstalled_at: new Date() }],
      });
      const auth = createFieldAuthorizationService({
        database: db,
        defaultScopes: ["read_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(allowed, false);
      assert.strictEqual(db.queries.length, 1);
      assert.strictEqual(db.queries[0].params[0], VALID_SHOP);
    });

    test("rejects nonexistent shop in mirror.shops", async () => {
      const db = createMockDatabase({ rows: [] });
      const auth = createFieldAuthorizationService({
        database: db,
        defaultScopes: ["read_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(allowed, false);
    });

    test("fails closed if database query throws", async () => {
      const db = {
        async query() {
          throw new Error("Connection refused");
        },
      };
      const auth = createFieldAuthorizationService({
        database: db,
        defaultScopes: ["read_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(allowed, false);
    });
  });

  describe("Intended Operation & Access Mode", () => {
    test("rejects write access on read-only operations", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products", "write_products"],
      });

      for (const op of READ_ONLY_OPERATIONS) {
        const allowed = await auth.authorizeAccess({
          shopId: VALID_SHOP,
          access: "write",
          operation: op,
          executionContext: { operationId: "bulk-edit-01" },
          field: { id: "product.title", entity: "product", editable: true },
          source: {
            adapterId: "catalogReader",
            mutationAdapterId: "catalogWriter",
            accessAnyOf: ["read_products"],
          },
        });
        assert.strictEqual(allowed, false, `Expected write access to be rejected for read-only operation: ${op}`);
      }
    });

    test("rejects write access without executionContext operationId", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products", "write_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: null,
        field: { id: "product.title", entity: "product", editable: true },
        source: {
          adapterId: "catalogReader",
          mutationAdapterId: "catalogWriter",
          accessAnyOf: ["read_products"],
        },
      });
      assert.strictEqual(allowed, false);
    });

    test("rejects operations outside configured allowedOperations allowlist", async () => {
      const auth = createFieldAuthorizationService({
        allowedOperations: ["filter"],
        defaultScopes: ["read_products"],
      });

      const exportDenied = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "export",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(exportDenied, false);

      const filterAllowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: "catalogReader", accessAnyOf: ["read_products"] },
      });
      assert.strictEqual(filterAllowed, true);
    });
  });

  describe("Field Access Permissions & Writability", () => {
    test("rejects write access on read-only fields", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products", "write_products"],
      });

      const readOnlyField = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.id", entity: "product", readOnly: true },
        source: { adapterId: "catalogReader", mutationAdapterId: "catalogWriter" },
      });
      assert.strictEqual(readOnlyField, false);

      const nonEditableField = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.id", entity: "product", editable: false },
        source: { adapterId: "catalogReader", mutationAdapterId: "catalogWriter" },
      });
      assert.strictEqual(nonEditableField, false);
    });

    test("rejects write access when mutationAdapterId is missing", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products", "write_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.title", entity: "product", editable: true },
        source: { adapterId: "catalogReader", mutationAdapterId: null },
      });
      assert.strictEqual(allowed, false);
    });

    test("rejects read access when reader adapterId is missing", async () => {
      const auth = createFieldAuthorizationService({
        defaultScopes: ["read_products"],
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: { adapterId: null },
      });
      assert.strictEqual(allowed, false);
    });
  });

  describe("Shopify Scope Enforcement", () => {
    test("enforces accessAllOf scopes", async () => {
      const auth = createFieldAuthorizationService({
        getShopScopes: async () => ["read_products"],
      });

      // Field requires both read_products and read_inventory
      const denied = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "inventory.quantity", entity: "inventory" },
        source: {
          adapterId: "inventoryReader",
          accessAllOf: ["read_products", "read_inventory"],
        },
      });
      assert.strictEqual(denied, false);

      const authWithAll = createFieldAuthorizationService({
        getShopScopes: async () => ["read_products", "read_inventory"],
      });
      const allowed = await authWithAll.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "inventory.quantity", entity: "inventory" },
        source: {
          adapterId: "inventoryReader",
          accessAllOf: ["read_products", "read_inventory"],
        },
      });
      assert.strictEqual(allowed, true);
    });

    test("enforces accessAnyOf scopes", async () => {
      const auth = createFieldAuthorizationService({
        getShopScopes: async () => ["read_orders"],
      });

      // Field allows either read_products or read_catalog
      const denied = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: {
          adapterId: "catalogReader",
          accessAnyOf: ["read_products", "read_catalog"],
        },
      });
      assert.strictEqual(denied, false);

      const authWithAny = createFieldAuthorizationService({
        getShopScopes: async () => ["read_catalog"],
      });
      const allowed = await authWithAny.authorizeAccess({
        shopId: VALID_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: {
          adapterId: "catalogReader",
          accessAnyOf: ["read_products", "read_catalog"],
        },
      });
      assert.strictEqual(allowed, true);
    });

    test("enforces write_products scope for product write access", async () => {
      const authOnlyRead = createFieldAuthorizationService({
        getShopScopes: async () => ["read_products"],
      });

      const denied = await authOnlyRead.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.title", entity: "product", editable: true },
        source: {
          adapterId: "catalogReader",
          mutationAdapterId: "catalogWriter",
          accessAnyOf: ["read_products"],
        },
      });
      assert.strictEqual(denied, false);

      const authWithWrite = createFieldAuthorizationService({
        getShopScopes: async () => ["read_products", "write_products"],
      });
      const allowed = await authWithWrite.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.title", entity: "product", editable: true },
        source: {
          adapterId: "catalogReader",
          mutationAdapterId: "catalogWriter",
          accessAnyOf: ["read_products"],
        },
      });
      assert.strictEqual(allowed, true);
    });

    test("resolves scopes through a trusted storage callback", async () => {
      const mockSessionStorage = {
        async findSessionsByShop(shop) {
          if (shop === VALID_SHOP) {
            return [{ id: "sess-1", shop, scope: "read_products,write_products" }];
          }
          return [];
        },
      };

      const auth = createFieldAuthorizationService({
        getShopScopes: async shop => (await mockSessionStorage.findSessionsByShop(shop))[0]?.scope ?? "",
      });

      const allowed = await auth.authorizeAccess({
        shopId: VALID_SHOP,
        access: "write",
        operation: "bulk_edit",
        executionContext: { operationId: "edit-1" },
        field: { id: "product.title", entity: "product", editable: true },
        source: {
          adapterId: "catalogReader",
          mutationAdapterId: "catalogWriter",
          accessAnyOf: ["read_products"],
        },
      });
      assert.strictEqual(allowed, true);

      // Other shop with no stored session fails closed
      const denied = await auth.authorizeAccess({
        shopId: OTHER_SHOP,
        access: "read",
        operation: "filter",
        field: { id: "product.title", entity: "product" },
        source: {
          adapterId: "catalogReader",
          accessAnyOf: ["read_products"],
        },
      });
      assert.strictEqual(denied, false);
    });
  });
});
