/** Installed mirror target. Metadata only; callers must run catalog verification. */
import { FIELD_SOURCES, FILTER_SQL_SCHEMA } from "../fields/sources.js";
import { getFilterBindingRegistry } from "../filters/bindings.js";
import { createMirrorSqlSchema } from "../filters/mirror-schema.js";
import { verifyMirrorSqlSchema } from "./mirror-schema.server.js";
import { deepFreeze } from "../fields/types.js";
import { createFilterCompiler } from "../filters/compile.js";

export function getInstalledFilterSchemaOptions() {
  const registry = getFilterBindingRegistry();
  return deepFreeze({
    schema: createMirrorSqlSchema({
      products: { schema: "mirror", table: "products", id: "id", shop: "shop_id", generation: "generation_id" },
      variants: { schema: "mirror", table: "variants", productId: "product_id", shop: "shop_id", generation: "generation_id" },
    }),
    fieldMappings: registry.listFieldIds().map(fieldId => {
      const field = registry.requireBinding(fieldId), sql = FIELD_SOURCES[fieldId].sql;
      return { fieldId, entity: field.entity, column: sql.column, type: sql.storageType };
    }),
    mirrorSchemaVersion: FILTER_SQL_SCHEMA.mirrorSchemaVersion,
    sourceContractVersion: FILTER_SQL_SCHEMA.sourceContractVersion,
  });
}

export function verifyInstalledFilterSchema({ database } = {}) {
  return verifyMirrorSqlSchema({ ...getInstalledFilterSchemaOptions(), database });
}

/** Await before accepting requests. Catalog metadata alone never issues a compiler. */
export async function createInstalledFilterCompiler({ database, fieldService, cursorService } = {}) {
  const physicalSchema = await verifyInstalledFilterSchema({ database });
  const compiler = createFilterCompiler({ fieldService, cursorService, physicalSchema });
  return Object.freeze({ compiler, physicalSchema });
}
