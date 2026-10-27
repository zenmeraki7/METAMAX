import { prisma } from "../../db/client.js";
import { shopHash } from "../lifecycle/lifecycle.repository.js";
import { enableInventoryContract } from "../inventory/inventory.contract.js";
import {
  writeCurrentProduct,
  writeActiveSnapshotProduct,
} from "../products/products.service.js";

// Keep webhook requests short enough for Shopify to retry safely.
// Tune against observed Neon latency and your HTTP response deadline.
const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 750,
  timeout: 1500,
});

const MAX_ATTEMPTS = 2;
// Full worker writes are not subject to the webhook's short HTTP deadline.
const RECONCILIATION_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 1000,
  timeout: 10000,
});
const RETRY_DELAY_MS = 50;

const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

const RECEIPT_SELECT = {
  shop: true,
  topic: true,
  resourceId: true,
  eventId: true,
  payloadHash: true,
  triggeredAt: true,
  revision: true,
};

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function parseTriggeredAt(value) {
  if (
    !(value instanceof Date) &&
    (typeof value !== "string" || !ISO_TIMESTAMP.test(value))
  ) {
    throw new TypeError("triggeredAt must be an ISO-8601 timestamp or Date");
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("triggeredAt must be a valid timestamp");
  }

  return date;
}

function normalizeInput(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Webhook input is required");
  }

  const shop = requiredString(input.shop, "shop").toLowerCase();

  if (!SHOP_DOMAIN.test(shop)) {
    throw new TypeError("shop must be a valid myshopify.com domain");
  }

  return {
    id: requiredString(input.id, "id"),
    shop,
    topic: requiredString(input.topic, "topic"),
    productId: requiredString(input.productId, "productId"),
    eventId: requiredString(input.eventId, "eventId"),
    payloadHash: requiredString(input.payloadHash, "payloadHash"),
    triggeredAt: parseTriggeredAt(input.triggeredAt),
  };
}

function permanentError(message, code) {
  const error = new Error(message);

  error.code = code;
  error.statusCode = 409;
  error.retryable = false;

  return error;
}

function duplicateResult(existing, input) {
  const sameDelivery =
    existing.shop === input.shop &&
    existing.topic === input.topic &&
    existing.resourceId === input.productId &&
    existing.eventId === input.eventId &&
    existing.payloadHash === input.payloadHash &&
    existing.triggeredAt instanceof Date &&
    existing.triggeredAt.getTime() === input.triggeredAt.getTime();

  if (!sameDelivery) {
    throw permanentError(
      "Webhook delivery ID was reused with different delivery data",
      "WEBHOOK_ID_COLLISION"
    );
  }

  // The receipt must have committed its catalog
  // invalidation before it can be acknowledged
  // as an already-recorded delivery.
  if (existing.revision == null) {
    const error = new Error("Webhook receipt has no recorded catalog revision");

    error.code = "INCOMPLETE_WEBHOOK_RECEIPT";
    error.statusCode = 503;
    error.retryable = true;

    throw error;
  }

  return {
    duplicate: true,
    revision: existing.revision.toString(),
  };
}

async function persistWebhook(tx, input, inventory = false) {
  const ledger = inventory ? tx.inventoryChange : tx.catalogChange;
  const staging = inventory ? tx.snapshotInventoryChange : tx.snapshotChange;
  const field = inventory ? "inventoryItemId" : "productId";
  const identityKey = inventory ? "shop_inventoryItemId" : "shop_productId";
  const stageKey = inventory ? "runId_inventoryItemId" : "runId_productId";
  // Preserve the publication barrier.
  //
  // FOR SHARE allows concurrent webhook receipts.
  // It conflicts with snapshot publication's
  // FOR UPDATE lock on the same Shop row.
  //
  // Other code must maintain compatible lock ordering.
  const shops = await tx.$queryRaw`
    SELECT "activeRunId", "status"
    FROM "Shop"
    WHERE "domain" = ${input.shop}
    FOR SHARE
  `;

  if (shops.length !== 1 || shops[0].status !== "ACTIVE") {
    // A new installation may still be committing. Do not drop its delivery
    // based on a previous generation's terminal marker.
    const [{ locked }] =
      await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${input.shop}, 0)) AS locked`;
    if (locked) {
      const marker = await tx.installationState.findUnique({
        where: { shopHash: shopHash(input.shop) },
      });
      if (
        shops[0]?.status === "UNINSTALLED" ||
        ["UNINSTALLED", "REDACTED"].includes(marker?.status)
      ) {
        return {
          ignored: true,
          duplicate: false,
          revision: null,
          reason: "confirmed-uninstalled",
        };
      }
      const sessions = await tx.$queryRaw`SELECT "id" FROM "shopify_sessions"
        WHERE "id"=${`offline_${input.shop}`} AND "shop"=${
        input.shop
      } AND "accessToken" IS NOT NULL
        AND "accessToken" <> '' LIMIT 1`;
      const error = new Error(
        sessions.length || marker?.status === "ACTIVE"
          ? "Installed shop registration is missing; durable scanner repair is required"
          : "Shop installation registration is not committed yet"
      );
      error.code =
        sessions.length || marker?.status === "ACTIVE"
          ? "SHOP_REGISTRATION_MISSING"
          : "SHOP_REGISTRATION_PENDING";
      error.statusCode = 503;
      throw error;
    }
    const error = new Error("Installation registration is in progress");
    error.code = "SHOP_REGISTRATION_PENDING";
    error.statusCode = 503;
    throw error;
  }

  const now = new Date();

  // PostgreSQL INSERT ... ON CONFLICT DO NOTHING.
  //
  // Concurrent redeliveries cannot both claim
  // the same receipt ID.
  const receipt = await tx.webhookEvent.createMany({
    data: {
      id: input.id,
      shop: input.shop,
      topic: input.topic,
      resourceId: input.productId,
      eventId: input.eventId,
      payloadHash: input.payloadHash,
      triggeredAt: input.triggeredAt,

      // Existing schema semantics:
      // receipt recording completed, not mirror sync.
      status: "COMPLETED",
      processedAt: now,
    },

    skipDuplicates: true,
  });

  if (receipt.count === 0) {
    const existing = await tx.webhookEvent.findUnique({
      where: {
        id: input.id,
      },
      select: RECEIPT_SELECT,
    });

    if (!existing) {
      throw permanentError(
        "Webhook receipt conflicted with a unique constraint other than its ID",
        "WEBHOOK_UNIQUE_CONFLICT"
      );
    }

    return duplicateResult(existing, input);
  }

  if (receipt.count !== 1) {
    throw new Error("Unexpected webhook receipt insertion count");
  }

  // Increment only for a newly recorded delivery.
  //
  // revision: newest known invalidation.
  // appliedRevision: last safely reconciled revision.
  const change = await ledger.upsert({
    where: {
      [identityKey]: {
        shop: input.shop,
        [field]: input.productId,
      },
    },

    create: {
      shop: input.shop,
      [field]: input.productId,

      revision: 1n,
      appliedRevision: 0n,

      dirty: true,
      nextAttemptAt: now,
      lastError: null,
      attempts: 0,
      deadLetterAt: null,
    },

    update: {
      revision: {
        increment: 1n,
      },

      dirty: true,
      nextAttemptAt: now,
      lastError: null,
      attempts: 0,
      deadLetterAt: null,
    },

    select: {
      revision: true,
    },
  });

  // Track changes occurring while a snapshot is active.
  if (inventory) await enableInventoryContract(tx, input.shop);
  const runId = shops[0].activeRunId;

  if (runId != null) {
    await staging.upsert({
      where: {
        [stageKey]: {
          runId,
          [field]: input.productId,
        },
      },

      create: {
        runId,
        [field]: input.productId,
        revision: change.revision,
        dirty: true,
      },

      update: {
        revision: change.revision,
        dirty: true,
      },
    });
  }

  // Persist the revision against the exact delivery.
  // A failure rolls back all preceding writes.
  await tx.webhookEvent.update({
    where: {
      id: input.id,
    },

    data: {
      revision: change.revision,
    },
  });

  return {
    duplicate: false,
    revision: change.revision.toString(),
  };
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function recordProductWebhook(rawInput) {
  return recordResourceWebhook(rawInput);
}

export async function recordInventoryWebhook(rawInput) {
  if (
    typeof rawInput?.inventoryItemId !== "string" ||
    !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/.test(rawInput.inventoryItemId)
  )
    throw TypeError("Invalid inventory item GID");
  return recordResourceWebhook(
    { ...rawInput, productId: rawInput.inventoryItemId },
    true
  );
}

async function recordResourceWebhook(rawInput, inventory = false) {
  // The HTTP handler must verify Shopify HMAC
  // against the raw request body before calling here.
  //
  // The caller must supply Shopify's delivery ID,
  // not a newly generated random receipt ID.
  const input = normalizeInput(rawInput);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => persistWebhook(tx, input, inventory),
        TRANSACTION_OPTIONS
      );
    } catch (error) {
      // Prisma upserts on catalog/snapshot rows may
      // encounter a unique race during concurrent
      // first-time inserts.
      //
      // Do not mistake every P2002 for a duplicate
      // webhook delivery.
      if (error?.code === "P2002") {
        const existing = await prisma.webhookEvent.findUnique({
          where: {
            id: input.id,
          },

          select: RECEIPT_SELECT,
        });

        if (existing) {
          return duplicateResult(existing, input);
        }
      }

      const retryableDatabaseConflict =
        error?.code === "P2002" ||
        error?.code === "P2034" ||
        error?.code === "P2028" ||
        (error?.code === "P2010" && ["40001", "40P01"].includes(error.meta?.code));

      if (!retryableDatabaseConflict || attempt + 1 >= MAX_ATTEMPTS) {
        throw error;
      }

      await pause(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw new Error("Webhook receipt retry budget exhausted");
}

function normalizeReconciliationInput(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Reconciliation input is required");
  }

  const shop = requiredString(input.shop, "shop").toLowerCase();

  if (!SHOP_DOMAIN.test(shop)) {
    throw new TypeError("shop must be a valid myshopify.com domain");
  }

  const productId = requiredString(input.productId, "productId");

  if (
    input.observedRevision === undefined ||
    input.observedRevision === null ||
    (typeof input.observedRevision === "string" &&
      input.observedRevision.trim() === "")
  ) {
    throw new TypeError(
      "observedRevision must be a valid revision number, string, or BigInt"
    );
  }

  let revision;
  try {
    revision = BigInt(input.observedRevision);
  } catch {
    throw new TypeError(
      "observedRevision must be a valid BigInt representation"
    );
  }

  if (revision <= 0n) {
    throw new RangeError("observedRevision must be a positive revision");
  }

  if (!Object.hasOwn(input, "product") || input.product === undefined) {
    throw new TypeError(
      "A product object or explicit null deletion is required"
    );
  }

  return {
    shop,
    productId,
    revision,
    product: input.product,
    generation: requiredString(input.generation, "generation"),
    snapshotId: input.snapshotId,
    expectedSnapshotId: input.expectedSnapshotId,
    leaseToken:
      input.leaseToken == null
        ? null
        : requiredString(input.leaseToken, "leaseToken"),
  };
}

async function persistReconciliation(
  tx,
  {
    shop,
    productId,
    revision,
    product,
    generation,
    leaseToken,
    snapshotId,
    expectedSnapshotId,
  },
  writeReconciledProduct
) {
  const shops = await tx.$queryRaw`
      SELECT "status", "generation", "activeSnapshotId" FROM "Shop" WHERE "domain" = ${shop} FOR SHARE
    `;
  const targetSnapshotId =
    expectedSnapshotId !== undefined ? expectedSnapshotId : snapshotId;
  if (
    shops.length !== 1 ||
    shops[0].status !== "ACTIVE" ||
    shops[0].generation !== generation ||
    !shops[0].activeSnapshotId ||
    (targetSnapshotId !== undefined &&
      shops[0].activeSnapshotId !== targetSnapshotId)
  )
    return false;
  // A worker must never clear dirty just because its Shopify request succeeded.
  //
  // Use a conditional update matching the exact observed revision, where
  // appliedRevision is strictly less than this revision.
  // Use the database clock inside the conditional write. An expired worker
  // cannot acknowledge a revision even before another worker replaces its token.
  // Null-token compatibility writes require an entirely unleased ledger row.
  const applied = await tx.$executeRaw`UPDATE "CatalogChange"
    SET "appliedRevision"=${revision}, "dirty"=false, "nextAttemptAt"=NULL,
      "lastError"=NULL, "attempts"=0, "deadLetterAt"=NULL,
      "leaseToken"=NULL, "leasedUntil"=NULL, "waitingForSnapshot"=false,
      "updatedAt"=clock_timestamp()
    WHERE "shop"=${shop} AND "productId"=${productId}
      AND "revision"=${revision} AND "appliedRevision"<${revision} AND "dirty"=true
      AND "leaseToken" IS NOT DISTINCT FROM ${leaseToken}
      AND ((${leaseToken}::text IS NULL AND "leasedUntil" IS NULL)
        OR (${leaseToken}::text IS NOT NULL AND "leasedUntil">clock_timestamp()))`;
  if (applied !== 1) {
    // Newer revisions, lease owners or publication fences supersede this result.
    return false;
  }

  // Persist the reconciled mirror state using the SAME
  // transaction. Any failure must roll back the acknowledgment.
  // Handles deleted products as well.
  await writeReconciledProduct(tx, product, {
    snapshotId: shops[0].activeSnapshotId,
    generation,
  });

  return true;
}

export async function completeProductReconciliation(
  rawInput,
  writeReconciledProductFn
) {
  const writeReconciledProduct =
    typeof writeReconciledProductFn === "function"
      ? writeReconciledProductFn
      : typeof rawInput?.writeReconciledProduct === "function"
      ? rawInput.writeReconciledProduct
      : async (tx, product, context) => {
          const { shop, productId, revision } = input;
          if (product && Object.hasOwn(product, "product")) {
            await writeCurrentProduct(
              tx,
              shop,
              productId,
              revision,
              product,
              context
            );
            return;
          }
          if (product === null) {
            await writeActiveSnapshotProduct(
              tx,
              shop,
              context.snapshotId,
              productId,
              null,
              context.generation
            );
            await tx.productMirror.deleteMany({ where: { shop, productId } });
          } else {
            if (typeof product !== "object" || product.id !== productId) {
              throw new TypeError(
                "Fetched product does not match the requested product identity"
              );
            }
            await writeActiveSnapshotProduct(
              tx,
              shop,
              context.snapshotId,
              productId,
              product,
              context.generation
            );
            await tx.productMirror.upsert({
              where: { shop_productId: { shop, productId } },
              create: { shop, productId, revision, data: product },
              update: { revision, data: product },
            });
          }
        };

  const input = normalizeReconciliationInput(rawInput);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => persistReconciliation(tx, input, writeReconciledProduct),
        RECONCILIATION_TRANSACTION_OPTIONS
      );
    } catch (error) {
      const retryableDatabaseConflict =
        error?.code === "P2002" ||
        error?.code === "P2034" ||
        error?.code === "P2028" ||
        (error?.code === "P2010" && ["40001", "40P01"].includes(error.meta?.code));

      if (!retryableDatabaseConflict || attempt + 1 >= MAX_ATTEMPTS) {
        throw error;
      }

      await pause(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw new Error("Product reconciliation retry budget exhausted");
}

// Compatibility entry point for the worker's snapshot-change outcomes. All
// actual writes use the same revision/generation/token-fenced transaction above.
export async function commitCurrentProduct({
  shop,
  productId,
  token,
  revision,
  current,
  expectedSnapshotId,
  generation,
  writeReconciledProduct,
}) {
  expectedSnapshotId = requiredString(expectedSnapshotId, "expectedSnapshotId");
  const applied = await completeProductReconciliation(
    {
      shop,
      productId,
      leaseToken: token,
      observedRevision: revision,
      product: current,
      snapshotId: expectedSnapshotId,
      generation,
    },
    writeReconciledProduct
  );
  if (applied) return { status: "applied" };
  const merchant = await prisma.shop.findUnique({
    where: { domain: shop },
    select: { status: true, generation: true, activeSnapshotId: true },
  });
  if (merchant?.status !== "ACTIVE" || merchant.generation !== generation)
    return { status: "superseded" };
  if (!merchant.activeSnapshotId) return { status: "no_active_snapshot" };
  if (merchant.activeSnapshotId !== expectedSnapshotId) {
    const change = await prisma.catalogChange.findUnique({
      where: { shop_productId: { shop, productId } },
      select: { dirty: true, revision: true, leaseToken: true },
    });
    if (
      !change ||
      !change.dirty ||
      change.revision !== BigInt(revision) ||
      change.leaseToken !== token
    )
      return { status: "superseded" };
    return { status: "snapshot_changed" };
  }
  return { status: "superseded" };
}
