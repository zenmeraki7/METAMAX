import { graphql as requestGraphql } from "../../integrations/shopify/graphql.js";

import {
  GET_INVENTORY_ITEM,
  GET_INVENTORY_ITEM_VERSION,
  INVENTORY_PAGE_SIZE,
  INVENTORY_QUANTITY_NAMES,
} from "./inventory.queries.js";

const ITEM_ID = /^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/;

const LOCATION_ID = /^gid:\/\/shopify\/Location\/[1-9]\d*$/;

const SHOP = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

const MAX_PAGES = 100;
const INSERT_BATCH = 200;

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_INVENTORY_SNAPSHOT";
  return error;
}

function requireIdentity(shop, itemId) {
  if (
    typeof shop !== "string" ||
    !SHOP.test(shop) ||
    typeof itemId !== "string" ||
    !ITEM_ID.test(itemId)
  ) {
    throw new TypeError("Invalid inventory shop or item ID");
  }
}

function validDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function date(value) {
  if (!validDate(value)) {
    throw invalid("Invalid Shopify timestamp");
  }

  return new Date(value);
}

export async function requireTransaction(tx) {
  // Prisma 7 supports nested transactions, so $transaction can exist on both
  // root and transaction clients. PostgreSQL rejects SAVEPOINT outside BEGIN.
  // Probe without touching data; the caller still owns revision/lease fencing.
  try {
    await tx.$executeRaw`SAVEPOINT inventory_writer_transaction_check`;
    await tx.$executeRaw`RELEASE SAVEPOINT inventory_writer_transaction_check`;
  } catch (cause) {
    const details = `${cause?.message ?? ""} ${JSON.stringify(
      cause?.meta ?? {},
    )}`;
    if (
      !/25P01|SAVEPOINT can only be used in transaction blocks/.test(details)
    ) {
      // Preserve retryable database error codes for the caller's retry policy.
      throw cause;
    }
    throw new TypeError("An existing Prisma transaction is required", {
      cause,
    });
  }
}

function readItem(response) {
  if (
    response?.errors != null &&
    (!Array.isArray(response.errors) || response.errors.length > 0)
  ) {
    throw invalid("Shopify returned GraphQL errors");
  }

  const body =
    response && Object.hasOwn(response, "data") ? response.data : response;

  if (
    !body ||
    typeof body !== "object" ||
    !Object.hasOwn(body, "inventoryItem")
  ) {
    throw invalid("Missing inventoryItem response");
  }

  return body.inventoryItem;
}

export function validateItem(item, itemId) {
  if (
    !item ||
    item.id !== itemId ||
    !validDate(item.updatedAt) ||
    typeof item.tracked !== "boolean" ||
    typeof item.requiresShipping !== "boolean" ||
    (item.sku !== null && typeof item.sku !== "string")
  ) {
    throw invalid("Malformed inventory item");
  }
}

export function validateLevel(level) {
  if (
    !level ||
    typeof level.id !== "string" ||
    !level.id.startsWith("gid://shopify/InventoryLevel/") ||
    level.id.length <= "gid://shopify/InventoryLevel/".length ||
    /\s/.test(level.id) ||
    typeof level.isActive !== "boolean" ||
    !validDate(level.updatedAt)
  ) {
    throw invalid("Malformed inventory level");
  }

  const location = level.location;

  if (
    !location ||
    typeof location.id !== "string" ||
    !LOCATION_ID.test(location.id) ||
    typeof location.name !== "string" ||
    typeof location.isActive !== "boolean" ||
    typeof location.fulfillsOnlineOrders !== "boolean" ||
    !validDate(location.updatedAt)
  ) {
    throw invalid("Malformed inventory location");
  }

  if (!Array.isArray(level.quantities)) {
    throw invalid("Missing inventory quantities");
  }

  const names = new Set();

  for (const quantity of level.quantities) {
    if (
      !quantity ||
      typeof quantity.name !== "string" ||
      !quantity.name ||
      !Number.isSafeInteger(quantity.quantity) ||
      quantity.quantity < -2147483648 ||
      quantity.quantity > 2147483647 ||
      (quantity.updatedAt != null && !validDate(quantity.updatedAt)) ||
      names.has(quantity.name)
    ) {
      throw invalid("Malformed or duplicate inventory quantity");
    }

    names.add(quantity.name);
  }
  if (INVENTORY_QUANTITY_NAMES.some((name) => !names.has(name))) {
    throw invalid("Incomplete inventory quantities");
  }
}

/**
 * Fetch every inventory level for one item.
 *
 * This is one complete observation assembled
 * from multiple GraphQL requests, not an
 * atomic Shopify database snapshot.
 */
export function createInventoryService({ graphql = requestGraphql } = {}) {
  async function fetchInventoryItem(shop, itemId, context = {}) {
    requireIdentity(shop, itemId);
    context = {
      ...context,
      installation: {
        generation: context.generation ?? context.installation?.generation,
      },
      signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(180000),
    };
    async function request(query, variables, requestedCost) {
      context.signal.throwIfAborted();
      return graphql(shop, query, variables, { ...context, requestedCost });
    }

    let first = null;
    let after = null;

    const levels = [];
    const locations = new Set();
    const levelIds = new Set();
    const cursors = new Set();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const item = readItem(
        await request(
          GET_INVENTORY_ITEM,
          {
            id: itemId,
            after,
          },
          400,
        ),
      );

      if (item === null) {
        if (page > 0) {
          throw invalid("Inventory item disappeared during pagination");
        }

        const confirmed = readItem(
          await request(GET_INVENTORY_ITEM_VERSION, { id: itemId }, 10),
        );

        if (confirmed !== null) {
          throw invalid("Inventory item changed while confirming absence");
        }

        return null;
      }

      validateItem(item, itemId);

      if (!first) {
        first = item;
      } else if (item.updatedAt !== first.updatedAt) {
        throw invalid("Inventory item changed during pagination");
      }

      const connection = item.inventoryLevels;

      if (
        !connection ||
        !Array.isArray(connection.edges) ||
        connection.edges.length > INVENTORY_PAGE_SIZE ||
        typeof connection.pageInfo?.hasNextPage !== "boolean"
      ) {
        throw invalid("Malformed inventory pagination");
      }

      for (const edge of connection.edges) {
        const level = edge?.node;

        validateLevel(level);

        if (locations.has(level.location.id) || levelIds.has(level.id)) {
          throw invalid("Duplicate inventory level");
        }

        locations.add(level.location.id);
        levelIds.add(level.id);
        levels.push(level);
      }

      if (!connection.pageInfo.hasNextPage) {
        const finalItem = readItem(
          await request(GET_INVENTORY_ITEM_VERSION, { id: itemId }, 10),
        );

        if (
          !finalItem ||
          finalItem.id !== itemId ||
          finalItem.updatedAt !== first.updatedAt
        ) {
          throw invalid("Inventory item changed before verification");
        }

        return {
          item: first,
          levels,
        };
      }

      const next = connection.pageInfo.endCursor;

      if (
        connection.edges.length === 0 ||
        typeof next !== "string" ||
        !next ||
        next === after ||
        cursors.has(next)
      ) {
        throw invalid("Inventory cursor did not advance");
      }

      cursors.add(next);
      after = next;
    }

    throw invalid("Inventory location pagination exceeded limit");
  }
  return { fetchInventoryItem };
}

export const { fetchInventoryItem } = createInventoryService();

/**
 * The caller MUST provide a Prisma transaction
 * that has already:
 *
 * - locked the Shop publication boundary
 * - validated the inventory change revision
 * - validated lease ownership
 * - validated the expected snapshot generation
 *
 * The method is only an atomic writer.
 */
export async function writeInventoryItemSnapshot(
  tx,
  shop,
  snapshotId,
  itemId,
  current,
) {
  requireIdentity(shop, itemId);
  if (!tx || typeof tx.$executeRaw !== "function") {
    throw new TypeError("An existing Prisma transaction is required");
  }

  if (typeof snapshotId !== "string" || !snapshotId) {
    throw new TypeError("Invalid snapshot ID");
  }

  const identity = {
    shop,
    snapshotId,
    id: itemId,
  };

  // Foreign-key cascades remove that item's
  // levels and quantities atomically.
  if (current === null) {
    await requireTransaction(tx);
    await tx.inventoryItem.deleteMany({
      where: identity,
    });
    return;
  }

  if (
    !current ||
    current.item?.id !== itemId ||
    !Array.isArray(current.levels) ||
    current.levels.length > MAX_PAGES * INVENTORY_PAGE_SIZE
  ) {
    throw invalid("Incomplete inventory item snapshot");
  }

  const item = current.item;
  validateItem(item, itemId);
  const seen = new Set();
  const seenIds = new Set();

  const locations = new Map();
  const levels = [];
  const quantities = [];

  // Validate and construct all rows before
  // modifying any database records.
  for (const level of current.levels) {
    validateLevel(level);

    const location = level.location;

    if (seen.has(location.id) || seenIds.has(level.id)) {
      throw invalid("Repeated inventory location");
    }

    seen.add(location.id);
    seenIds.add(level.id);

    locations.set(location.id, {
      shop,
      snapshotId,
      id: location.id,
      name: location.name,
      isActive: location.isActive,
      fulfillsOnlineOrders: location.fulfillsOnlineOrders,
      sourceUpdatedAt: date(location.updatedAt),
    });

    levels.push({
      shop,
      snapshotId,
      inventoryItemId: itemId,
      locationId: location.id,
      shopifyLevelId: level.id,
      isActive: level.isActive,
      sourceUpdatedAt: date(level.updatedAt),
    });

    for (const quantity of level.quantities) {
      quantities.push({
        shop,
        snapshotId,
        inventoryItemId: itemId,
        locationId: location.id,
        name: quantity.name,
        quantity: quantity.quantity,
        sourceUpdatedAt:
          quantity.updatedAt == null ? null : date(quantity.updatedAt),
      });
    }
  }

  const itemData = {
    shop,
    snapshotId,
    id: itemId,
    sku: item.sku,
    tracked: item.tracked,
    requiresShipping: item.requiresShipping,
    sourceUpdatedAt: date(item.updatedAt),
  };

  await requireTransaction(tx);
  await tx.inventoryItem.upsert({
    where: {
      shop_snapshotId_id: identity,
    },

    create: itemData,

    update: {
      sku: itemData.sku,
      tracked: itemData.tracked,
      requiresShipping: itemData.requiresShipping,
      sourceUpdatedAt: itemData.sourceUpdatedAt,
    },
  });

  // Locations are shared by different items.
  // Create missing locations first.
  // All item writers lock shared locations in the same order.
  const locationRows = [...locations.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (let i = 0; i < locationRows.length; i += INSERT_BATCH) {
    await tx.inventoryLocation.createMany({
      data: locationRows.slice(i, i + INSERT_BATCH),
      skipDuplicates: true,
    });
  }

  // Prevent an older location observation
  // overwriting fresher shared metadata.
  for (const location of locationRows) {
    await tx.inventoryLocation.updateMany({
      where: {
        shop,
        snapshotId,
        id: location.id,
        sourceUpdatedAt: {
          lte: location.sourceUpdatedAt,
        },
      },

      data: {
        name: location.name,
        isActive: location.isActive,
        fulfillsOnlineOrders: location.fulfillsOnlineOrders,
        sourceUpdatedAt: location.sourceUpdatedAt,
      },
    });
  }

  // Replace the item's entire level set.
  // InventoryQuantity rows cascade on deletion.
  await tx.inventoryLevel.deleteMany({
    where: {
      shop,
      snapshotId,
      inventoryItemId: itemId,
    },
  });

  for (let i = 0; i < levels.length; i += INSERT_BATCH) {
    await tx.inventoryLevel.createMany({
      data: levels.slice(i, i + INSERT_BATCH),
    });
  }

  for (let i = 0; i < quantities.length; i += INSERT_BATCH) {
    await tx.inventoryQuantity.createMany({
      data: quantities.slice(i, i + INSERT_BATCH),
    });
  }
}
