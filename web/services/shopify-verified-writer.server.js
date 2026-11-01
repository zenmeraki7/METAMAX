
/**
 * METAMAX — Shopify Verified Writer V4
 *
 * File:
 * web/services/shopify-verified-writer.server.js
 *
 * Responsibilities:
 * - Shopify GraphQL reads and mutation transport
 * - Canonical value validation via existing Field Engine
 * - Exact resource identity and parent-product checks
 * - Durable dispatch-consumption verification
 * - Strict mutation response validation
 *
 * NOT responsible for:
 * - Tenant authentication
 * - Execution approval
 * - Dispatch-token consumption
 * - Retry decisions
 * - Edit History transitions
 * - Declaring durable VERIFIED completion
 *
 * Existing product transport API preserved:
 *   readProduct({shopId,resourceId,signal})
 *   applyMutation({
 *     shopId,resourceId,values,idempotencyKey,signal
 *   })
 *
 * Additional variant API:
 *   readVariant({shopId,resourceId,productId,signal})
 *   applyVariantMutation({
 *     shopId,resourceId,productId,
 *     values,idempotencyKey,signal
 *   })
 */

import {
  productUpdates,
} from "./operation-instructions.server.js";

import {
  normalizeWriteOperand,
  WRITE_OPERATIONS,
} from "../fields/constraints.js";

const PRODUCT_GID =
  /^gid:\/\/shopify\/Product\/[1-9]\d*$/;

const VARIANT_GID =
  /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;

const API_VERSION = "2026-07";

/**
 * Transport bindings, not canonical definitions.
 *
 * Product fields are validated by productUpdates().
 * Variant fields are validated by the Field Engine.
 *
 * The trusted composition root must also verify these
 * bindings against its approved field registry.
 */
const PRODUCT_BINDINGS = Object.freeze({
  title: "product.title",
  handle: "product.handle",
  descriptionHtml: "product.descriptionHtml",
  vendor: "product.vendor",
  productType: "product.productType",
  status: "product.status",
  tags: "product.tags",
  templateSuffix: "product.templateSuffix",
});

const VARIANT_BINDINGS = Object.freeze({
  price: "variant.price",
  compareAtPrice: "variant.compareAtPrice",
  taxable: "variant.taxable",
  inventoryPolicy: "variant.inventoryPolicy",
});

const QUERIES = Object.freeze({
  readProduct: `#graphql
    query MetamaxWriterReadProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        tags
        templateSuffix
      }
    }
  `,

  updateProduct: `#graphql
    mutation MetamaxWriterUpdateProduct(
      $product: ProductUpdateInput!
    ) {
      productUpdate(product: $product) {
        product {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          status
          tags
          templateSuffix
        }
        userErrors {
          field
          message
        }
      }
    }
  `,

  readVariant: `#graphql
    query MetamaxWriterReadVariant($id: ID!) {
      productVariant(id: $id) {
        id
        product { id }
        price
        compareAtPrice
        taxable
        inventoryPolicy
      }
    }
  `,

  updateVariant: `#graphql
    mutation MetamaxWriterUpdateVariant(
      $productId: ID!
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
        allowPartialUpdates: false
      ) {
        product { id }
        productVariants {
          id
          product { id }
          price
          compareAtPrice
          taxable
          inventoryPolicy
        }
        userErrors {
          field
          message
        }
      }
    }
  `,
});

export class ShopifyWriterError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ShopifyWriterError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ShopifyWriterError(code, message, details);
}

function requireCondition(condition, code, message) {
  if (!condition) fail(code, message ?? code);
}

function plain(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
  );
}

function ownData(value, key) {
  if (!plain(value)) return false;

  const descriptor =
    Object.getOwnPropertyDescriptor(value, key);

  return Boolean(
    descriptor &&
    Object.hasOwn(descriptor, "value")
  );
}

function assertShop(shopId, boundShopId) {
  requireCondition(
    typeof shopId === "string" &&
    shopId === boundShopId,
    "SHOP_BINDING_MISMATCH"
  );
}

function assertGid(value, kind) {
  const pattern = kind === "product"
    ? PRODUCT_GID
    : VARIANT_GID;

  requireCondition(
    typeof value === "string" && pattern.test(value),
    "RESOURCE_ID_INVALID"
  );
}

function assertSignal(signal) {
  requireCondition(
    signal === undefined ||
    (
      signal !== null &&
      typeof signal === "object" &&
      typeof signal.aborted === "boolean"
    ),
    "INVALID_ABORT_SIGNAL"
  );

  if (signal?.aborted) {
    fail("EXECUTION_ABORTED", "Execution was aborted");
  }
}

function copyObserved(source, bindings) {
  requireCondition(
    plain(source),
    "INVALID_SHOPIFY_RESOURCE"
  );

  const result = Object.create(null);

  for (const key of Object.keys(bindings)) {
    requireCondition(
      ownData(source, key),
      "OBSERVED_FIELD_MISSING",
      `Missing authoritative field: ${key}`
    );

    result[key] = source[key];
  }

  return result;
}

function normalizeVariantValues(values) {
  requireCondition(
    plain(values),
    "INVALID_VARIANT_VALUES"
  );

  const names = Object.keys(values);

  requireCondition(
    names.length > 0 &&
    names.length <= Object.keys(VARIANT_BINDINGS).length,
    "INVALID_VARIANT_FIELD_COUNT"
  );

  const result = Object.create(null);

  for (const name of names) {
    requireCondition(
      ownData(values, name) &&
      Object.hasOwn(VARIANT_BINDINGS, name),
      "UNSUPPORTED_VARIANT_FIELD"
    );

    result[name] = normalizeWriteOperand(
      VARIANT_BINDINGS[name],
      WRITE_OPERATIONS.SET,
      values[name]
    );
  }

  return Object.freeze(result);
}

function requireExactFields(actual, requested) {
  requireCondition(
    plain(actual),
    "INVALID_MUTATION_RESOURCE"
  );

  for (const name of Object.keys(requested)) {
    requireCondition(
      ownData(actual, name),
      "MUTATION_FIELD_MISSING"
    );
  }
}

function validateErrors(payload) {
  requireCondition(
    plain(payload) &&
    Array.isArray(payload.userErrors),
    "MUTATION_PAYLOAD_INVALID"
  );

  if (payload.userErrors.length !== 0) {
    fail(
      "SHOPIFY_USER_ERRORS",
      "Shopify rejected the requested mutation",
      payload.userErrors
    );
  }
}

/**
 * Creates a shop-bound transport.
 *
 * admin:
 *   Authenticated Admin GraphQL client.
 *
 * boundShopId:
 *   Authoritative shop identity from server auth.
 *
 * assertDispatchConsumed:
 *   Trusted repository-backed function.
 *   Must return true only when this exact handoff has
 *   already been consumed durably for the same
 *   installation, resource and mutation intent.
 *
 * assertFieldBindings:
 *   Trusted registry compatibility gate.
 *   Must reject incompatible field mappings.
 *
 * Neither callback may be supplied by HTTP input.
 */
export function createShopifyVerifiedWriter({
  admin,
  boundShopId,
  apiVersion,
  assertDispatchConsumed,
  assertFieldBindings,
} = {}) {
  requireCondition(
    typeof admin?.graphql === "function",
    "ADMIN_CLIENT_REQUIRED"
  );

  requireCondition(
    typeof boundShopId === "string" &&
    boundShopId.length > 0,
    "BOUND_SHOP_REQUIRED"
  );

  requireCondition(
    apiVersion === API_VERSION,
    "SHOPIFY_API_VERSION_MISMATCH"
  );

  requireCondition(
    typeof assertDispatchConsumed === "function",
    "DISPATCH_AUTHORITY_REQUIRED"
  );

  requireCondition(
    typeof assertFieldBindings === "function",
    "FIELD_REGISTRY_AUTHORITY_REQUIRED"
  );

  async function request(query, variables, signal, mutation) {
    assertSignal(signal);

    let response;

    try {
      response = await admin.graphql(query, {
        variables,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      fail(
        mutation
          ? "SHOPIFY_OUTCOME_UNKNOWN"
          : "SHOPIFY_READ_FAILED",
        "Shopify GraphQL transport failed",
        { cause: String(error?.message ?? error) }
      );
    }

    let body;

    try {
      body = await response.json();
    } catch {
      fail(
        mutation
          ? "SHOPIFY_OUTCOME_UNKNOWN"
          : "SHOPIFY_READ_FAILED",
        "Shopify response could not be decoded"
      );
    }

    if (!plain(body)) {
      fail(
        mutation
          ? "SHOPIFY_OUTCOME_UNKNOWN"
          : "SHOPIFY_INVALID_RESPONSE"
      );
    }

    if (
      ownData(body, "errors") &&
      (
        !Array.isArray(body.errors) ||
        body.errors.length > 0
      )
    ) {
      fail(
        mutation
          ? "SHOPIFY_OUTCOME_UNKNOWN"
          : "SHOPIFY_GRAPHQL_ERROR",
        "Shopify returned GraphQL errors",
        body.errors
      );
    }

    requireCondition(
      plain(body.data),
      mutation
        ? "SHOPIFY_OUTCOME_UNKNOWN"
        : "SHOPIFY_INVALID_RESPONSE"
    );

    return body.data;
  }

  async function assertBindings(kind, values) {
    const bindings = kind === "product"
      ? PRODUCT_BINDINGS
      : VARIANT_BINDINGS;

    const fieldIds = Object.keys(values).map(
      name => bindings[name]
    );

    requireCondition(
      fieldIds.every(
        fieldId => typeof fieldId === "string"
      ),
      "UNKNOWN_CANONICAL_FIELD"
    );

    const accepted = await assertFieldBindings({
      kind,
      fieldIds,
      bindings,
    });

    requireCondition(
      accepted === true,
      "FIELD_REGISTRY_CONTRACT_MISMATCH"
    );
  }

  async function dispatchAuthority({
    shopId,
    resourceId,
    productId,
    values,
    idempotencyKey,
  }) {
    requireCondition(
      typeof idempotencyKey === "string" &&
      idempotencyKey.length > 0 &&
      idempotencyKey.length <= 512,
      "DISPATCH_HANDOFF_REQUIRED"
    );

    const accepted = await assertDispatchConsumed({
      shopId,
      resourceId,
      productId,
      values,
      dispatchHandoffKey: idempotencyKey,
    });

    requireCondition(
      accepted === true,
      "DISPATCH_NOT_CONSUMED"
    );
  }

  async function readProduct({
    shopId,
    resourceId,
    signal,
  }) {
    assertShop(shopId, boundShopId);
    assertGid(resourceId, "product");

    const data = await request(
      QUERIES.readProduct,
      { id: resourceId },
      signal,
      false
    );

    requireCondition(
      plain(data.product) &&
      data.product.id === resourceId,
      "PRODUCT_ID_MISMATCH"
    );

    return Object.freeze({
      id: resourceId,
      ...copyObserved(data.product, PRODUCT_BINDINGS),
    });
  }

  async function applyMutation({
    shopId,
    resourceId,
    values,
    idempotencyKey,
    signal,
  }) {
    assertShop(shopId, boundShopId);
    assertGid(resourceId, "product");

    // Reuses existing strict product Field Engine policy.
    const normalized = productUpdates(values);

    await assertBindings("product", normalized);

    await dispatchAuthority({
      shopId,
      resourceId,
      productId: resourceId,
      values: normalized,
      idempotencyKey,
    });

    const data = await request(
      QUERIES.updateProduct,
      {
        product: {
          id: resourceId,
          ...normalized,
        },
      },
      signal,
      true
    );

    const payload = data.productUpdate;
    validateErrors(payload);

    requireCondition(
      plain(payload.product) &&
      payload.product.id === resourceId,
      "MUTATION_PRODUCT_ID_MISMATCH"
    );

    requireExactFields(payload.product, normalized);

    // Mutation acknowledgement, NOT verified final state.
    return Object.freeze({
      id: resourceId,
      ...copyObserved(
        payload.product,
        PRODUCT_BINDINGS
      ),
    });
  }

  async function readVariant({
    shopId,
    resourceId,
    productId,
    signal,
  }) {
    assertShop(shopId, boundShopId);
    assertGid(resourceId, "variant");
    assertGid(productId, "product");

    const data = await request(
      QUERIES.readVariant,
      { id: resourceId },
      signal,
      false
    );

    const variant = data.productVariant;

    requireCondition(
      plain(variant) &&
      variant.id === resourceId,
      "VARIANT_ID_MISMATCH"
    );

    requireCondition(
      variant.product?.id === productId,
      "VARIANT_PARENT_MISMATCH"
    );

    return Object.freeze({
      id: resourceId,
      productId,
      ...copyObserved(variant, VARIANT_BINDINGS),
    });
  }

  async function applyVariantMutation({
    shopId,
    resourceId,
    productId,
    values,
    idempotencyKey,
    signal,
  }) {
    assertShop(shopId, boundShopId);
    assertGid(resourceId, "variant");
    assertGid(productId, "product");

    const normalized = normalizeVariantValues(values);

    await assertBindings("variant", normalized);

    // Parent identity verified authoritatively
    // before mutation transport.
    await readVariant({
      shopId,
      resourceId,
      productId,
      signal,
    });

    await dispatchAuthority({
      shopId,
      resourceId,
      productId,
      values: normalized,
      idempotencyKey,
    });

    const data = await request(
      QUERIES.updateVariant,
      {
        productId,
        variants: [{
          id: resourceId,
          ...normalized,
        }],
      },
      signal,
      true
    );

    const payload = data.productVariantsBulkUpdate;
    validateErrors(payload);

    requireCondition(
      payload.product?.id === productId,
      "MUTATION_PRODUCT_ID_MISMATCH"
    );

    requireCondition(
      Array.isArray(payload.productVariants) &&
      payload.productVariants.length === 1,
      "MUTATION_VARIANT_COUNT_MISMATCH"
    );

    const variant = payload.productVariants[0];

    requireCondition(
      plain(variant) &&
      variant.id === resourceId &&
      variant.product?.id === productId,
      "MUTATION_VARIANT_ID_MISMATCH"
    );

    requireExactFields(variant, normalized);

    // Mutation acknowledgement only.
    return Object.freeze({
      id: resourceId,
      productId,
      ...copyObserved(variant, VARIANT_BINDINGS),
    });
  }

  return Object.freeze({
    readProduct,
    applyMutation,
    readVariant,
    applyVariantMutation,
  });
}
