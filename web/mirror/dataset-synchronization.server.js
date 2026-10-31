import { createHash } from "node:crypto";
import {
  invalid,
  shop,
  token,
  integer,
  runLease,
  transaction,
} from "./transactions.server.js";

// --- VALIDATION FUNCTIONS ---

export function validateInventoryItems(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty inventory item records required");
  }
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    if (
      typeof gid !== "string" ||
      !/^gid:\/\/shopify\/InventoryItem\/[1-9][0-9]*$/.test(gid)
    ) {
      invalid("Invalid inventory item Shopify GID");
    }
    if (typeof r.tracked !== "boolean") {
      invalid("Inventory item tracked status required");
    }
    if (typeof r.requiresShipping !== "boolean") {
      invalid("Inventory item requiresShipping status required");
    }
    if (r.unitCost !== undefined && r.unitCost !== null) {
      if (typeof r.unitCost !== "string" && typeof r.unitCost !== "number") {
        invalid("Invalid unitCost value");
      }
    }
  }
}

export function validateLocations(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty location records required");
  }
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    if (
      typeof gid !== "string" ||
      !/^gid:\/\/shopify\/Location\/[1-9][0-9]*$/.test(gid)
    ) {
      invalid("Invalid location Shopify GID");
    }
    if (typeof r.name !== "string" || !r.name.trim()) {
      invalid("Location name required");
    }
    if (typeof r.active !== "boolean") {
      invalid("Location active status required");
    }
  }
}

export function validateInventoryLevels(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty inventory level records required");
  }
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    if (typeof gid !== "string" || !gid.trim()) {
      invalid("Inventory level shopifyId required");
    }
    if (!r.inventoryItemId && !r.inventoryItemShopifyId) {
      invalid("Inventory item reference required");
    }
    if (!r.locationId && !r.locationShopifyId) {
      invalid("Location reference required");
    }
  }
}

export function validateCollections(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty collection records required");
  }
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    if (
      typeof gid !== "string" ||
      !/^gid:\/\/shopify\/Collection\/[1-9][0-9]*$/.test(gid)
    ) {
      invalid("Invalid collection Shopify GID");
    }
    if (typeof r.title !== "string" || !r.title.trim()) {
      invalid("Collection title required");
    }
    if (typeof r.handle !== "string") {
      invalid("Collection handle required");
    }
  }
}

export function validateCollectionMemberships(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty collection membership records required");
  }
  for (const r of records) {
    if (!r.collectionId && !r.collectionShopifyId) {
      invalid("Collection reference required");
    }
    if (!r.productId && !r.productShopifyId) {
      invalid("Product reference required");
    }
  }
}

export function validateProductOptions(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty product option records required");
  }
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    if (
      typeof gid !== "string" ||
      !/^gid:\/\/shopify\/ProductOption\/[1-9][0-9]*$/.test(gid)
    ) {
      invalid("Invalid product option Shopify GID");
    }
    if (!r.productId && !r.productShopifyId) {
      invalid("Product reference required");
    }
    if (typeof r.name !== "string" || !r.name.trim()) {
      invalid("Option name required");
    }
    if (!Array.isArray(r.values)) {
      invalid("Option values array required");
    }
  }
}

export function validateMetafieldValues(records) {
  if (!Array.isArray(records) || records.length === 0) {
    invalid("Non-empty metafield value records required");
  }
  const VALID_TYPES = new Set([
    "string",
    "boolean",
    "integer",
    "decimal",
    "date",
    "datetime",
    "string_list",
    "json",
  ]);
  for (const r of records) {
    if (!r.definitionId) {
      invalid("Metafield definitionId required");
    }
    if (typeof r.definitionToken !== "string" || !r.definitionToken) {
      invalid("Metafield definitionToken required");
    }
    if (r.ownerEntity !== "product" && r.ownerEntity !== "variant") {
      invalid("Metafield ownerEntity must be product or variant");
    }
    if (r.ownerEntity === "product" && !r.productId && !r.productShopifyId) {
      invalid("Product owner reference required");
    }
    if (r.ownerEntity === "variant" && !r.variantId && !r.variantShopifyId) {
      invalid("Variant owner reference required");
    }
    if (!VALID_TYPES.has(r.valueType)) {
      invalid(`Invalid metafield valueType: ${r.valueType}`);
    }
  }
}

// --- WRITER FUNCTIONS ---

export async function writeInventoryItems({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateInventoryItems(records);

  for (const r of records) {
    const gid = r.id || r.shopifyId;
    const unitCost =
      r.unitCost !== undefined && r.unitCost !== null
        ? String(r.unitCost)
        : null;

    await client.query(
      `INSERT INTO mirror.inventory_items (
        shop_id, generation_id, shopify_id, sku, tracked, requires_shipping,
        unit_cost, currency_code, country_code_of_origin, harmonized_system_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
        sku = EXCLUDED.sku,
        tracked = EXCLUDED.tracked,
        requires_shipping = EXCLUDED.requires_shipping,
        unit_cost = EXCLUDED.unit_cost,
        currency_code = EXCLUDED.currency_code,
        country_code_of_origin = EXCLUDED.country_code_of_origin,
        harmonized_system_code = EXCLUDED.harmonized_system_code`,
      [
        shopId,
        generationId,
        gid,
        r.sku ?? null,
        Boolean(r.tracked),
        Boolean(r.requiresShipping),
        unitCost,
        r.currencyCode ?? null,
        r.countryCodeOfOrigin ?? null,
        r.harmonizedSystemCode ?? null,
      ],
    );
  }
}

export async function writeLocations({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateLocations(records);

  for (const r of records) {
    const gid = r.id || r.shopifyId;
    await client.query(
      `INSERT INTO mirror.locations (
        shop_id, generation_id, shopify_id, name, active
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
        name = EXCLUDED.name,
        active = EXCLUDED.active`,
      [shopId, generationId, gid, r.name, Boolean(r.active)],
    );
  }
}

export async function writeInventoryLevels({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateInventoryLevels(records);

  for (const r of records) {
    const gid = r.id || r.shopifyId;
    const invItemId = r.inventoryItemId ?? null;
    const invItemGid = r.inventoryItemShopifyId ?? null;
    const locId = r.locationId ?? null;
    const locGid = r.locationShopifyId ?? null;

    const available = BigInt(r.available ?? 0);
    const onHand = BigInt(r.onHand ?? 0);
    const committed = BigInt(r.committed ?? 0);
    const incoming = BigInt(r.incoming ?? 0);

    await client.query(
      `INSERT INTO mirror.inventory_levels (
        shop_id, generation_id, shopify_id, inventory_item_id, location_id,
        available, on_hand, committed, incoming
      ) VALUES (
        $1, $2, $3,
        COALESCE($4, (SELECT id FROM mirror.inventory_items WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$5)),
        COALESCE($6, (SELECT id FROM mirror.locations WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$7)),
        $8, $9, $10, $11
      )
      ON CONFLICT (shop_id, generation_id, inventory_item_id, location_id) DO UPDATE SET
        shopify_id = EXCLUDED.shopify_id,
        available = EXCLUDED.available,
        on_hand = EXCLUDED.on_hand,
        committed = EXCLUDED.committed,
        incoming = EXCLUDED.incoming`,
      [
        shopId,
        generationId,
        gid,
        invItemId,
        invItemGid,
        locId,
        locGid,
        available.toString(),
        onHand.toString(),
        committed.toString(),
        incoming.toString(),
      ],
    );
  }
}

export async function writeCollections({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateCollections(records);

  const nowIso = new Date().toISOString();
  for (const r of records) {
    const gid = r.id || r.shopifyId;
    const updatedAt = r.updatedAt || nowIso;

    await client.query(
      `INSERT INTO mirror.collections (
        shop_id, generation_id, shopify_id, title, handle, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
        title = EXCLUDED.title,
        handle = EXCLUDED.handle,
        updated_at = EXCLUDED.updated_at`,
      [shopId, generationId, gid, r.title, r.handle, updatedAt],
    );
  }
}

export async function writeCollectionMemberships({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateCollectionMemberships(records);

  for (const r of records) {
    const colId = r.collectionId ?? null;
    const colGid = r.collectionShopifyId ?? null;
    const prodId = r.productId ?? null;
    const prodGid = r.productShopifyId ?? null;

    await client.query(
      `INSERT INTO mirror.product_collections (
        shop_id, generation_id, collection_id, product_id
      ) VALUES (
        $1, $2,
        COALESCE($3, (SELECT id FROM mirror.collections WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$4)),
        COALESCE($5, (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$6))
      )
      ON CONFLICT (shop_id, generation_id, collection_id, product_id) DO NOTHING`,
      [shopId, generationId, colId, colGid, prodId, prodGid],
    );
  }
}

export async function writeProductOptions({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateProductOptions(records);

  for (const r of records) {
    const gid = r.id || r.shopifyId;
    const prodId = r.productId ?? null;
    const prodGid = r.productShopifyId ?? null;
    const position = BigInt(r.position ?? 1);

    await client.query(
      `INSERT INTO mirror.product_options (
        shop_id, generation_id, shopify_id, product_id, name, position, values
      ) VALUES (
        $1, $2, $3,
        COALESCE($4, (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$5)),
        $6, $7, $8
      )
      ON CONFLICT (shop_id, generation_id, shopify_id) DO UPDATE SET
        name = EXCLUDED.name,
        position = EXCLUDED.position,
        values = EXCLUDED.values`,
      [
        shopId,
        generationId,
        gid,
        prodId,
        prodGid,
        r.name,
        position.toString(),
        r.values ?? [],
      ],
    );
  }
}

export async function writeMetafieldValues({
  client,
  shopId,
  generationId,
  records,
}) {
  shop(shopId);
  token(generationId);
  validateMetafieldValues(records);

  for (const r of records) {
    const isProd = r.ownerEntity === "product";
    const prodId = isProd ? (r.productId ?? null) : null;
    const prodGid = isProd ? (r.productShopifyId ?? null) : null;
    const varId = !isProd ? (r.variantId ?? null) : null;
    const varGid = !isProd ? (r.variantShopifyId ?? null) : null;

    const isNull = Boolean(r.isNull);
    const textVal = r.valueType === "string" && !isNull ? String(r.value) : null;
    const boolVal =
      r.valueType === "boolean" && !isNull ? Boolean(r.value) : null;
    const intVal =
      r.valueType === "integer" && !isNull ? BigInt(r.value).toString() : null;
    const decVal =
      r.valueType === "decimal" && !isNull ? String(r.value) : null;
    const dateVal =
      r.valueType === "date" && !isNull ? String(r.value) : null;
    const dtVal =
      r.valueType === "datetime" && !isNull ? String(r.value) : null;
    const listVal =
      r.valueType === "string_list" && !isNull && Array.isArray(r.value)
        ? r.value
        : [];
    const jsonVal =
      r.valueType === "json" && !isNull && r.value !== undefined
        ? JSON.stringify(r.value)
        : null;

    if (isProd) {
      await client.query(
        `INSERT INTO mirror.metafield_values (
          shop_id, generation_id, product_id, variant_id, definition_id, owner_entity,
          definition_token, value_type, is_null, text_value, boolean_value, integer_value,
          decimal_value, date_value, datetime_value, string_list_value, json_value
        ) VALUES (
          $1, $2,
          COALESCE($3, (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$4)),
          NULL, $5, 'product',
          $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT (shop_id, generation_id, product_id, definition_id) WHERE product_id IS NOT NULL DO UPDATE SET
          definition_token = EXCLUDED.definition_token,
          value_type = EXCLUDED.value_type,
          is_null = EXCLUDED.is_null,
          text_value = EXCLUDED.text_value,
          boolean_value = EXCLUDED.boolean_value,
          integer_value = EXCLUDED.integer_value,
          decimal_value = EXCLUDED.decimal_value,
          date_value = EXCLUDED.date_value,
          datetime_value = EXCLUDED.datetime_value,
          string_list_value = EXCLUDED.string_list_value,
          json_value = EXCLUDED.json_value`,
        [
          shopId,
          generationId,
          prodId,
          prodGid,
          r.definitionId,
          r.definitionToken,
          r.valueType,
          isNull,
          textVal,
          boolVal,
          intVal,
          decVal,
          dateVal,
          dtVal,
          listVal,
          jsonVal,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO mirror.metafield_values (
          shop_id, generation_id, product_id, variant_id, definition_id, owner_entity,
          definition_token, value_type, is_null, text_value, boolean_value, integer_value,
          decimal_value, date_value, datetime_value, string_list_value, json_value
        ) VALUES (
          $1, $2,
          NULL,
          COALESCE($3, (SELECT id FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$4)),
          $5, 'variant',
          $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT (shop_id, generation_id, variant_id, definition_id) WHERE variant_id IS NOT NULL DO UPDATE SET
          definition_token = EXCLUDED.definition_token,
          value_type = EXCLUDED.value_type,
          is_null = EXCLUDED.is_null,
          text_value = EXCLUDED.text_value,
          boolean_value = EXCLUDED.boolean_value,
          integer_value = EXCLUDED.integer_value,
          decimal_value = EXCLUDED.decimal_value,
          date_value = EXCLUDED.date_value,
          datetime_value = EXCLUDED.datetime_value,
          string_list_value = EXCLUDED.string_list_value,
          json_value = EXCLUDED.json_value`,
        [
          shopId,
          generationId,
          varId,
          varGid,
          r.definitionId,
          r.definitionToken,
          r.valueType,
          isNull,
          textVal,
          boolVal,
          intVal,
          decVal,
          dateVal,
          dtVal,
          listVal,
          jsonVal,
        ],
      );
    }
  }
}

// --- DATASET SYNCHRONIZATION SERVICE FACTORY ---

export function createDatasetSynchronizationService({ database, syncRunService }) {
  if (typeof database?.connect !== "function") {
    throw new TypeError("Database pool required");
  }
  if (!syncRunService || typeof syncRunService.recordCheckpoint !== "function") {
    throw new TypeError("Sync run service required");
  }

  const WRITERS = {
    inventory_items: writeInventoryItems,
    locations: writeLocations,
    inventory_levels: writeInventoryLevels,
    collections: writeCollections,
    collection_memberships: writeCollectionMemberships,
    product_options: writeProductOptions,
    metafields: writeMetafieldValues,
  };

  return Object.freeze({
    async syncDatasetBatch({
      client,
      shopId,
      generationId,
      runId,
      fence,
      dataset,
      ordinal,
      records,
    }) {
      const writer = WRITERS[dataset];
      if (!writer) {
        invalid(`Unsupported dataset for batch synchronization: ${dataset}`);
      }

      integer(ordinal, 0, 2147483647, "ordinal");
      const lineCount = records.length;
      const checksum = createHash("sha256")
        .update(JSON.stringify(records))
        .digest("hex");

      const runSync = async (c) => {
        await runLease(c, { shopId, generationId, runId, fence });

        // Checkpoint replay guard
        const checkpoint = (
          await c.query(
            `SELECT checksum, line_count FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2 AND ordinal=$3`,
            [shopId, runId, ordinal],
          )
        ).rows[0];

        if (checkpoint) {
          if (
            checkpoint.checksum !== checksum ||
            BigInt(checkpoint.line_count) !== BigInt(lineCount)
          ) {
            invalid("Resumed chunk input changed");
          }
          return { lineCount, replayed: true, checksum, dataset };
        }

        await writer({ client: c, shopId, generationId, records });
        await syncRunService.recordCheckpoint({
          client: c,
          shopId,
          runId,
          fence,
          ordinal,
          checksum,
          lineCount: BigInt(lineCount),
        });

        return {
          recordCount: records.length,
          lineCount,
          checksum,
          replayed: false,
          dataset,
        };
      };

      if (client) {
        return runSync(client);
      }
      return transaction(database, runSync);
    },

    async completeDatasetIngestion({
      client,
      shopId,
      runId,
      fence,
      expectedLines,
      processedLines,
      eofVerified = true,
    }) {
      const finish = async (c) => {
        return syncRunService.completeIngestionRun({
          client: c,
          shopId,
          runId,
          fence,
          expectedLines,
          processedLines,
          invalidLines: 0n,
          eofVerified,
        });
      };

      if (client) {
        return finish(client);
      }
      return transaction(database, finish);
    },
  });
}
