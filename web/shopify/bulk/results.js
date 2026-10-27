import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { assertCompleteBulkOperation } from "./queries.js";

const PRODUCT_GID_PREFIX = "gid://shopify/Product/";
const VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

const ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
  "storage.googleapis.com",
  "shopify.com",
]);

function createError(message, code) {
  const error = new Error(message);
  if (code) {
    error.code = code;
  }
  return error;
}

/**
 * Validate that a URL is safe to stream bulk results from.
 *
 * @param {string} urlStr
 * @returns {URL}
 */
export function validateBulkResultUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw createError("Invalid bulk result download URL", "INVALID_DOWNLOAD_URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !ALLOWED_DOWNLOAD_HOSTS.some(
      (host) =>
        parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    )
  ) {
    throw createError(
      "Unexpected bulk result download host",
      "UNTRUSTED_DOWNLOAD_HOST"
    );
  }

  return parsed;
}

/**
 * Stream lines from a completed bulk operation URL without buffering the file into memory.
 *
 * Invariant: A failed operation's partialDataUrl must never be treated as a complete catalog snapshot.
 *
 * @param {object|string} operationOrUrl - Bulk operation object or signed download URL.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl]
 * @returns {AsyncGenerator<string>}
 */
export async function* downloadBulkResult(
  operationOrUrl,
  { signal, fetchImpl = fetch } = {}
) {
  let targetUrl;

  if (typeof operationOrUrl === "string") {
    targetUrl = operationOrUrl;
  } else if (operationOrUrl && typeof operationOrUrl === "object") {
    targetUrl = assertCompleteBulkOperation(operationOrUrl);
  } else {
    throw createError(
      "A completed bulk operation or download URL is required",
      "INVALID_ARGUMENT"
    );
  }

  const validatedUrl = validateBulkResultUrl(targetUrl);

  const idle = new AbortController();
  const timeout = setTimeout(
    () => idle.abort(createError("Bulk result download stalled", "DOWNLOAD_TIMEOUT")),
    60000
  );
  timeout.unref?.();

  const downloadSignal = signal
    ? AbortSignal.any([signal, idle.signal])
    : idle.signal;

  let input;
  let reader;

  try {
    const response = await fetchImpl(validatedUrl, {
      signal: downloadSignal,
      redirect: "error",
    });

    if (!response.ok || !response.body) {
      throw createError(
        `Bulk download failed with status ${response.status}`,
        "DOWNLOAD_FAILED"
      );
    }

    timeout.refresh?.();

    input =
      typeof Readable.fromWeb === "function" && response.body?.getReader
        ? Readable.fromWeb(response.body)
        : Readable.from(response.body);

    reader = createInterface({ input, crlfDelay: Infinity });

    for await (const line of reader) {
      timeout.refresh?.();
      signal?.throwIfAborted();
      yield line;
    }
  } finally {
    clearTimeout(timeout);
    reader?.close();
    input?.destroy();
    idle.abort();
  }
}

/**
 * Parses a stream of JSONL lines into JavaScript objects one by one without memory buffering.
 *
 * @param {AsyncIterable<string>|Iterable<string>} lines
 * @param {object} [options]
 * @param {number} [options.maxLineLength] - Max allowed line bytes (default 32MB)
 * @param {AbortSignal} [options.signal]
 * @returns {AsyncGenerator<object>}
 */
export async function* streamJsonlRecords(
  lines,
  { signal, maxLineLength = 32 * 1024 * 1024 } = {}
) {
  for await (const line of lines) {
    signal?.throwIfAborted();

    if (typeof line !== "string" || !line.trim()) {
      continue;
    }

    if (line.length > maxLineLength) {
      throw createError("Oversized bulk JSONL line", "OVERSIZED_RECORD");
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw createError("Malformed JSON in bulk output", "MALFORMED_JSON");
    }

    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw createError("Bulk line parsed to non-object", "INVALID_RECORD");
    }

    yield record;
  }
}

/**
 * Streams grouped catalog products and their nested variants from JSONL lines or records.
 *
 * In Shopify bulk queries:
 * - A product root record has no `__parentId`.
 * - Nested variants have `__parentId` pointing to their product root's ID.
 *
 * This function processes lines sequentially and yields complete groups `{ product, variants }`
 * without holding more than the current group in memory.
 *
 * @param {AsyncIterable<string|object>|Iterable<string|object>} linesOrRecords
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {AsyncGenerator<{ product: object, variants: object[] }>}
 */
export async function* streamGroupedCatalog(
  linesOrRecords,
  { signal } = {}
) {
  let currentProduct = null;
  let currentVariants = [];

  const recordStream = (async function* () {
    for await (const item of linesOrRecords) {
      signal?.throwIfAborted();
      if (typeof item === "string") {
        if (!item.trim()) continue;
        if (item.length > 32 * 1024 * 1024) {
          throw createError("Oversized bulk line", "OVERSIZED_RECORD");
        }
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch {
          throw createError("Malformed JSON in bulk output", "MALFORMED_JSON");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw createError("Bulk line parsed to non-object", "INVALID_RECORD");
        }
        yield parsed;
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        yield item;
      } else {
        throw createError("Invalid record in stream", "INVALID_RECORD");
      }
    }
  })();

  for await (const record of recordStream) {
    signal?.throwIfAborted();

    if (!Object.hasOwn(record, "__parentId") || record.__parentId === null) {
      // Root record (Product)
      if (typeof record.id !== "string" || !record.id.startsWith(PRODUCT_GID_PREFIX)) {
        throw createError(
          `Unexpected root entity type: ${record.id}`,
          "UNEXPECTED_ROOT_ENTITY"
        );
      }

      if (currentProduct) {
        yield { product: currentProduct, variants: currentVariants };
      }

      currentProduct = record;
      currentVariants = [];
    } else {
      // Child record (ProductVariant)
      if (
        !currentProduct ||
        record.__parentId !== currentProduct.id ||
        typeof record.id !== "string" ||
        !record.id.startsWith(VARIANT_GID_PREFIX)
      ) {
        throw createError(
          `Ungrouped or orphan variant record: ${record.id} (__parentId: ${record.__parentId})`,
          "UNGROUPED_BULK_RECORD"
        );
      }

      currentVariants.push(record);
    }
  }

  if (currentProduct) {
    yield { product: currentProduct, variants: currentVariants };
  }
}

/**
 * Consumes a catalog bulk JSONL stream and dispatches each complete group to a handler.
 *
 * @param {AsyncIterable<string|object>|Iterable<string|object>} linesOrRecords
 * @param {Function} onGroup - Callback invoked with `{ product, variants }`
 * @param {object} [options]
 * @returns {Promise<{ productsCount: number, variantsCount: number }>}
 */
export async function consumeGroupedCatalog(
  linesOrRecords,
  onGroup,
  options = {}
) {
  if (typeof onGroup !== "function") {
    throw new TypeError("onGroup handler callback is required");
  }

  let productsCount = 0;
  let variantsCount = 0;

  for await (const group of streamGroupedCatalog(linesOrRecords, options)) {
    options.signal?.throwIfAborted();
    await onGroup(group);
    productsCount++;
    variantsCount += group.variants.length;
  }

  return { productsCount, variantsCount };
}
