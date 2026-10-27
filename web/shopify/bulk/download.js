import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
  "storage.googleapis.com",
  "shopify.com",
]);

/**
 * Validate that a download URL is an allowlisted HTTPS destination with no embedded credentials.
 *
 * @param {string} urlStr
 * @returns {URL}
 */
export function validateBulkDownloadUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid bulk download URL");
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
    throw new Error("Unexpected bulk download host");
  }

  return parsed;
}

/**
 * Streams JSONL records from a verified Shopify bulk operation URL without buffering the entire catalog.
 *
 * Enforces:
 * - Allowlisted HTTPS destinations and no cross-domain redirects
 * - Maximum line bytes (default 2MB)
 * - Maximum total download bytes (default 512MB)
 * - Whole-download deadline timeout (default 120s)
 * - JSON record object validation
 *
 * @param {string} url - Verified signed download URL
 * @param {object} [options]
 * @param {number} [options.maxLineBytes=2097152] - Max allowed bytes per JSONL line (2MB)
 * @param {number} [options.maxTotalBytes=536870912] - Max total bytes allowed (512MB)
 * @param {number} [options.timeoutMs=120000] - Whole-download deadline timeout in ms (120s)
 * @param {AbortSignal} [options.signal] - Caller abort signal
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch implementation for testing
 * @returns {AsyncGenerator<object>}
 */
export async function* readBulkJsonl(
  url,
  {
    maxLineBytes = 2 * 1024 * 1024,
    maxTotalBytes = 512 * 1024 * 1024,
    timeoutMs = 120_000,
    signal,
    fetchImpl = fetch,
  } = {}
) {
  const verifiedUrl = validateBulkDownloadUrl(url);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const downloadSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetchImpl(verifiedUrl, {
    signal: downloadSignal,
    redirect: "error",
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Bulk download failed: ${response.status}`
    );
  }

  let input;
  if (typeof ReadableStream !== "undefined" && response.body instanceof ReadableStream) {
    input = Readable.fromWeb(response.body);
  } else if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    input = Readable.from(response.body);
  } else if (typeof Readable.fromWeb === "function" && response.body?.getReader) {
    try {
      input = Readable.fromWeb(response.body);
    } catch {
      input = Readable.from(response.body);
    }
  } else {
    input = Readable.from(response.body);
  }

  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });

  let totalBytes = 0;

  try {
    for await (const line of lines) {
      if (!line) continue;

      const lineBytes = Buffer.byteLength(line);
      totalBytes += lineBytes;

      if (lineBytes > maxLineBytes) {
        throw new Error("JSONL line exceeds limit");
      }

      if (totalBytes > maxTotalBytes) {
        throw new Error("Total download size exceeds limit");
      }

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("Invalid JSONL record");
      }

      if (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record)
      ) {
        throw new Error("Invalid JSONL record");
      }

      yield record;
    }
  } finally {
    lines.close();
    input.destroy?.();
  }
}

/**
 * Batches an async stream of catalog records into bounded chunks.
 *
 * @param {AsyncIterable<object>|Iterable<object>} records
 * @param {number} [batchSize=400] - Bounded batch size (1..500)
 * @returns {AsyncGenerator<Array<object>>}
 */
export async function* catalogBatches(
  records,
  batchSize = 400
) {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 500
  ) {
    throw new Error("Invalid catalog batch size");
  }

  let batch = [];

  for await (const record of records) {
    batch.push(record);

    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length) yield batch;
}
