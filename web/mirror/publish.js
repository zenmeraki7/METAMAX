import {
  CORE_DATASETS,
} from "./datasets.js";

/**
 * Publish only a verified, newer generation.
 *
 * `db` must be the existing pg-compatible pool or client.
 *
 * Safety requirements:
 * - Serialize publication decisions per shop with an advisory lock.
 * - Verify that the target generation has status 'READY'.
 * - Verify that all CORE_DATASETS have 'VERIFIED' coverage state.
 * - Enforce monotonic sequence progression (newer generation only).
 * - Mark prior active generations as 'RETIRED' and target as 'PUBLISHED'.
 *
 * @param {object} db - pg Pool or Client
 * @param {object} params
 * @param {string} params.shopId - Unique shop domain/identifier
 * @param {string} params.generationId - Unique generation ID to publish
 * @returns {Promise<{ shopId: string, generationId: string, published: boolean }>}
 */
export async function publishGeneration(
  db,
  { shopId, generationId }
) {
  if (!shopId || typeof shopId !== "string") {
    throw new TypeError("shopId is required");
  }

  if (!generationId || typeof generationId !== "string") {
    throw new TypeError("generationId is required");
  }

  const client = typeof db?.connect === "function" ? await db.connect() : db;

  if (!client || typeof client.query !== "function") {
    throw new TypeError(
      "A PostgreSQL client or connection pool supporting query() is required"
    );
  }

  try {
    await client.query("BEGIN");

    // Serialize publication decisions per shop.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`mirror-publish:${shopId}`]
    );

    const generationResult = await client.query(
      `SELECT sequence, status
       FROM mirror_generations
       WHERE shop_id = $1 AND id = $2
       FOR UPDATE`,
      [shopId, generationId]
    );

    const generation = generationResult.rows[0];

    if (!generation || generation.status !== "READY") {
      throw new Error("Generation is not ready");
    }

    const coverage = await client.query(
      `SELECT dataset
       FROM mirror_coverage
       WHERE shop_id = $1
         AND generation_id = $2
         AND state = 'VERIFIED'
       FOR SHARE`,
      [shopId, generationId]
    );

    const covered = new Set(
      coverage.rows.map((row) => row.dataset)
    );

    for (const dataset of CORE_DATASETS) {
      if (!covered.has(dataset)) {
        throw new Error(
          `Dataset is not verified: ${dataset}`
        );
      }
    }

    const existing = await client.query(
      `SELECT sequence
       FROM mirror_publications
       WHERE shop_id = $1
       FOR UPDATE`,
      [shopId]
    );

    if (
      existing.rows.length &&
      BigInt(existing.rows[0].sequence) >=
        BigInt(generation.sequence)
    ) {
      throw new Error(
        "Cannot publish an older generation"
      );
    }

    await client.query(
      `INSERT INTO mirror_publications (
         shop_id, generation_id, sequence
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_id)
       DO UPDATE SET
         generation_id = EXCLUDED.generation_id,
         sequence = EXCLUDED.sequence,
         published_at = now()`,
      [shopId, generationId, generation.sequence]
    );

    await client.query(
      `UPDATE mirror_generations
       SET status = 'RETIRED'
       WHERE shop_id = $1
         AND status = 'PUBLISHED'
         AND id <> $2`,
      [shopId, generationId]
    );

    await client.query(
      `UPDATE mirror_generations
       SET status = 'PUBLISHED',
           published_at = now()
       WHERE shop_id = $1 AND id = $2`,
      [shopId, generationId]
    );

    await client.query("COMMIT");

    return {
      shopId,
      generationId,
      published: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release?.();
  }
}
