/**
 * METAMAX — Trusted PostgreSQL Filter Executor
 *
 * filters/execute.js
 *
 * Security:
 * - Only compiler-issued SQL
 * - Authenticated shop binding
 * - Read-only transactions protected by tenant publication locks
 * - Publication validation within the transaction
 * - Transaction-scoped database timeouts
 * - Bounded results
 * - No browser-controlled SQL
 */

import {
  FILTER_EXECUTION_LIMITS as L,
} from "./validate.js";

import {
  assertCompiledFilter,
  FILTER_COMPILER_VERSION,
} from "./compile.js";

import {
  FieldError,
  FIELD_ERROR_CODES as C,
  isPlainObject,
} from "../fields/types.js";

import {
  FilterInfrastructureError,
} from "./errors.js";
import { withCoverageTransaction } from "../mirror/coverage-transaction.server.js";
import { readCatalogPage, catalogCount } from "../mirror/catalog-repository.server.js";
import { AsyncLocalStorage } from "node:async_hooks";

const STATEMENT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 1000;
const MAX_RESULT_BYTES = 512 * 1024;

function fail(code, message) {
  throw new FieldError(code, message);
}

export function normalizePageSize(
  value = L.DEFAULT_PAGE_SIZE,
) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > L.MAX_PAGE_SIZE ||
    Object.is(value, -0)
  ) {
    fail(C.INVALID_VALUE, "Invalid filter page size");
  }

  return value;
}

function assertShopId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    value.includes("\0")
  ) {
    fail(
      C.PERMISSION_DENIED,
      "Authenticated shop is required",
    );
  }

  return value;
}

function assertDependencies({
  database,
  publicationService,
  resolveShop,
  compiler,
}) {
  if (
    !database ||
    typeof database.connect !== "function"
  ) {
    throw new TypeError(
      "A PostgreSQL pool is required",
    );
  }

  if (
    !publicationService ||
    typeof publicationService.requirePublished !==
      "function"
  ) {
    throw new TypeError(
      "Transaction-aware publication service required",
    );
  }

  if (typeof resolveShop !== "function") {
    throw new TypeError(
      "Trusted shop resolver required",
    );
  }

  if (
    !compiler ||
    typeof compiler.createCursor !== "function" ||
    typeof compiler.authorizeExecution !== "function" ||
    typeof compiler.getExecutionPlan !== "function"
  ) {
    throw new TypeError(
      "Trusted filter compiler required",
    );
  }
}

function assertQuery(query, shopId, compiler) {
  assertCompiledFilter(query, compiler);

  if (
    query.version !== FILTER_COMPILER_VERSION ||
    !["product_ids", "catalog_product_ids", "catalog_status", "catalog_count"].includes(query.kind) ||
    typeof query.text !== "string" ||
    !Array.isArray(query.values) ||
    !query.binding ||
    query.binding.shopId !== shopId
  ) {
    fail(
      C.PERMISSION_DENIED,
      "Filter query authorization failed",
    );
  }

  normalizePageSize(query.pageSize);

  if (
    !Number.isSafeInteger(query.parameterCount) ||
    query.parameterCount !== query.values.length ||
    query.parameterCount > L.MAX_SQL_PARAMETERS
  ) {
    fail(
      C.CONTRACT_MISMATCH,
      "Invalid compiled query parameters",
    );
  }

  if (
    Buffer.byteLength(query.text, "utf8") > 65536
  ) {
    fail(
      C.INVALID_VALUE,
      "Compiled query exceeds execution budget",
    );
  }

  return query;
}

function assertPublicationBinding(binding) {
  if (
    !binding ||
    typeof binding.generationId !== "string" ||
    !binding.generationId ||
    typeof binding.coverageRevision !== "string" ||
    !binding.coverageRevision
  ) {
    fail(
      C.CONTRACT_MISMATCH,
      "Incomplete publication binding",
    );
  }
}

function readProductIds(rows, pageSize) {
  if (
    !Array.isArray(rows) ||
    rows.length > pageSize
  ) {
    fail(
      C.CONTRACT_MISMATCH,
      "Invalid database result size",
    );
  }

  const productIds = [];
  let bytes = 0;

  for (const row of rows) {
    const id = row?.product_id;

    if (
      typeof id !== "string" ||
      !id ||
      id.includes("\0")
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Invalid database product ID",
      );
    }

    bytes += Buffer.byteLength(id, "utf8");

    if (bytes > MAX_RESULT_BYTES) {
      fail(
        C.INVALID_VALUE,
        "Filter result exceeds response budget",
      );
    }

    productIds.push(id);
  }

  return productIds;
}

export function createFilterExecutor({
  database,
  publicationService,
  resolveShop,
  compiler,
}) {
  assertDependencies({
    database,
    publicationService,
    resolveShop,
    compiler,
  });

  // Scoped by this executor instance; an HTTP request cannot supply a client.
  const snapshots = new AsyncLocalStorage();

  async function withSnapshot({ authContext, signal, timeoutMs = 30000 }, callback) {
    if (typeof callback !== "function" || typeof publicationService.lockForRead !== "function" || snapshots.getStore()) {
      fail(C.CONTRACT_MISMATCH, "Protected selection transaction required");
    }
    const shopId = assertShopId(await resolveShop(authContext));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail(C.INVALID_VALUE,"Invalid selection transaction deadline");
    signal?.throwIfAborted();
    const client = await database.connect();
    const scope = { shopId, active: true,deadline:Date.now()+timeoutMs };
    const check = () => {
      signal?.throwIfAborted();
      if (!scope.active || Date.now() >= scope.deadline) fail(C.EXECUTION_UNAVAILABLE,"Selection transaction deadline exceeded");
    };
    scope.client = Object.freeze({async query(...args){check();const result=await client.query(...args);check();return result;}});
    let discard,timer,abort;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
      // Protect publication and mirror contents before establishing the snapshot.
      await publicationService.lockForRead(client,shopId);
      const pending = snapshots.run(scope, () =>
        withCoverageTransaction(scope.client, async () => {
          const result=await callback({client:scope.client,shopId});
          check();
          if(assertShopId(await resolveShop(authContext))!==shopId)
            fail(C.PERMISSION_DENIED,"Authenticated shop changed during selection");
          check();
          if(scope.lastQuery){
            await compiler.authorizeExecution(scope.lastQuery,authContext);
            assertQuery(scope.lastQuery,shopId,compiler);
          }
          check();
          return result;
        }),
      );
      const deadline = new Promise((_,reject)=>{
        const expire=()=>{scope.active=false;reject(signal?.aborted ? signal.reason : new FieldError(C.EXECUTION_UNAVAILABLE,"Selection transaction deadline exceeded"));};
        timer=setTimeout(expire,Math.max(0,scope.deadline-Date.now()));
        abort=expire;signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)expire();
      });
      const result = await Promise.race([pending,deadline]);
      check();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      scope.active = false;
      try { await client.query("ROLLBACK"); } catch (rollbackError) { discard = rollbackError; }
      throw error;
    } finally {
      scope.active = false;
      clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
      client.release(discard);
    }
  }

  async function execute(raw = {}) {
    if (!isPlainObject(raw)) fail(C.CONTRACT_MISMATCH, "Trusted execution context required");
    const options = Object.create(null);
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (typeof key !== "string" || !["query", "authContext"].includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
        fail(C.CONTRACT_MISMATCH, "Execution accepts only its query and authentication context");
      }
      options[key] = descriptor.value;
    }
    const { query, authContext } = options;
    // Authentication is resolved independently of
    // query metadata or HTTP request-body fields.
    const shopId = assertShopId(
      await resolveShop(authContext),
    );
    const snapshot = snapshots.getStore();
    if (snapshot && (!snapshot.active || snapshot.shopId !== shopId)) {
      fail(C.PERMISSION_DENIED, "Selection transaction belongs to another shop or has ended");
    }

    assertQuery(query, shopId, compiler);
    assertPublicationBinding(query.binding);

    // Only the issuing compiler's private validated plan can supply coverage.
    // Request preparation cannot supply a second coverage list.
    const plan = compiler.getExecutionPlan(query);
    const requiredDatasets = plan.datasets;

    if (
      !Array.isArray(requiredDatasets) ||
      !Object.isFrozen(requiredDatasets) ||
      requiredDatasets.length === 0 ||
      requiredDatasets.length > 32 ||
      plan.binding !== query.binding ||
      query.requiredDatasets !== requiredDatasets ||
      query.resolverVersion !== 1 ||
      requiredDatasets.some(
        value =>
          typeof value !== "string" ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(value),
      ) ||
      new Set(requiredDatasets).size !== requiredDatasets.length
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Trusted dataset coverage is required",
      );
    }

    let client;
    let transactionStarted = false;

    try {
      client = snapshot?.client ?? await database.connect();

      if (!snapshot) {
        await client.query(
          "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
        );

        transactionStarted = true;

        // Acquire tenant publication protection before reading catalog authority.
        // READ COMMITTED observes commits made while the lock acquisition waits.
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      }

      // The publication service MUST acquire a
      // transaction-scoped protection lock.
      // Read-only transactions cannot acquire a
      // FOR UPDATE row lock.
      await publicationService.requirePublished({
        client,
        shopId,
        generationId: query.binding.generationId,
        coverageRevision:
          query.binding.coverageRevision,
        datasets: requiredDatasets,
      });

      // Lock acquisition may wait. Recheck the current session and the original
      // operation/field/target authorization while publication remains protected.
      if (assertShopId(await resolveShop(authContext)) !== shopId) {
        fail(C.PERMISSION_DENIED, "Authenticated shop changed during execution");
      }
      await withCoverageTransaction(client, () => compiler.authorizeExecution(query, authContext));

      // A migration can revoke the catalog capability while the barrier waits.
      assertQuery(query, shopId, compiler);

      if (query.kind === "catalog_status" || query.kind === "catalog_count") {
        if (!plan.catalog) fail(C.PERMISSION_DENIED,"Compiler-owned catalog authorization required");
        let filteredCount;
        if (query.kind === "catalog_count") {
          const counted = await client.query({text:query.text,values:query.values});
          if (!Array.isArray(counted.rows) || counted.rows.length !== 1 || !Object.hasOwn(counted.rows[0],"count")) fail(C.CONTRACT_MISMATCH,"Invalid catalog count projection");
          filteredCount = catalogCount(counted.rows[0].count);
        }
        if (!snapshot) await client.query("COMMIT");
        transactionStarted = false;
        if (snapshot) snapshot.lastQuery = query;
        return Object.freeze({generationId:query.binding.generationId,coverageRevision:query.binding.coverageRevision,
          ...(filteredCount === undefined ? {} : {filteredCount})});
      }

      const result = await client.query({
        text: query.text,
        values: query.values,
        rowMode: "array",
      });

      // rowMode must match row interpretation.
      // Convert the single selected product_id.
      if (
        !Array.isArray(result.fields) ||
        result.fields.length !== 1 ||
        result.fields[0]?.name !== "product_id"
      ) {
        fail(
          C.CONTRACT_MISMATCH,
          "Unexpected database projection",
        );
      }

      if (!Array.isArray(result.rows) || result.rows.length > query.pageSize + 1 ||
          result.rows.some(row => !Array.isArray(row) || row.length !== 1)) {
        fail(C.CONTRACT_MISMATCH, "Filter result exceeds its bounded lookahead contract");
      }
      const rows = result.rows.map(row => ({
        product_id: row[0],
      }));

      const allIds = readProductIds(
        rows,
        query.pageSize + 1,
      );
      const hasMore = allIds.length > query.pageSize;
      const productIds = hasMore ? allIds.slice(0, query.pageSize) : allIds;

      let catalog;
      if (query.kind === "catalog_product_ids") {
        if (!plan.catalog) fail(C.PERMISSION_DENIED, "Compiler-owned catalog plan required");
        const projected = await readCatalogPage(client, { shopId, generationId: query.binding.generationId, productIds });
        const filtered = await client.query({ text: plan.catalog.countText, values: plan.catalog.countValues });
        catalog = { ...projected, filteredCount: catalogCount(filtered.rows[0].count) };
        if (Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_RESULT_BYTES) fail(C.INVALID_VALUE, "Catalog result exceeds response budget");
      }

      if (!snapshot) await client.query("COMMIT");
      transactionStarted = false;

      const lastProductId =
        productIds[productIds.length - 1];
      if (snapshot) snapshot.lastQuery = query;

      return Object.freeze({
        ...(catalog ?? {}),
        productIds: Object.freeze(productIds),
        pageSize: query.pageSize,
        hasMore,
        nextCursor:
          hasMore
            ? compiler.createCursor(
                query,
                lastProductId,
              )
            : null,
        generationId: query.binding.generationId,
        coverageRevision:
          query.binding.coverageRevision,
      });
    } catch (error) {
      if (transactionStarted && client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }

      if (
        error instanceof FieldError ||
        error instanceof FilterInfrastructureError
      ) {
        throw error;
      }

      throw new FilterInfrastructureError(error);
    } finally {
      if (client && !snapshot) {
        client.release();
      }
    }
  }

  return Object.freeze({
    execute,
    withSnapshot,
  });
}
