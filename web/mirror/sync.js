/**
 * METAMAX — Catalog Sync State
 *
 * Requires:
 * - Existing pg-compatible database pool
 * - mirror_generations
 * - mirror_catalog_runs
 *
 * Shop IDs must originate from trusted context.
 */

/**
 * Serialized generation sequence allocator.
 * Must be used by all mirror rebuild entry points to participate in the same sequence contract.
 *
 * @param {object} client - pg client inside an active transaction
 * @param {string} shopId - Canonical shop domain
 * @returns {Promise<{ id: string, sequence: number }>}
 */
export async function allocateNextGeneration(client, shopId) {
  if (!shopId || typeof shopId !== "string") {
    throw new TypeError("Trusted shop ID required");
  }

  // Ensure advisory lock is held for sequence allocation
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 0)
     )`,
    [`catalog-request:${shopId}`]
  );

  const sequence = await client.query(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
     FROM mirror_generations
     WHERE shop_id = $1`,
    [shopId]
  );

  const nextSeq = sequence.rows[0].next;

  const generation = await client.query(
    `INSERT INTO mirror_generations (
       shop_id, sequence, status
     )
     VALUES ($1, $2, 'BUILDING')
     RETURNING id`,
    [shopId, nextSeq]
  );

  return {
    id: generation.rows[0].id,
    sequence: Number(nextSeq),
  };
}

/**
 * Requests or resumes a durable catalog sync run for a shop.
 *
 * @param {object} db - pg Pool or Client
 * @param {string} shopId - Canonical shop domain
 * @returns {Promise<{ id: string, generation_id: string, state: string, existing: boolean }>}
 */
export async function requestCatalogSync(db, shopId) {
  if (!shopId || typeof shopId !== "string") {
    throw new TypeError("Trusted shop ID required");
  }

  const client = typeof db?.connect === "function" ? await db.connect() : db;

  if (!client || typeof client.query !== "function") {
    throw new TypeError("A PostgreSQL client or connection pool supporting query() is required");
  }

  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1, 0)
       )`,
      [`catalog-request:${shopId}`]
    );

    const active = await client.query(
      `SELECT id, generation_id, state
       FROM mirror_catalog_runs
       WHERE shop_id = $1
         AND state IN (
           'REQUESTED', 'STARTING', 'RUNNING',
           'INGESTING', 'VERIFYING', 'NEEDS_REVIEW'
         )
       LIMIT 1`,
      [shopId]
    );

    if (active.rows.length) {
      await client.query("COMMIT");
      return {
        ...active.rows[0],
        existing: true,
      };
    }

    // Sequence allocation is serialized per shop using the unified allocator.
    const generation = await allocateNextGeneration(client, shopId);

    const created = await client.query(
      `INSERT INTO mirror_catalog_runs (
         shop_id, generation_id
       )
       VALUES ($1, $2)
       RETURNING id, generation_id, state`,
      [shopId, generation.id]
    );

    await client.query("COMMIT");

    return {
      ...created.rows[0],
      existing: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release?.();
  }
}

/**
 * Fetches the durable catalog sync run record by ID.
 *
 * @param {object} db - pg Pool or Client
 * @param {string} runId - UUID of the catalog run
 * @returns {Promise<object|null>}
 */
export async function getCatalogRun(db, runId) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("A PostgreSQL client or connection pool is required");
  }

  const result = await db.query(
    `SELECT *
     FROM mirror_catalog_runs
     WHERE id = $1`,
    [runId]
  );

  return result.rows[0] ?? null;
}

/**
 * Compare-and-set transition.
 * Unexpected or stale transitions fail closed.
 *
 * @param {object} db - pg Pool or Client
 * @param {object} params
 * @param {string} params.runId - Catalog run UUID
 * @param {string} params.from - Expected current state
 * @param {string} params.to - Target new state
 * @param {object} [params.values={}] - Attributes to update
 * @returns {Promise<object>} The updated catalog run record
 */
export async function transitionCatalogRun(
  db,
  {
    runId,
    from,
    to,
    values = {},
  }
) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("A PostgreSQL client or connection pool is required");
  }

  const allowed = {
    bulkOperationId: "bulk_operation_id",
    resultUrl: "result_url",
    expectedObjects: "expected_objects",
    expectedProducts: "expected_products",
    importedProducts: "imported_products",
    importedVariants: "imported_variants",
    checksum: "checksum",
    errorMessage: "error_message",
  };

  if (!Object.values(allowed).every(Boolean)) {
    throw new Error("Invalid transition configuration");
  }

  const assignments = [
    "state = $3",
    "updated_at = now()",
  ];

  const params = [runId, from, to];

  for (const [key, value] of Object.entries(values)) {
    const column = allowed[key];

    if (!column) {
      throw new Error(
        `Unsupported transition field: ${key}`
      );
    }

    params.push(value);
    assignments.push(
      `${column} = $${params.length}`
    );
  }

  const result = await db.query(
    `UPDATE mirror_catalog_runs
     SET ${assignments.join(", ")}
     WHERE id = $1 AND state = $2
     RETURNING *`,
    params
  );

  if (result.rowCount !== 1) {
    throw new Error(
      `Catalog sync state conflict: ${from} -> ${to}`
    );
  }

  return result.rows[0];
}

/**
 * Transitions a catalog run to FAILED with error message, unless it is already terminal or under review.
 *
 * @param {object} db - pg Pool or Client
 * @param {string} runId - Catalog run UUID
 * @param {Error|string} error - Failure reason
 * @returns {Promise<object>}
 */
export async function failCatalogRun(
  db,
  runId,
  error
) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("A PostgreSQL client or connection pool is required");
  }

  const message = String(
    error?.message ?? error
  ).slice(0, 2000);

  return await db.query(
    `UPDATE mirror_catalog_runs
     SET state = 'FAILED',
         error_message = $2,
         updated_at = now()
     WHERE id = $1
       AND state NOT IN (
         'PUBLISHED', 'FAILED', 'NEEDS_REVIEW'
       )`,
    [runId, message]
  );
}
