/**
 * METAMAX Metafield Repository
 *
 * Resolves dynamic metafields using trusted, shop-owned definitions from storage.
 * Enforces strict tenant isolation, verified statuses, expiration checks,
 * and immutable plain data records.
 *
 * Never constructs SQL identifiers from browser input or allows arbitrary column paths.
 */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import {
  validateMetafieldShop,
  validateDynamicMetafieldId,
  METAFIELD_DEFINITION_ID_PATTERN,
  METAFIELD_DEFINITION_TOKEN_PATTERN,
  METAFIELD_LOCATOR_PATTERN,
} from "../fields/metafield-identity.js";
import { SUPPORTED_METAFIELD_TYPES } from "../fields/metafield-adapter.js";

const MAX_BATCH_SIZE = 1000;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_$-][a-zA-Z0-9_$.-]{0,254}$/;
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function requireDatabase(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("Active database pool or client required");
  }
}

export function createMetafieldRepository({ database } = {}) {
  requireDatabase(database);

  return Object.freeze({
    /**
     * Resolves verified dynamic metafield definitions for an authenticated shop.
     * Complies with the createMetafieldAdapter repository contract.
     *
     * @param {Object} input
     * @param {string} input.shopId - Authenticated shop domain
     * @param {string[]} input.fieldIds - Array of dynamic metafield IDs (e.g. product.metafield.m01234567)
     * @returns {Promise<Array<Object>>} Dense array of verified definition records
     */
    async findVerifiedDefinitions({ shopId, fieldIds }) {
      validateMetafieldShop(shopId);

      if (!Array.isArray(fieldIds) || fieldIds.length === 0 || fieldIds.length > MAX_BATCH_SIZE) {
        throw new FieldError(C.INVALID_VALUE, "Valid fieldIds batch required");
      }

      // Validate each field ID format and check for duplicates in the request
      const validIds = [];
      const seen = new Set();
      for (const id of fieldIds) {
        const validated = validateDynamicMetafieldId(id);
        if (seen.has(validated)) {
          throw new FieldError(C.INVALID_VALUE, `Duplicate field ID in batch: ${id}`);
        }
        seen.add(validated);
        validIds.push(validated);
      }

      // Parameterized query using server-constant physical schema and column names.
      // Strict tenant isolation: WHERE shop_id = $1 is mandatory.
      const query = `
        SELECT 
          shop_id AS "shopId",
          field_id AS "fieldId",
          status,
          definition_verified AS "definitionVerified",
          shopify_definition_id AS "shopifyDefinitionId",
          locator_id AS "locatorId",
          namespace,
          key,
          owner_entity::text AS "ownerEntity",
          CASE WHEN owner_entity = 'variant' THEN 'PRODUCTVARIANT' ELSE 'PRODUCT' END AS "shopifyOwnerType",
          shopify_type AS "shopifyType",
          label,
          nullable,
          writable,
          mutation_supported AS "mutationSupported",
          COALESCE(reader_adapter_id, 'metafieldReader') AS "readerAdapterId",
          writer_adapter_id AS "writerAdapterId",
          definition_token AS "definitionToken",
          precision,
          scale,
          constraints,
          verified_at AS "verifiedAt",
          verification_expires_at AS "verificationExpiresAt"
        FROM mirror.metafield_definitions
        WHERE shop_id = $1 
          AND field_id = ANY($2::text[])
          AND status = 'ACTIVE'
          AND definition_verified = true
          AND (verification_expires_at IS NULL OR verification_expires_at > now())
        ORDER BY id ASC
      `;

      const { rows } = await database.query(query, [shopId, validIds]);

      // Map rows to plain objects matching ALLOWED_ROW_KEYS in metafield-adapter
      const records = [];
      for (const row of rows) {
        const isDecimal = row.shopifyType === "number_decimal";
        const isWritable = Boolean(row.writable);

        // Enforce ISO string formatting for timestamps required by validateVerification()
        const verifiedAt = row.verifiedAt instanceof Date 
          ? row.verifiedAt.toISOString() 
          : typeof row.verifiedAt === "string" 
            ? row.verifiedAt 
            : new Date().toISOString();

        const verificationExpiresAt = row.verificationExpiresAt instanceof Date 
          ? row.verificationExpiresAt.toISOString() 
          : typeof row.verificationExpiresAt === "string" 
            ? row.verificationExpiresAt 
            : new Date(Date.now() + 3600_000).toISOString();

        const record = Object.create(null);
        record.shopId = row.shopId;
        record.fieldId = row.fieldId;
        record.status = row.status;
        record.definitionVerified = Boolean(row.definitionVerified);
        record.shopifyDefinitionId = row.shopifyDefinitionId;
        record.locatorId = row.locatorId;
        record.namespace = row.namespace;
        record.key = row.key;
        record.ownerEntity = row.ownerEntity;
        record.shopifyOwnerType = row.shopifyOwnerType;
        record.shopifyType = row.shopifyType;
        record.label = row.label;
        record.nullable = Boolean(row.nullable);
        record.writable = isWritable;
        record.mutationSupported = isWritable ? Boolean(row.mutationSupported) : false;
        record.readerAdapterId = row.readerAdapterId;
        // If not writable, writerAdapterId must be null to comply with adapter invariants
        record.writerAdapterId = isWritable ? row.writerAdapterId : null;
        record.definitionToken = row.definitionToken;
        record.precision = isDecimal && row.precision != null ? Number(row.precision) : null;
        record.scale = isDecimal && row.scale != null ? Number(row.scale) : null;
        record.verifiedAt = verifiedAt;
        record.verificationExpiresAt = verificationExpiresAt;
        record.constraints = row.constraints || null;

        records.push(record);
      }

      return records;
    },

    /**
     * Finds a single definition by its unique field ID.
     */
    async findDefinitionById({ shopId, fieldId }) {
      const records = await this.findVerifiedDefinitions({ shopId, fieldIds: [fieldId] });
      return records[0] || null;
    },

    /**
     * Server-side upsert of a verified metafield definition into mirror.metafield_definitions.
     * Prevents browser input from bypassing definition constraints.
     */
    async saveDefinition({
      shopId,
      fieldId,
      shopifyDefinitionId,
      locatorId,
      ownerEntity,
      namespace,
      key,
      shopifyType,
      canonicalType = null,
      label,
      definitionToken,
      status = "ACTIVE",
      definitionVerified = true,
      nullable = true,
      writable = false,
      mutationSupported = null,
      readerAdapterId = "metafieldReader",
      writerAdapterId = null,
      precision = null,
      scale = null,
      constraints = null,
      verifiedAt = new Date(),
      verificationExpiresAt = new Date(Date.now() + 86400_000 * 30),
    }) {
      validateMetafieldShop(shopId);
      validateDynamicMetafieldId(fieldId);

      if (!["product", "variant"].includes(ownerEntity)) {
        throw new FieldError(C.INVALID_VALUE, "ownerEntity must be 'product' or 'variant'");
      }

      if (!METAFIELD_DEFINITION_ID_PATTERN.test(shopifyDefinitionId)) {
        throw new FieldError(C.INVALID_VALUE, "Invalid shopifyDefinitionId format");
      }

      if (!METAFIELD_LOCATOR_PATTERN.test(locatorId)) {
        throw new FieldError(C.INVALID_VALUE, "Invalid locatorId format");
      }

      if (!METAFIELD_DEFINITION_TOKEN_PATTERN.test(definitionToken)) {
        throw new FieldError(C.INVALID_VALUE, "Invalid definitionToken format");
      }

      if (!NAMESPACE_PATTERN.test(namespace) || !KEY_PATTERN.test(key)) {
        throw new FieldError(C.INVALID_VALUE, "Invalid namespace or key format");
      }

      if (!Object.hasOwn(SUPPORTED_METAFIELD_TYPES, shopifyType)) {
        throw new FieldError(C.INVALID_TYPE, `Unsupported shopifyType: ${shopifyType}`);
      }

      const inferredCanonicalType = canonicalType || SUPPORTED_METAFIELD_TYPES[shopifyType];

      const resolvedMutationSupported = mutationSupported != null 
        ? Boolean(mutationSupported) 
        : Boolean(writable);

      const resolvedWriterAdapterId = writable 
        ? (writerAdapterId || "metafieldWriter") 
        : null;

      const query = `
        INSERT INTO mirror.metafield_definitions (
          shop_id, field_id, shopify_definition_id, locator_id, owner_entity,
          namespace, key, shopify_type, canonical_type, label, definition_token,
          status, definition_verified, nullable, writable, mutation_supported,
          reader_adapter_id, writer_adapter_id, precision, scale, constraints,
          verified_at, verification_expires_at
        ) VALUES (
          $1, $2, $3, $4, $5::mirror."OwnerEntity",
          $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21,
          $22, $23
        )
        ON CONFLICT (shop_id, field_id) DO UPDATE SET
          shopify_definition_id = EXCLUDED.shopify_definition_id,
          locator_id = EXCLUDED.locator_id,
          label = EXCLUDED.label,
          definition_token = EXCLUDED.definition_token,
          status = EXCLUDED.status,
          definition_verified = EXCLUDED.definition_verified,
          nullable = EXCLUDED.nullable,
          writable = EXCLUDED.writable,
          mutation_supported = EXCLUDED.mutation_supported,
          reader_adapter_id = EXCLUDED.reader_adapter_id,
          writer_adapter_id = EXCLUDED.writer_adapter_id,
          precision = EXCLUDED.precision,
          scale = EXCLUDED.scale,
          constraints = EXCLUDED.constraints,
          verified_at = EXCLUDED.verified_at,
          verification_expires_at = EXCLUDED.verification_expires_at
        RETURNING id, field_id, definition_token
      `;

      const values = [
        shopId, fieldId, shopifyDefinitionId, locatorId, ownerEntity,
        namespace, key, shopifyType, inferredCanonicalType, label, definitionToken,
        status, definitionVerified, nullable, writable, resolvedMutationSupported,
        readerAdapterId, resolvedWriterAdapterId, precision, scale, constraints ? JSON.stringify(constraints) : null,
        verifiedAt, verificationExpiresAt,
      ];

      const { rows } = await database.query(query, values);
      return rows[0];
    },
  });
}
