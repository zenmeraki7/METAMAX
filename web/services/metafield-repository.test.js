import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMetafieldRepository } from "./metafield-repository.server.js";
import { createMetafieldAdapter } from "../fields/metafield-adapter.js";

const VALID_SHOP = "merchant-store.myshopify.com";
const DYNAMIC_FIELD_ID_1 = "product.metafield.m01234567";
const DYNAMIC_FIELD_ID_2 = "product.metafield.m89abcdef0";

function createSampleDbRow({
  shopId = VALID_SHOP,
  fieldId = DYNAMIC_FIELD_ID_1,
  shopifyDefinitionId = "gid://shopify/MetafieldDefinition/12345678",
  locatorId = "loc_sample_locator_123",
  namespace = "custom",
  key = "priority_tier",
  ownerEntity = "product",
  shopifyType = "single_line_text_field",
  label = "Priority Tier",
  definitionToken = "token_abcdef1234567890",
  status = "ACTIVE",
  definitionVerified = true,
  nullable = true,
  writable = false,
  mutationSupported = false,
  readerAdapterId = "metafieldReader",
  writerAdapterId = null,
  precision = null,
  scale = null,
  verifiedAt = new Date("2026-10-28T12:00:00.000Z"),
  verificationExpiresAt = new Date("2026-11-28T12:00:00.000Z"),
  constraints = null,
} = {}) {
  return {
    shopId,
    fieldId,
    status,
    definitionVerified,
    shopifyDefinitionId,
    locatorId,
    namespace,
    key,
    ownerEntity,
    shopifyOwnerType: ownerEntity === "variant" ? "PRODUCTVARIANT" : "PRODUCT",
    shopifyType,
    label,
    nullable,
    writable,
    mutationSupported,
    readerAdapterId,
    writerAdapterId,
    definitionToken,
    precision,
    scale,
    constraints,
    verifiedAt,
    verificationExpiresAt,
  };
}

describe("Metafield Repository", () => {
  describe("Repository Initialization", () => {
    test("requires an active database client with query method", () => {
      assert.throws(() => createMetafieldRepository({}), {
        name: "TypeError",
        message: /Active database pool or client required/,
      });
      assert.throws(() => createMetafieldRepository({ database: null }), {
        name: "TypeError",
      });
      assert.throws(() => createMetafieldRepository({ database: {} }), {
        name: "TypeError",
      });
    });
  });

  describe("findVerifiedDefinitions", () => {
    test("rejects invalid shop domain", async () => {
      const repo = createMetafieldRepository({ database: { query: async () => ({ rows: [] }) } });

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: "", fieldIds: [DYNAMIC_FIELD_ID_1] }),
        { code: "FIELD_INVALID_VALUE" }
      );

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: null, fieldIds: [DYNAMIC_FIELD_ID_1] }),
        { code: "FIELD_INVALID_VALUE" }
      );

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: "store\0", fieldIds: [DYNAMIC_FIELD_ID_1] }),
        { code: "FIELD_INVALID_VALUE" }
      );

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: "   leading-space.myshopify.com", fieldIds: [DYNAMIC_FIELD_ID_1] }),
        { code: "FIELD_INVALID_VALUE" }
      );
    });

    test("rejects empty, oversized, or invalid fieldIds batches", async () => {
      const repo = createMetafieldRepository({ database: { query: async () => ({ rows: [] }) } });

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: VALID_SHOP, fieldIds: [] }),
        { code: "FIELD_INVALID_VALUE" }
      );

      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: VALID_SHOP, fieldIds: "not-an-array" }),
        { code: "FIELD_INVALID_VALUE" }
      );

      // Rejects canonical field IDs (must be dynamic metafield format)
      await assert.rejects(
        () => repo.findVerifiedDefinitions({ shopId: VALID_SHOP, fieldIds: ["product.title"] }),
        { code: "FIELD_UNKNOWN_FIELD" }
      );

      // Rejects duplicate field IDs in batch
      await assert.rejects(
        () => repo.findVerifiedDefinitions({
          shopId: VALID_SHOP,
          fieldIds: [DYNAMIC_FIELD_ID_1, DYNAMIC_FIELD_ID_1],
        }),
        { code: "FIELD_INVALID_VALUE" }
      );
    });

    test("executes parameterized SQL query with strict tenant isolation", async () => {
      let executedQuery = null;
      let executedParams = null;

      const mockDb = {
        async query(sql, params) {
          executedQuery = sql.replace(/\s+/g, " ").trim();
          executedParams = params;
          return { rows: [createSampleDbRow()] };
        },
      };

      const repo = createMetafieldRepository({ database: mockDb });
      const records = await repo.findVerifiedDefinitions({
        shopId: VALID_SHOP,
        fieldIds: [DYNAMIC_FIELD_ID_1],
      });

      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].fieldId, DYNAMIC_FIELD_ID_1);
      assert.strictEqual(records[0].shopId, VALID_SHOP);

      // Verify tenant isolation parameterization: WHERE shop_id = $1 AND field_id = ANY($2::text[])
      assert.ok(executedQuery.includes("WHERE shop_id = $1"));
      assert.ok(executedQuery.includes("field_id = ANY($2::text[])"));
      assert.ok(executedQuery.includes("status = 'ACTIVE'"));
      assert.ok(executedQuery.includes("definition_verified = true"));
      assert.deepEqual(executedParams, [VALID_SHOP, [DYNAMIC_FIELD_ID_1]]);
    });

    test("formats Date timestamps to ISO strings and enforces writable invariants", async () => {
      const sampleRow = createSampleDbRow({
        writable: false,
        writerAdapterId: "metafieldWriter", // Inconsistent DB state: read-only but has writer id
        verifiedAt: new Date("2026-10-28T10:00:00.000Z"),
        verificationExpiresAt: new Date("2026-11-28T10:00:00.000Z"),
      });

      const repo = createMetafieldRepository({
        database: { async query() { return { rows: [sampleRow] }; } },
      });

      const records = await repo.findVerifiedDefinitions({
        shopId: VALID_SHOP,
        fieldIds: [DYNAMIC_FIELD_ID_1],
      });

      assert.strictEqual(typeof records[0].verifiedAt, "string");
      assert.strictEqual(records[0].verifiedAt, "2026-10-28T10:00:00.000Z");
      assert.strictEqual(typeof records[0].verificationExpiresAt, "string");
      assert.strictEqual(records[0].verificationExpiresAt, "2026-11-28T10:00:00.000Z");

      // Non-writable row must have null writerAdapterId
      assert.strictEqual(records[0].writable, false);
      assert.strictEqual(records[0].writerAdapterId, null);
    });

    test("findDefinitionById returns single record or null", async () => {
      const repo = createMetafieldRepository({
        database: {
          async query(sql, [shop, [fieldId]]) {
            if (fieldId === DYNAMIC_FIELD_ID_1) {
              return { rows: [createSampleDbRow({ fieldId })] };
            }
            return { rows: [] };
          },
        },
      });

      const found = await repo.findDefinitionById({ shopId: VALID_SHOP, fieldId: DYNAMIC_FIELD_ID_1 });
      assert.ok(found);
      assert.strictEqual(found.fieldId, DYNAMIC_FIELD_ID_1);

      const notFound = await repo.findDefinitionById({ shopId: VALID_SHOP, fieldId: DYNAMIC_FIELD_ID_2 });
      assert.strictEqual(notFound, null);
    });
  });

  describe("Integration with createMetafieldAdapter", () => {
    test("successfully resolves verified dynamic metafields through createMetafieldAdapter", async () => {
      const row1 = createSampleDbRow({
        fieldId: DYNAMIC_FIELD_ID_1,
        shopifyDefinitionId: "gid://shopify/MetafieldDefinition/111",
        locatorId: "loc_custom_priority_tier",
        namespace: "custom",
        key: "priority_tier",
      });
      const row2 = createSampleDbRow({
        fieldId: DYNAMIC_FIELD_ID_2,
        shopifyDefinitionId: "gid://shopify/MetafieldDefinition/222",
        locatorId: "loc_custom_release_date",
        namespace: "custom",
        key: "release_date",
        shopifyType: "date",
        label: "Release Date",
      });

      const repo = createMetafieldRepository({
        database: {
          async query() {
            return { rows: [row1, row2] };
          },
        },
      });

      const adapter = createMetafieldAdapter({
        repository: repo,
        clock: () => Date.parse("2026-10-28T15:00:00.000Z"),
      });

      const resolved = await adapter.resolveBatch({
        shopId: VALID_SHOP,
        fieldIds: [DYNAMIC_FIELD_ID_1, DYNAMIC_FIELD_ID_2],
      });

      assert.strictEqual(resolved.size, 2);

      const rec1 = resolved.get(DYNAMIC_FIELD_ID_1);
      assert.strictEqual(rec1.fieldId, DYNAMIC_FIELD_ID_1);
      assert.strictEqual(rec1.definition.type, "string");
      assert.strictEqual(rec1.source.adapterId, "metafieldReader");
      assert.strictEqual(rec1.source.definitionRevision, "token_abcdef1234567890");

      const rec2 = resolved.get(DYNAMIC_FIELD_ID_2);
      assert.strictEqual(rec2.fieldId, DYNAMIC_FIELD_ID_2);
      assert.strictEqual(rec2.definition.type, "date");
    });
  });

  describe("saveDefinition", () => {
    test("validates definition fields and performs parameterized upsert", async () => {
      let upsertQuery = null;
      let upsertValues = null;

      const mockDb = {
        async query(sql, values) {
          upsertQuery = sql.replace(/\s+/g, " ").trim();
          upsertValues = values;
          return { rows: [{ id: 42n, field_id: DYNAMIC_FIELD_ID_1, definition_token: "token_1234567890abcdef" }] };
        },
      };

      const repo = createMetafieldRepository({ database: mockDb });

      const result = await repo.saveDefinition({
        shopId: VALID_SHOP,
        fieldId: DYNAMIC_FIELD_ID_1,
        shopifyDefinitionId: "gid://shopify/MetafieldDefinition/999",
        locatorId: "loc_test_locator",
        ownerEntity: "product",
        namespace: "custom",
        key: "rating",
        shopifyType: "single_line_text_field",
        label: "Rating",
        definitionToken: "token_1234567890abcdef",
        writable: true,
      });

      assert.ok(result);
      assert.strictEqual(result.field_id, DYNAMIC_FIELD_ID_1);
      assert.ok(upsertQuery.includes("INSERT INTO mirror.metafield_definitions"));
      assert.ok(upsertQuery.includes("ON CONFLICT (shop_id, field_id) DO UPDATE"));
      assert.strictEqual(upsertValues[0], VALID_SHOP);
      assert.strictEqual(upsertValues[1], DYNAMIC_FIELD_ID_1);
      assert.strictEqual(upsertValues[14], true); // writable
      assert.strictEqual(upsertValues[15], true); // mutationSupported
      assert.strictEqual(upsertValues[17], "metafieldWriter"); // resolvedWriterAdapterId
    });

    test("rejects invalid Shopify GID or definition token", async () => {
      const repo = createMetafieldRepository({ database: { query: async () => ({ rows: [] }) } });

      await assert.rejects(
        () => repo.saveDefinition({
          shopId: VALID_SHOP,
          fieldId: DYNAMIC_FIELD_ID_1,
          shopifyDefinitionId: "invalid-gid",
          locatorId: "loc_test",
          ownerEntity: "product",
          namespace: "custom",
          key: "test",
          shopifyType: "single_line_text_field",
          label: "Test",
          definitionToken: "token_1234567890abcdef",
        }),
        { code: "FIELD_INVALID_VALUE" }
      );

      await assert.rejects(
        () => repo.saveDefinition({
          shopId: VALID_SHOP,
          fieldId: DYNAMIC_FIELD_ID_1,
          shopifyDefinitionId: "gid://shopify/MetafieldDefinition/999",
          locatorId: "loc_test",
          ownerEntity: "product",
          namespace: "custom",
          key: "test",
          shopifyType: "single_line_text_field",
          label: "Test",
          definitionToken: "short", // Token must be 16-256 chars
        }),
        { code: "FIELD_INVALID_VALUE" }
      );
    });
  });
});
