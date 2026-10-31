/** Publication barrier for read-only repeatable-read execution.
 * The configured relation is an EXISTING server-owned barrier, not a schema
 * declaration. Every publisher, coverage writer, mirror mutator and reclaimer
 * must acquire lockForWrite before reading or changing its protected state.
 * This coarse barrier serializes writers across all tenants using the relation.
 */
import { quoteQualifiedTable } from "../filters/mirror-schema.js";
import { createMirrorCoverageService } from "./coverage.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";

export function createMirrorPublicationService({
  repository,
  barrierTable,
  database,
} = {}) {
  if (typeof repository?.getPublishedSnapshot !== "function" || !barrierTable) {
    throw new TypeError(
      "Transaction-aware publication repository and barrier table required",
    );
  }
  const relation = quoteQualifiedTable(barrierTable.schema, barrierTable.table);

  function requireClient(client) {
    if (typeof client?.query !== "function")
      throw new TypeError("Active transaction client required");
  }

  return Object.freeze({
    async lockForRead(client) {
      requireClient(client);
      await client.query(`LOCK TABLE ${relation} IN ACCESS SHARE MODE`);
    },

    async requirePublished({
      client,
      shopId,
      generationId,
      coverageRevision,
      datasets,
    }) {
      requireClient(client);
      // Must be the transaction's first data-dependent statement. ACCESS SHARE
      // is allowed in READ ONLY and conflicts with the writer's ACCESS EXCLUSIVE.
      await client.query(`LOCK TABLE ${relation} IN ACCESS SHARE MODE`);
      const coverage = createMirrorCoverageService({
        repository: {
          getPublishedSnapshot: (input) =>
            repository.getPublishedSnapshot({ ...input, client }),
        },
      });
      const receipt = await coverage.getVerifiedCoverage({
        shopId,
        datasets,
        executionContext: { generationId, coverageRevision },
      });
      if (!receipt)
        throw new FieldError(
          C.MISSING_DEPENDENCY,
          "Required published mirror coverage unavailable",
        );
      return receipt;
    },

    async lockForWrite(client) {
      requireClient(client);
      // The caller owns BEGIN/COMMIT/ROLLBACK; the lock lasts until transaction end.
      await client.query(`LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE`);
    },

    async publishGeneration({
      client,
      shopId,
      generationId,
      expectedGenerationId,
      installedOptions,
    } = {}) {
      if (typeof repository.publishGeneration !== "function") {
        throw new TypeError("Repository publishGeneration method required");
      }
      if (client !== undefined) {
        requireClient(client);
        await this.lockForWrite(client);
        return repository.publishGeneration({
          client,
          shopId,
          generationId,
          expectedGenerationId,
          installedOptions,
        });
      }
      return repository.publishGeneration({
        shopId,
        generationId,
        expectedGenerationId,
        installedOptions,
      });
    },

    async acquireReadLease(input) {
      if (typeof repository.acquireReadLease !== "function") {
        throw new TypeError("Repository acquireReadLease method required");
      }
      return repository.acquireReadLease(input);
    },

    async releaseReadLease(input) {
      if (typeof repository.releaseReadLease !== "function") {
        throw new TypeError("Repository releaseReadLease method required");
      }
      return repository.releaseReadLease(input);
    },

    async renewReadLease(input) {
      if (typeof repository.renewReadLease !== "function") {
        throw new TypeError("Repository renewReadLease method required");
      }
      return repository.renewReadLease(input);
    },

    async verifyReadLease(input) {
      requireClient(input?.client);
      if(typeof repository.verifyReadLease!=="function")throw new TypeError("Repository verifyReadLease required");
      return repository.verifyReadLease(input);
    },
  });
}
