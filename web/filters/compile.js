/** Complete product-ID queries with optional signed keysets; no SQL execution. */
import {
  createFilterService,
  FILTER_EXECUTION_LIMITS as L,
} from "./validate.js";
import { getFilterBindingRegistry } from "./bindings.js";
import { quoteIdentifier as q, quoteQualifiedTable } from "./mirror-schema.js";
import {
  assertVerifiedMirrorSqlSchema,
  assertVerifiedFieldBinding,
  assertCursorOrdering,
  revalidateMirrorSqlSchema,
} from "./mirror-schema-verify.js";
import { assertSqlParameters } from "./sql-parameters.js";
import { assertCursorService } from "./pagination.js";
import * as sources from "../fields/sources.js";
import {
  FieldError,
  FIELD_ERROR_CODES as C,
  isPlainObject,
} from "../fields/types.js";
import { createFilterResolver, assertResolvedFilterPlan } from "./resolver.js";

// Object identity is the capability; copied or deserialized SQL is never trusted.
// Keep issuer metadata private so execution can also enforce compiler ownership.
const ISSUED_QUERIES = new WeakMap();
const CATALOG_FIELDS = Object.freeze([
  "product.id",
  "product.title",
  "product.handle",
  "product.vendor",
  "product.productType",
  "product.status",
  "product.tags",
  "variant.id",
  "variant.inventoryQuantity",
]);
export const FILTER_COMPILER_VERSION = 4;

export function createFilterCompiler({
  fieldService,
  physicalSchema,
  cursorService,
} = {}) {
  assertVerifiedMirrorSqlSchema(physicalSchema);
  const service = createFilterService({ fieldService });
  const registry = getFilterBindingRegistry();
  const physicalResolver = createFilterResolver({
    physicalSchema,
    bindingRegistry: registry,
  });
  const declared = registry.schema,
    physical = physicalSchema.schema;
  if (!physicalSchema.fieldMappings.length)
    throw new FieldError(
      C.CONTRACT_MISMATCH,
      "Approved canonical column bindings required",
    );
  for (const field of physicalSchema.fieldMappings) {
    const binding = registry.requireBinding(field.fieldId);
    if (
      binding.sourceKind !== "column" ||
      binding.datasets.some((name) => !["products", "variants"].includes(name))
    ) {
      throw new FieldError(
        C.UNSUPPORTED_OPERATION,
        "Only product/variant scalar dataset columns are enabled",
      );
    }
    const source = Object.getOwnPropertyDescriptor(
      sources.FIELD_SOURCES,
      field.fieldId,
    )?.value;
    const mapping =
      source && Object.getOwnPropertyDescriptor(source, "sql")?.value;
    const column =
      mapping && Object.getOwnPropertyDescriptor(mapping, "column")?.value;
    const type =
      mapping && Object.getOwnPropertyDescriptor(mapping, "storageType")?.value;
    assertVerifiedFieldBinding(
      physicalSchema,
      field.fieldId,
      binding.entity,
      column,
      type,
    );
  }
  if (cursorService !== undefined) {
    assertCursorService(cursorService);
    assertCursorOrdering(physicalSchema);
  }
  if (
    declared.mirrorSchemaVersion !== physicalSchema.mirrorSchemaVersion ||
    declared.sourceContractVersion !== physicalSchema.sourceContractVersion ||
    declared.product.idColumn !== physical.products.id ||
    declared.product.shopColumn !== physical.products.shop ||
    declared.product.generationColumn !== physical.products.generation ||
    declared.variant.schema !== physical.variants.schema ||
    declared.variant.table !== physical.variants.table ||
    declared.variant.productIdColumn !== physical.variants.productId ||
    declared.variant.shopColumn !== physical.variants.shop ||
    declared.variant.generationColumn !== physical.variants.generation
  ) {
    throw new FieldError(
      C.CONTRACT_MISMATCH,
      "Compiler/physical schema contract mismatch",
    );
  }
  const ownResolutions = new WeakMap();
  const ownedPlans = new WeakSet();
  const ownQueries = new WeakMap();
  const queryContracts = new WeakMap();
  const validatedContexts = new WeakMap();
  function requireResolutionPlan(contract) {
    assertVerifiedMirrorSqlSchema(physicalSchema);
    const plan =
      contract && typeof contract === "object" && ownResolutions.get(contract);
    if (!plan)
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Compiler-owned resolution plan required",
      );
    assertResolvedFilterPlan(plan.physicalPlan);
    if (
      plan.physicalPlan.schemaFingerprint !== physicalSchema.fingerprint ||
      plan.physicalPlan.registryFingerprint !== registry.fingerprint
    ) {
      throw new FieldError(
        C.CONTRACT_MISMATCH,
        "Compiler resolution plan changed",
      );
    }
    return plan;
  }
  function assertPredicatePlan(predicate, plan) {
    const reject = () => {
      throw new FieldError(
        C.CONTRACT_MISMATCH,
        "Compiled predicate differs from its resolution plan",
      );
    };
    const keys = Object.keys(plan.binding);
    if (
      Object.keys(predicate.binding).length !== keys.length ||
      keys.some((key) => predicate.binding[key] !== plan.binding[key])
    )
      reject();
    const expected = new Map(
      plan.physicalColumns.map((column) => [column.fieldId, column]),
    );
    if (predicate.physicalColumns.length !== expected.size) reject();
    for (const column of predicate.physicalColumns) {
      const approved = expected.get(column.fieldId);
      if (
        !approved ||
        ["entity", "column", "type"].some(
          (key) => column[key] !== approved[key],
        )
      )
        reject();
      expected.delete(column.fieldId);
    }
    if (expected.size) reject();
  }
  function cursorIdentity(query) {
    return {
      fingerprint: query.binding.filterFingerprint,
      schemaFingerprint: physicalSchema.fingerprint,
      shopId: query.binding.shopId,
      generationId: query.binding.generationId,
      idType: physicalSchema.productIdType,
      ordering:
        physicalSchema.productIdType === "text"
          ? "text:C"
          : `${physicalSchema.productIdType}:native`,
    };
  }
  const compiler = Object.freeze({
    getResolutionPlan(contract) {
      // Metadata inspection only; compileFilter still performs live checks.
      return requireResolutionPlan(contract);
    },
    getExecutionPlan(query) {
      assertCompiledFilter(query, compiler);
      const plan = ownQueries.get(query);
      if (!plan || !ownedPlans.has(plan.resolutionPlan))
        throw new FieldError(
          C.PERMISSION_DENIED,
          "Compiler-owned query resolution required",
        );
      return plan;
    },
    async authorizeExecution(query, authContext) {
      // Provenance identifies the retained contract; it never caches permission.
      const plan = compiler.getExecutionPlan(query);
      const predicate = await service.compileFilter(queryContracts.get(query), {
        authContext,
      });
      assertCompiledFilter(query, compiler);
      assertPredicatePlan(predicate, plan.resolutionPlan);
      if (plan.catalog)
        await fieldService.revalidateResolution(plan.catalog.resolution, {
          authContext,
        });
    },
    async validateFilter(input, context) {
      assertVerifiedMirrorSqlSchema(physicalSchema);
      // Reject uninstalled field families before authorization/coverage adapters
      // or SQL preflight. This structural plan grants no execution authority.
      physicalResolver.resolve(input);
      const contract = await service.validateFilter(input, context);
      // Capture the genuine resolver snapshot only after semantic validation,
      // then bind its exact physical mappings to this compiler's schema proof.
      assertVerifiedMirrorSqlSchema(physicalSchema);
      const resolved = service.getResolutionPlan(contract);
      const approved = new Set(
        physicalSchema.fieldMappings.map((field) => field.fieldId),
      );
      if (resolved.fieldIds.some((id) => !approved.has(id)))
        throw new FieldError(
          C.UNSUPPORTED_OPERATION,
          "Field has no approved physical binding",
        );
      for (const field of resolved.physicalColumns) {
        assertVerifiedFieldBinding(
          physicalSchema,
          field.fieldId,
          field.entity,
          field.column,
          field.type,
        );
      }
      const physicalPlan = physicalResolver.resolve(contract.ast);
      const plan = Object.freeze({
        ...resolved,
        physicalPlan,
        schemaFingerprint: physicalSchema.fingerprint,
        bindingRegistryVersion: registry.fingerprint,
      });
      assertPredicatePlan(
        {
          binding: resolved.binding,
          physicalColumns: physicalPlan.fields.map(
            (field) => field.physicalColumn,
          ),
        },
        plan,
      );
      if (
        JSON.stringify(physicalPlan.datasets) !== JSON.stringify(plan.datasets)
      ) {
        throw new FieldError(
          C.CONTRACT_MISMATCH,
          "Resolved dataset plans disagree",
        );
      }
      ownResolutions.set(contract, plan);
      validatedContexts.set(contract, context);
      ownedPlans.add(plan);
      return contract;
    },
    createCursor(query, lastProductId) {
      assertVerifiedMirrorSqlSchema(physicalSchema);
      if (!cursorService || !ownQueries.has(query))
        throw new FieldError(
          C.PERMISSION_DENIED,
          "Owned query and configured cursor service required",
        );
      return cursorService.issue(cursorIdentity(query), lastProductId);
    },
    async compileFilter(contract, raw) {
      if (!isPlainObject(raw))
        throw new FieldError(
          C.PERMISSION_DENIED,
          "Authenticated compiler context required",
        );
      const options = Object.create(null);
      for (const key of Reflect.ownKeys(raw)) {
        const d = Object.getOwnPropertyDescriptor(raw, key);
        if (
          typeof key !== "string" ||
          !["authContext", "pageSize", "cursor", "catalog"].includes(key) ||
          !d ||
          !Object.hasOwn(d, "value")
        ) {
          throw new FieldError(
            C.PERMISSION_DENIED,
            "Unsupported compiler context; unverified cursors are prohibited",
          );
        }
        options[key] = d.value;
      }
      const pageSize =
        options.pageSize === undefined ? L.DEFAULT_PAGE_SIZE : options.pageSize;
      if (
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > L.MAX_PAGE_SIZE
      ) {
        throw new FieldError(C.INVALID_VALUE, "Invalid query page size");
      }
      assertVerifiedMirrorSqlSchema(physicalSchema);
      const resolutionPlan = requireResolutionPlan(contract);
      await revalidateMirrorSqlSchema(physicalSchema);
      // validate.js owns same-variant correlation. Plans describe dependencies;
      // never rebuild predicates or split variant conditions from a field list.
      const predicate = await service.compileFilter(contract, {
        authContext: options.authContext,
      });
      if (options.catalog !== undefined && options.catalog !== true)
        throw new FieldError(C.INVALID_VALUE, "Invalid catalog projection");
      let catalog = null;
      if (options.catalog) {
        if (
          physical.products.schema !== "mirror" ||
          physical.products.table !== "products" ||
          physical.products.id !== "id" ||
          physicalSchema.productIdType !== "bigint" ||
          physical.variants.schema !== "mirror" ||
          physical.variants.table !== "variants" ||
          physical.variants.productId !== "product_id"
        ) {
          throw new FieldError(
            C.CONTRACT_MISMATCH,
            "Catalog projection requires the installed mirror schema",
          );
        }
        const context = validatedContexts.get(contract);
        const resolution = await fieldService.requireFields({
          authContext: options.authContext,
          operation: "filter",
          access: "read",
          fieldIds: CATALOG_FIELDS,
          executionContext: context.executionContext,
        });
        if (
          resolution.shopId !== predicate.binding.shopId ||
          resolution.generationId !== predicate.binding.generationId ||
          resolution.coverageRevision !== predicate.binding.coverageRevision
        )
          throw new FieldError(
            C.PERMISSION_DENIED,
            "Catalog projection binding mismatch",
          );
        for (const fieldId of CATALOG_FIELDS) {
          const field = sources.FIELD_SOURCES[fieldId];
          assertVerifiedFieldBinding(
            physicalSchema,
            fieldId,
            field.entity,
            field.sql.column,
            field.sql.storageType,
          );
        }
        catalog = Object.freeze({
          resolution,
          countText: `SELECT count(*)::text AS count FROM ${quoteQualifiedTable(physical.products.schema, physical.products.table)} AS ${q(declared.product.alias)} WHERE ${predicate.text}`,
          countValues: predicate.values,
        });
      }
      // Authorization/coverage may await; a migration fence during that await
      // must prevent issuance if a migration revokes the freshly checked schema.
      assertVerifiedMirrorSqlSchema(physicalSchema);
      assertPredicatePlan(predicate, resolutionPlan);
      const currentPlan = physicalResolver.resolve(contract.ast);
      if (
        JSON.stringify(currentPlan) !==
        JSON.stringify(resolutionPlan.physicalPlan)
      ) {
        throw new FieldError(
          C.CONTRACT_MISMATCH,
          "Physical resolution plan changed",
        );
      }
      for (const binding of predicate.physicalColumns) {
        assertVerifiedFieldBinding(
          physicalSchema,
          binding.fieldId,
          binding.entity,
          binding.column,
          binding.type,
        );
      }
      const alias = q(declared.product.alias),
        id = `${alias}.${q(physical.products.id)}`;
      const ordering =
        physicalSchema.productIdType === "text"
          ? `${id} COLLATE "pg_catalog"."C"`
          : id;
      const parameters = [...predicate.values],
        types = [...predicate.parameterTypes];
      let cursorClause = "";
      if (options.cursor !== undefined) {
        if (!cursorService)
          throw new FieldError(
            C.PERMISSION_DENIED,
            "Signed cursor service required",
          );
        const position = cursorService.verify(
          options.cursor,
          cursorIdentity(predicate),
        );
        parameters.push(position.lastProductId);
        types.push(physicalSchema.productIdType);
        const right = `$${parameters.length}::${physicalSchema.productIdType}`;
        cursorClause = ` AND (${ordering} > ${physicalSchema.productIdType === "text" ? `${right} COLLATE "pg_catalog"."C"` : right})`;
      }
      parameters.push(pageSize + 1);
      types.push("integer");
      const values = Object.freeze(parameters);
      assertSqlParameters(values, types, L.MAX_SQL_PARAMETERS);
      const text =
        `SELECT ${id} AS product_id FROM ${quoteQualifiedTable(physical.products.schema, physical.products.table)} AS ${alias} ` +
        `WHERE ${predicate.text}${cursorClause} ORDER BY ${ordering} ASC LIMIT $${values.length}::integer`;
      if (Buffer.byteLength(text, "utf8") > 65536)
        throw new FieldError(
          C.INVALID_VALUE,
          "Compiled query byte budget exceeded",
        );
      const datasets = catalog
        ? Object.freeze(
            [
              ...new Set([
                ...resolutionPlan.datasets,
                ...catalog.resolution.datasets,
              ]),
            ].sort(),
          )
        : resolutionPlan.datasets;
      const result = Object.freeze({
        version: FILTER_COMPILER_VERSION,
        kind: catalog ? "catalog_product_ids" : "product_ids",
        text,
        values,
        parameterCount: values.length,
        pageSize,
        binding: predicate.binding,
        schemaFingerprint: physicalSchema.fingerprint,
        resolverVersion: resolutionPlan.physicalPlan.version,
        requiredDatasets: datasets,
      });
      ownQueries.set(
        result,
        Object.freeze({
          binding: predicate.binding,
          datasets,
          resolutionPlan,
          ...(catalog ? { catalog } : {}),
        }),
      );
      queryContracts.set(result, contract);
      ISSUED_QUERIES.set(result, { physicalSchema, compiler });
      return result;
    },
  });
  return compiler;
}

/** Provenance only. Execution still requires a publication lease and fresh authorization. */
export function assertCompiledFilter(value, compiler) {
  if (!value || typeof value !== "object" || !ISSUED_QUERIES.has(value))
    throw new FieldError(C.PERMISSION_DENIED, "Untrusted compiled query");
  const issued = ISSUED_QUERIES.get(value);
  if (compiler !== undefined && issued.compiler !== compiler)
    throw new FieldError(
      C.PERMISSION_DENIED,
      "Query belongs to another compiler",
    );
  assertVerifiedMirrorSqlSchema(issued.physicalSchema);
  return value;
}
