/**
 * METAMAX — Field Engine Public API
 *
 * Only stable, supported interfaces belong here. Internal implementations
 * remain available through explicit server-only imports.
 * Low-level normalizers require trusted descriptors and constraints; HTTP
 * controllers must never forward request-supplied field objects to them.
 */

// Canonical field registry
export {
  CANONICAL_FIELD_COUNT,
  CANONICAL_REGISTRY_INFO,
  getCanonicalField,
  requireCanonicalField,
  listCanonicalFields,
} from "./canonical.js";

// Canonical type definitions
export {
  FIELD_TYPES,
  FIELD_ERROR_CODES,
  FieldError,
  isFieldType,
  isNumericType,
  isSortableType,
} from "./types.js";

// Reusable normalization
export {
  normalizeFieldValue,
  normalizeOperatorOperand,
} from "./normalize.js";

// Trusted field constraints
export {
  POLICY_CONTEXT,
  WRITE_OPERATIONS,
  WRITE_OPERAND_KIND,
  WRITE_OPERATION_OPERANDS,
  normalizeWriteOperand,
  validateFinalWriteValue,
  getFieldConstraints,
  getFieldPolicy,
  assertFieldWriteOperation,
  listFieldWriteOperations,
  getFieldClearResult,
} from "./constraints.js";

// Authorized field service
export {
  FIELD_ACCESS,
  FIELD_ORIGINS,
  createFieldService,
} from "./resolve.js";
