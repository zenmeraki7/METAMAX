export { FIELD_TYPES, FIELD_LIMITS, FieldError, isFieldType, getFieldType, requireFieldType, listFieldTypes, isComparableType, isSortableType, isSearchableType } from "./types.js";
export {
  CANONICAL_FIELDS, FIELD_CONTRACT_VERSION, SHOPIFY_FIELD_API_VERSION,
  INVENTORY_FIELD_QUANTITIES, listFields, getCanonicalField, requireCanonicalField,
} from "./canonical.js";
export {
  FIELD_OPERATIONS, EDIT_OPERATIONS, FieldOperationError, getEditOperation, listEditOperations,
  listFieldOperations, supportsFieldOperation, requireFieldOperation, validateEditOperation, requireValidEditOperation,
} from "./operations.js";
export { normalizeFieldValue, FieldNormalizationError, normalizeValue as normalizeTypedValue } from "./normalize.js";
export { normalizeOperand, validateChange, assertValidChange, assertValidChanges } from "./operations.js";
import { isFieldType } from "./types.js";
import { normalizeValue as normalizeType } from "./normalize.js";
import { requireValidFieldValue } from "./validate.js";
// Compatibility for existing field-ID callers; new callers should use the explicit APIs.
export function normalizeValue(typeOrField, value) {
  return isFieldType(typeOrField) ? normalizeType(typeOrField, value) :
    requireValidFieldValue(typeOrField, value, { purpose: "read" });
}
export {
  CAPABILITIES, getCapabilities, getFieldCapabilities, hasFieldCapability, requireFieldCapability,
  listFieldsByCapability, listFieldCapabilities, checkFieldAvailability, assertFieldCapability,
} from "./capabilities.js";
export {
  resolveField, requireResolvedField, listResolvedFields, resolveSource, resolveFieldValue,
  makeMetafieldId, parseMetafieldId, createMetafieldRegistry, METAFIELD_OWNERS, FieldResolutionError,
} from "./resolve.js";
export {
  DATASETS, getFieldSource, requireFieldSource, listFieldSources,
  listDatasetFields, requiredDatasets, checkSourceCoverage,
} from "./sources.js";
export { validateValue, validateFieldValue, requireValidFieldValue, validateFieldValues, FieldValidationError } from "./validate.js";

export { checkMetafieldAccess } from "./metafields.js";
