import { validateDynamicFieldPolicy } from "./constraints.js";
import { isPlainObject, deepFreeze, FieldError, FIELD_ERROR_CODES as C } from "./types.js";
import { METAFIELD_READ_ADAPTER, METAFIELD_WRITE_ADAPTER } from "./metafield-adapter.js";

function ownValue(record, key) {
  const descriptor = isPlainObject(record) && Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new FieldError(C.INVALID_DEFINITION, "Invalid metafield bridge record");
  }
  return descriptor.value;
}

function assertBinding(record, shopId, fieldId) {
  if (ownValue(record, "shopId") !== shopId || ownValue(record, "fieldId") !== fieldId) {
    throw new FieldError(C.PERMISSION_DENIED, "Metafield bridge ownership mismatch");
  }
  const definition = ownValue(record, "definition");
  const source = ownValue(record, "source");
  const policy = ownValue(record, "policy");
  const verification = ownValue(record, "verification");
  const definitionToken = ownValue(source, "definitionRevision");
  if (ownValue(definition, "id") !== fieldId || ownValue(source, "fieldId") !== fieldId ||
      ownValue(source, "adapterId") !== METAFIELD_READ_ADAPTER ||
      ownValue(source, "mutationAdapterId") !== (ownValue(definition, "editable") ? METAFIELD_WRITE_ADAPTER : null) ||
      ownValue(verification, "definitionToken") !== definitionToken ||
      ownValue(verification, "shopifyDefinitionId") !== ownValue(source, "definitionId")) {
    throw new FieldError(C.INVALID_SOURCE, "Metafield bridge binding mismatch", { fieldId });
  }
  validateDynamicFieldPolicy(policy, { shopId, field: definition, definitionToken });
  return deepFreeze(record);
}

/** Trusted backend bridge preserving the complete verified record and Map. */
export function createMetafieldResolverBridge(adapter) {
  if (!adapter || typeof adapter.resolveOne !== "function" ||
      typeof adapter.resolveBatch !== "function") {
    throw new TypeError("Trusted metafield adapter required");
  }

  return Object.freeze({
    dynamicResolver: async ({ shopId, fieldId }) => assertBinding(
      await adapter.resolveOne({ shopId, fieldId }), shopId, fieldId
    ),
    dynamicBatchResolver: async ({ shopId, fieldIds }) => {
      const records = await adapter.resolveBatch({ shopId, fieldIds });
      if (!(records instanceof Map) || records.size !== fieldIds.length) {
        throw new TypeError("Invalid metafield batch resolution");
      }
      for (const fieldId of fieldIds) {
        if (!records.has(fieldId)) {
          throw new TypeError("Missing metafield resolution");
        }
        assertBinding(records.get(fieldId), shopId, fieldId);
      }
      return records;
    },
  });
}
