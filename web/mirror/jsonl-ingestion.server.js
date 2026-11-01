import {stagedResume} from './staged-catalog-download.server.js';
import { Readable } from "node:stream";
import {createHash} from 'node:crypto';
import {validateProducts} from './catalog-validation.js';
import {
  invalid,
  integer,
  transaction,
  shop,
  token,
} from "./transactions.server.js";
import { BULK_STATUS_QUERY } from "./bulk-sync.server.js";

/**
 * Stream lines from a Node.js Readable or Web ReadableStream without buffering
 * the complete stream into RAM.
 */
export async function* streamLinesFromReadable(
  readableStream,
  { maxLineBytes = 1024 * 1024 } = {},
) {
  integer(maxLineBytes, 1, 8 * 1024 * 1024, "line byte limit");
  const nodeReadable =
    typeof readableStream?.getReader === "function"
      ? Readable.fromWeb(readableStream)
      : readableStream;

  const pending = Buffer.allocUnsafe(maxLineBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, afterCR = false;
  const append = (chunk, start, end) => {
    if (size + end - start > maxLineBytes) invalid("Bounded JSONL text line required");
    chunk.copy(pending, size, start, end);
    size += end - start;
  };
  for await (const raw of nodeReadable) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (afterCR && byte === 10) { start = index + 1; afterCR = false; continue; }
      afterCR = false;
      if (byte !== 10 && byte !== 13) continue;
      append(chunk, start, index);
      if (size) yield decoder.decode(pending.subarray(0, size));
      size = 0;
      start = index + 1;
      afterCR = byte === 13;
    }
    append(chunk, start, chunk.length);
  }
  if (size) yield decoder.decode(pending.subarray(0, size));
}

/**
 * Normalizes string, stream, array, or async iterable into an async line generator,
 * enforcing bounded memory and line limits.
 */
export async function* normalizeLineStream(
  lines,
  { maxLineBytes = 1024 * 1024 } = {},
) {
  if (typeof lines === "string") {
    if (Buffer.byteLength(lines) > 8 * 1024 * 1024) {
      invalid("Large exports require a bounded async line stream");
    }
    const split = lines.split(/\r?\n/).filter(Boolean);
    for (const line of split) {
      if (Buffer.byteLength(line) > maxLineBytes) {
        invalid("Bounded JSONL text line required");
      }
      yield line;
    }
    return;
  }

  if (
    lines &&
    (typeof lines.pipe === "function" ||
      typeof lines.getReader === "function" ||
      lines instanceof Readable)
  ) {
    yield* streamLinesFromReadable(lines, { maxLineBytes });
    return;
  }

  if (lines?.[Symbol.iterator] || lines?.[Symbol.asyncIterator]) {
    for await (const line of lines) {
      if (
        typeof line !== "string" ||
        !line ||
        Buffer.byteLength(line) > maxLineBytes
      ) {
        invalid("Bounded JSONL text line required");
      }
      yield line;
    }
    return;
  }

  invalid("JSONL line iterable required");
}

export function createJsonlIngestionService({
  syncRunService,
  ingestionWriter,
  database,
  shopifyClient,
  bulkSyncService,
}) {
  if (!syncRunService || !ingestionWriter || !database) {
    throw new TypeError("Sync dependencies required");
  }

  async function getExpectedLines(shopId, run, expectedLines) {
    if (!run?.bulkOperationId) {
      invalid("Persisted operation identity required");
    }
    let op;
    if (bulkSyncService && typeof bulkSyncService.getStatus === "function") {
      op = await bulkSyncService.getStatus({
        shopId,
        bulkOperationId: run.bulkOperationId,
      });
    } else if (shopifyClient && typeof shopifyClient.request === "function") {
      const response = await shopifyClient.request(BULK_STATUS_QUERY, {
        variables: { id: run.bulkOperationId },
      });
      op = response.data?.bulkOperation;
      if (response.errors || !op || op.id !== run.bulkOperationId) {
        invalid("Owned bulk operation unavailable");
      }
    } else {
      invalid("Owned bulk operation reader required");
    }

    if (op.id !== run.bulkOperationId || op.status !== "COMPLETED" ||
        !/^(0|[1-9][0-9]*)$/.test(String(op.objectCount)) ||
        (typeof op.objectCount === "number" && !Number.isSafeInteger(op.objectCount))) {
      invalid("Only complete exports may be ingested");
    }
    const expected = BigInt(op.objectCount);
    if (typeof expectedLines === "number" && !Number.isSafeInteger(expectedLines)) invalid("Exact expected count required");
    if (expectedLines !== undefined && expectedLines !== null && BigInt(expectedLines) !== expected) {
      invalid("Provided count differs from owned completed export");
    }
    return expected;
  }

  const service = Object.freeze({
    /**
     * Ingest JSONL lines (stream, async iterable, or string) with bounded streaming
     * memory usage, transactional batch flushes, and durable checkpoint commits.
     */
    async ingestJsonlLines({
      shopId,
      generationId,
      runId,
      fence,
      lines,
      batchSize = 25,
      signal,
      expectedLines,
      cancelOnAbort = true,
      maxNewChunks = null,
    }) {
      shop(shopId);
      token(generationId);
      integer(batchSize, 1, 100, "batch size");
      if (maxNewChunks !== null) integer(maxNewChunks, 1, 100, "new chunk budget");

      const run = await syncRunService.getSyncRun({ shopId, runId });
      if (
        !run ||
        run.generationId !== generationId ||
        BigInt(run.fence) !== BigInt(fence) ||
        run.status !== "RUNNING"
      ) {
        invalid("Owned ingestion run required");
      }

      let expected;
      const lineStream = normalizeLineStream(lines);

      const resume=stagedResume(lines,{shopId,generationId,runId});
      if(resume&&resume.processedLines!==BigInt(run.processedLines))invalid('Staged ingestion progress changed');
      let ordinal = resume?.ordinal??0;
      let total = resume?.processedLines??0n;
      let batch = [];
      let current = null;
      let bytes = 0;
      let newChunks = 0;
      let checkpointPage = new Map(), checkpointPageStart = -1;
      const loadCheckpoints = async () => {
        if (typeof database.query !== 'function') return;
        const pageStart = Math.floor(ordinal / 1000) * 1000;
        if (checkpointPageStart === pageStart) return;
        const saved = await database.query(`SELECT ordinal,checksum,line_count::text FROM mirror.ingestion_chunks
          WHERE shop_id=$1 AND run_id=$2 AND ordinal>=$3 AND ordinal<$4 ORDER BY ordinal LIMIT 1000`,
        [shopId,runId,pageStart,pageStart+1000]);
        checkpointPage = new Map(saved.rows.map(row => [row.ordinal,row]));
        checkpointPageStart = pageStart;
      };

      const flush = async () => {
        if (!batch.length) return;
        signal?.throwIfAborted();
        const records = batch;
        if (typeof database.query === 'function') {
          // Immutable metadata is replay evidence, never write authority.
          await loadCheckpoints();
          const saved = checkpointPage.get(ordinal);
          if (saved) {
            validateProducts(records);
            const checksum = createHash('sha256').update(JSON.stringify(records)).digest('hex');
            const lineCount = records.reduce((n,p) => n+1+p.variants.length,0);
            if (checksum !== saved.checksum || BigInt(lineCount) !== BigInt(saved.line_count)) invalid('Resumed chunk input changed');
            ordinal++;batch=[];bytes=0;return;
          }
        }
        const receipt = await transaction(database, (client) =>
          ingestionWriter.writeStagingBatch({
            client,
            shopId,
            generationId,
            runId,
            fence,
            ordinal,
            records,
          }), shopId);
        if (receipt?.replayed !== true) newChunks++;
        ordinal++;
        batch = [];
        bytes = 0;
        await syncRunService.renewRunLease({
          shopId,
          runId,
          fence,
          workerId: run.leaseToken,
        });
      };

      try {
        expected = await getExpectedLines(shopId, run, expectedLines);
        await loadCheckpoints();
        for await (const line of lineStream) {
          signal?.throwIfAborted();
          const item = JSON.parse(line);
          total++;
          if (total > expected) {
            invalid("Export exceeds expected record count");
          }

          if (item.__parentId !== undefined) {
            if (
              !current ||
              item.__parentId !== current.id ||
              !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(item.id)
            ) {
              invalid("Orphan or unsupported child line");
            }
            if (current.variants.length >= 2048) {
              invalid("Variant count limit exceeded");
            }
            current.variants.push(item);
          } else {
            if (
              !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(item.id) ||
              item.variants !== undefined
            ) {
              invalid("Flat grouped product JSONL required");
            }
            if (current) batch.push(current);
            // Preserve each committed checksum's exact product boundary when a
            // newer worker uses a larger bounded batch for unsaved data.
            const saved = checkpointPage.get(ordinal);
            const replayBoundary = saved && BigInt(batch.reduce((n,p) => n+1+p.variants.length,0)) >= BigInt(saved.line_count);
            if (saved ? replayBoundary : batch.length >= batchSize) {
              await flush();
              await loadCheckpoints();
              if (maxNewChunks !== null && newChunks >= maxNewChunks) {
                return { succeeded:false, deferred:true, chunksCommitted:ordinal };
              }
            }
            current = { ...item, variants: [] };
          }

          bytes += Buffer.byteLength(line);
          if (bytes > 8 * 1024 * 1024) {
            invalid("Product/batch byte limit exceeded");
          }
        }

        if (current) batch.push(current);
        await flush();

        if (total !== expected) {
          invalid("Truncated export");
        }

        signal?.throwIfAborted();
        await transaction(database, async (client) => {
          await syncRunService.completeIngestionRun({
            client,
            shopId,
            runId,
            fence,
            expectedLines: expected,
            processedLines: total,
            invalidLines: 0n,
            eofVerified: true,
          });
          await syncRunService.transitionGenerationToReconciling({
            client,
            shopId,
            generationId,
          });
        }, shopId);

        return {
          totalLinesProcessed: total,
          chunksCommitted: ordinal,
          succeeded: true,
        };
      } catch (error) {
        // Committed chunks remain resumable; never declare EOF from lines read.
        if (signal?.aborted && cancelOnAbort) {
          await syncRunService.cancelGeneration({ shopId, generationId });
        } else {
          await syncRunService
            .failIngestionRun?.({ shopId, runId, fence, error })
            ?.catch(() => {});
        }
        throw error;
      }
    },

    /**
     * Ingest a Node.js stream or web ReadableStream without buffering into RAM.
     */
    async ingestJsonlStream({
      shopId,
      generationId,
      runId,
      fence,
      stream,
      batchSize = 25,
      signal,
      expectedLines,
    }) {
      return service.ingestJsonlLines({
        shopId,
        generationId,
        runId,
        fence,
        lines: stream,
        batchSize,
        signal,
        expectedLines,
      });
    },

    /**
     * Complete an empty catalog ingestion with zero lines.
     */
    async completeEmptyStoreIngestion(options) {
      return service.ingestJsonlLines({ ...options, lines: [] });
    },
  });

  return service;
}
