import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { mapCurrentProduct } from "../products/products.mapper.js";

const completedIngestions = new WeakSet();
export function isCompletedIngestion(result) { return completedIngestions.has(result); }
const ROOT = {
  products: /^gid:\/\/shopify\/Product\/[1-9]\d*$/,
  inventory_items: /^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/,
  inventory_locations: /^gid:\/\/shopify\/Location\/[1-9]\d*$/,
};
const fail = (message) =>
  Object.assign(new Error(message), { code: "INVALID_BULK_EXPORT" });
export function exactCount(value) {
  if (
    !/^(0|[1-9]\d*)$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  )
    throw fail("Invalid or unsupported export count");
  return Number(value);
}

// Grouping is requested explicitly. Bound batches by both complete roots and
// child records. Every database batch commits before EOF can be acknowledged;
// raw line counts alone never establish ingestion.
export async function ingestGroupedExport({
  name,
  lines,
  manifest,
  writeRoot,
  writeBatch,
  signal,
}) {
  if (!ROOT[name]) throw fail("Unknown dataset");
  const expectedRoots = exactCount(manifest.rootObjectCount);
  const expectedLines = exactCount(manifest.objectCount);
  const checksum = createHash("sha256");
  let root = null,
    children = [],
    roots = 0,
    objects = 0,
    quantities = 0;
  let batch = [],
    batchObjects = 0,
    batchBytes = 0,
    writeFailed = false;
  async function commitBatch() {
    if (!batch.length) return;
    const pending = batch;
    batch = [];
    batchObjects = 0;
    batchBytes = 0;
    try {
      await writeBatch(pending);
    } catch (error) {
      writeFailed = true;
      throw error;
    }
  }
  async function write(current) {
    if (!writeBatch) return writeRoot(current);
    const cost = 1 + children.length;
    const bytes = Buffer.byteLength(JSON.stringify(current));
    if (
      batch.length &&
      (batch.length >= 100 ||
        batchObjects + cost > 500 ||
        batchBytes + bytes > 2 * 1024 * 1024)
    )
      await commitBatch();
    batch.push(current);
    batchObjects += cost;
    batchBytes += bytes;
    if (
      batch.length >= 100 ||
      batchObjects >= 500 ||
      batchBytes >= 2 * 1024 * 1024
    )
      await commitBatch();
  }
  async function flush() {
    if (!root) return;
    if (name === "products") {
      const current = { product: root, variants: children };
      mapCurrentProduct(root.id, current);
      await write(current);
    } else if (name === "inventory_items") {
      quantities += children.reduce(
        (sum, row) => sum + (row.quantities?.length ?? 0),
        0,
      );
      await write({
        item: root,
        levels: children.map(({ __parentId, ...row }) => row),
      });
    } else await write(root);
  }
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (
        typeof line !== "string" ||
        line.length > 8 * 1024 * 1024 ||
        !line.trim()
      )
        throw fail("Blank or oversized export line");
      checksum.update(line).update("\n");
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw fail("Malformed export JSON");
      }
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw fail("Invalid export object");
      objects++;
      if (objects > expectedLines) throw fail("Export exceeds manifest");
      if (!Object.hasOwn(row, "__parentId")) {
        if (!ROOT[name].test(row.id)) throw fail("Unexpected export root");
        await flush();
        root = row;
        children = [];
        roots++;
        if (roots > expectedRoots) throw fail("Export exceeds root manifest");
      } else {
        const prefix =
          name === "products"
            ? "gid://shopify/ProductVariant/"
            : "gid://shopify/InventoryLevel/";
        if (
          name === "inventory_locations" ||
          !root ||
          row.__parentId !== root.id ||
          typeof row.id !== "string" ||
          !row.id.startsWith(prefix)
        )
          throw fail("Orphan or ungrouped export child");
        children.push(row);
        if (children.length > (name === "products" ? 2048 : 10000))
          throw fail("Export child limit exceeded");
      }
    }
    await flush();
    await commitBatch();
    signal?.throwIfAborted();
    if (objects !== expectedLines || roots !== expectedRoots)
      throw fail("Truncated export");
    const result = Object.freeze({ roots, objects, children: objects - roots, quantities,
      checksum: checksum.digest("hex"), checksumAlgorithm: "sha256-jsonl-lines-v1" });
    completedIngestions.add(result);
    return result;
  } catch (error) {
    // Preserve complete validated groups when the download breaks, while never
    // committing the current incomplete group or acknowledging a failed batch.
    if (!writeFailed && !signal?.aborted) await commitBatch();
    throw error;
  }
}

export async function* downloadExport(url, { signal, fetchImpl = fetch } = {}) {
  const target = new URL(url);
  // Shopify owns the signed download URL. Never attach the offline token or
  // follow a redirect to an arbitrary service.
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !["storage.googleapis.com", "shopify.com"].some(
      (host) =>
        target.hostname === host || target.hostname.endsWith(`.${host}`),
    )
  )
    throw fail("Unexpected export download host");
  const idle = new AbortController();
  const timeout = setTimeout(
    () => idle.abort(fail("Export download stalled")),
    60000,
  );
  timeout.unref();
  const downloadSignal = signal
    ? AbortSignal.any([signal, idle.signal])
    : idle.signal;
  let input, reader;
  try {
    const response = await fetchImpl(target, {
      signal: downloadSignal,
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw fail("Export download failed or expired");
    timeout.refresh();
    input = Readable.fromWeb(response.body);
    reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      timeout.refresh();
      yield line;
    }
  } finally {
    clearTimeout(timeout);
    reader?.close();
    input?.destroy();
    idle.abort();
  }
}
