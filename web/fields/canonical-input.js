import { requireCanonicalField } from "./canonical.js";
import { normalizeFieldValue } from "./normalize.js";

/**
 * Application-service helper for fixed canonical fields.
 * Controllers must pass a field ID, never a request-supplied descriptor.
 * Constraints must come from trusted server-side configuration, never from
 * the request body. This helper validates values; it does not authorize edits.
 * Bulk edits must separately check editable, field-specific permissions,
 * the approved execution contract, and mirror readiness.
 * Dynamically resolved fields use the trusted shop-scoped resolver when wired.
 */
export function normalizeCanonicalInput(fieldId, value, constraints = {}) {
  const field = requireCanonicalField(fieldId);
  return normalizeFieldValue(field, value, { constraints });
}
