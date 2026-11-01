/** Shop-scoped publication barrier for READ COMMITTED execution.
 * The configured relation is an EXISTING server-owned barrier, not a schema
 * declaration. Every publisher, coverage writer, mirror mutator and reclaimer
 * must acquire lockForWrite before reading or changing its protected state.
 * Only writers for the same authenticated shop conflict with a reader.
 */
import { quoteQualifiedTable } from "../filters/mirror-schema.js";
import { createMirrorCoverageService } from "./coverage.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import {lockPublication} from './publication-lock.server.js';

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
    async lockForRead(client,shopId) {
      requireClient(client);
      await lockPublication(client,shopId,{relation});
    },

    async requirePublished({
      client,
      shopId,
      generationId,
      coverageRevision,
      datasets,
    }) {
      requireClient(client);
      // Acquire before the first protected read. READ COMMITTED takes a fresh
      // data snapshot after any wait for this shop's writer.
      await lockPublication(client,shopId,{relation});
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

    async lockForWrite(client,shopId) {
      requireClient(client);
      // The caller owns BEGIN/COMMIT/ROLLBACK; the lock lasts until transaction end.
      await lockPublication(client,shopId,{write:true,relation});
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
        await this.lockForWrite(client,shopId);
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
