/**
 * METAMAX — Trusted Write-Domain Validation
 *
 * File: web/fields/write-domain.js
 *
 * Use for:
 * - Bulk edits
 * - CSV imports that modify Shopify data
 * - Scheduled edits
 * - Recurring edits
 * - Approved write jobs
 *
 * Do not use for filter operands or read-only exports.
 *
 * This module validates values. It does not
 * replace authentication, authorization, approval,
 * Shopify mutations, or post-write verification.
 */

import {
  FIELD_ERROR_CODES,
  FieldError,
  deepFreeze,
} from "./types.js";

import { validateFinalWriteValue, WRITE_OPERATIONS } from "./constraints.js";

import {
  NORMALIZE_LIMITS,
} from "./normalize.js";

// --------------------------------------------------
// 1. Trusted domain policy
// --------------------------------------------------

export const WRITE_DOMAIN_CONTRACT_VERSION = 2;

/**
 * Policy IDs must be registered server-side.
 *
 * No arbitrary policies, regexes, numeric bounds,
 * or field descriptors may come from the browser.
 *
 * Price and cost values use the shop's currency
 * as interpreted by the Shopify write adapter.
 *
 * There is intentionally no invented universal
 * Shopify maximum monetary amount.
 * Canonical precision/scale still apply.
 */

const CONTEXT_RULES = deepFreeze({
  NONE: "none",
  COMPARE_AT_NOT_BELOW_PRICE:
    "compare_at_not_below_price",
});

export const WRITE_CONTEXT_RULES = CONTEXT_RULES;

// --------------------------------------------------
// 2. Errors
// --------------------------------------------------

function invalid(fieldId, message) {
  throw new FieldError(
    FIELD_ERROR_CODES.INVALID_VALUE,
    message,
    { fieldId }
  );
}

function unsupported(fieldId) {
  throw new FieldError(
    FIELD_ERROR_CODES.UNSUPPORTED_OPERATION,
    "Field is not enabled for this write operation",
    { fieldId }
  );
}

// --------------------------------------------------
// 3. Exact decimal comparison
// --------------------------------------------------

/**
 * Operates only on normalized decimal strings.
 * No floating-point conversion is performed.
 */

function decimalParts(value) {
  if (
    typeof value !== "string" ||
    value.length > NORMALIZE_LIMITS.maxDecimalLength ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    throw new TypeError(
      "Expected normalized decimal string"
    );
  }

  const negative = value.startsWith("-");
  const unsigned = negative
    ? value.slice(1)
    : value;

  const [integer, fraction = ""] =
    unsigned.split(".");

  return {
    negative,
    integer,
    fraction,
  };
}

export function compareExactDecimals(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);

  const scale = Math.max(
    a.fraction.length,
    b.fraction.length
  );

  const toScaled = (parts) => {
    const digits =
      parts.integer +
      parts.fraction.padEnd(scale, "0");

    const magnitude = BigInt(digits);

    return parts.negative
      ? -magnitude
      : magnitude;
  };

  const x = toScaled(a);
  const y = toScaled(b);

  return x < y ? -1 : x > y ? 1 : 0;
}

// --------------------------------------------------
// 5. Public write normalization
// --------------------------------------------------

/**
 * Always resolve from canonical field ID.
 *
 * This prevents request-supplied field objects
 * from overriding type, precision, nullable,
 * and editable metadata.
 *
 * `value` is the requested write value.
 *
 * Shared constraints validate the supplied operation and its final value.
 * The operation defaults to SET; relative edits must pass their actual operation.
 * Mutation adapters must use normalizeSupportedWrite() to also enforce
 * their trusted field allowlist. Validate the final computed value for
 * arithmetic operations, not merely the incoming adjustment operand.
 */

export function normalizeWriteValue(
  fieldId,
  value,
  { operation = WRITE_OPERATIONS.SET } = {}
) {
  return validateFinalWriteValue(fieldId, operation, value);
}

// --------------------------------------------------
// 6. Optional contextual business validation
// --------------------------------------------------

/**
 * Validates final variant price state.
 *
 * This is a merchant/application business policy,
 * not a universal Shopify API rule.
 *
 * Only pass final, server-resolved values, never
 * partial browser payloads.
 */

export function validateVariantPriceState(
  state,
  {
    rule = CONTEXT_RULES.NONE,
  } = {}
) {
  if (
    rule !== CONTEXT_RULES.NONE &&
    rule !==
      CONTEXT_RULES.COMPARE_AT_NOT_BELOW_PRICE
  ) {
    throw new TypeError(
      "Unknown contextual pricing rule"
    );
  }

  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    throw new TypeError(
      "Invalid final price state"
    );
  }

  const price = normalizeWriteValue(
    "variant.price",
    state.price
  );

  const compareAtPrice = normalizeWriteValue(
    "variant.compareAtPrice",
    state.compareAtPrice
  );

  if (
    rule ===
      CONTEXT_RULES.COMPARE_AT_NOT_BELOW_PRICE &&
    compareAtPrice !== null &&
    compareExactDecimals(
      compareAtPrice,
      price
    ) < 0
  ) {
    invalid(
      "variant.compareAtPrice",
      "Compare-at price is below the selling price"
    );
  }

  return Object.freeze({
    price,
    compareAtPrice,
  });
}

// --------------------------------------------------
// 7. Trusted write authorization helper
// --------------------------------------------------

/**
 * Explicit allowlist for a particular write adapter.
 *
 * A valid canonical editable field is not
 * automatically supported by every Shopify
 * mutation or write operation.
 *
 * supportedFieldIds must come from trusted code.
 */

export function normalizeSupportedWrite(
  fieldId,
  value,
  supportedFieldIds,
  operation = WRITE_OPERATIONS.SET
) {
  if (
    !Array.isArray(supportedFieldIds) ||
    !supportedFieldIds.every(
      (id) => typeof id === "string"
    )
  ) {
    throw new TypeError(
      "Invalid trusted write allowlist"
    );
  }

  if (!supportedFieldIds.includes(fieldId)) {
    unsupported(fieldId);
  }

  return normalizeWriteValue(fieldId, value, { operation });
}

