/**
 * Execution Engine validation boundary.
 *
 * Enforces unified validation for both fixed and dynamic fields across
 * edit submission, job planning, and mutation execution boundaries.
 * Delegates field value rules to ../fields/validate.js and operations to ../fields/operations.js.
 */
import { FieldError, FIELD_LIMITS, deepFreeze, isPlainRecord, ownValue, isCoverageToken } from "../fields/types.js";
import { requireValueField, checkSourceCoverage } from "../fields/sources.js";
import { requireResolvedField, parseMetafieldId } from "../fields/resolve.js";
import { validateFieldValue, requireValidFieldValue } from "../fields/validate.js";
import { assertValidChange, assertValidChanges } from "../fields/operations.js";

export class ExecutionValidationError extends FieldError {
  constructor(code, message, field = null) {
    super(code, message, field);
    this.name = "ExecutionValidationError";
  }
}

function checkedContext(context) {
  if (!isPlainRecord(context)) {
    throw new ExecutionValidationError("INVALID_EXECUTION_CONTEXT", "A plain execution context is required");
  }
  const shopId = ownValue(context, "shopId");
  if (typeof shopId !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId)) {
    throw new ExecutionValidationError("SHOP_CONTEXT_REQUIRED", "A verified canonical shop domain is required");
  }
  if (ownValue(context, "authorized") !== true) {
    throw new ExecutionValidationError("UNAUTHORIZED", "Context must establish authorized tenant execution");
  }
  return context;
}

/**
 * Boundary 1: Edit Submission.
 * Validates merchant submission and resolves dynamic fields into trusted descriptors.
 * Dynamic field definitions cannot bypass validation.
 */
export function validateSubmission(submission, context) {
  try {
    const verifiedContext = checkedContext(context);
    if (!isPlainRecord(submission)) {
      throw new ExecutionValidationError("INVALID_SUBMISSION", "Submission must be a plain object");
    }

    const submissionShopId = ownValue(submission, "shopId");
    if (submissionShopId !== undefined && submissionShopId !== verifiedContext.shopId) {
      throw new ExecutionValidationError("SHOP_MISMATCH", "Submission shopId does not match context");
    }

    const rawChanges = ownValue(submission, "changes");
    if (!Array.isArray(rawChanges) || rawChanges.length < 1 || rawChanges.length > FIELD_LIMITS.changes) {
      throw new ExecutionValidationError("INVALID_FIELD_CHANGES", "A bounded, nonempty changes array is required");
    }

    const resolvedChanges = [];
    const fieldsForCoverage = [];

    for (let i = 0; i < rawChanges.length; i++) {
      const change = ownValue(rawChanges, String(i));
      if (!isPlainRecord(change)) {
        throw new ExecutionValidationError("INVALID_FIELD_CHANGE", "Change must be a plain object");
      }

      const rawField = ownValue(change, "field");
      let resolvedDescriptor;

      if (typeof rawField === "string" && parseMetafieldId(rawField)) {
        // Dynamic string ID: MUST resolve against verified tenant registry.
        resolvedDescriptor = requireResolvedField(rawField, verifiedContext);
      } else {
        // Canonical string ID or already-resolved descriptor: verify identity.
        resolvedDescriptor = requireValueField(rawField);
      }

      // Validate the change through central operations validation.
      const validatedChange = assertValidChange({
        field: resolvedDescriptor,
        operation: ownValue(change, "operation"),
        value: ownValue(change, "value"),
      }, verifiedContext);

      resolvedChanges.push(validatedChange);
      fieldsForCoverage.push(resolvedDescriptor);
    }

    // Ensure no duplicate field changes in a single submission.
    const seen = new Set();
    for (const change of resolvedChanges) {
      if (seen.has(change.field)) {
        throw new ExecutionValidationError("DUPLICATE_FIELD_CHANGE", "A field can be changed only once", change.field);
      }
      seen.add(change.field);
    }

    return deepFreeze({
      ok: true,
      submission: {
        shopId: verifiedContext.shopId,
        changes: Object.freeze(resolvedChanges),
        fields: Object.freeze(fieldsForCoverage),
      },
      errors: [],
    });
  } catch (error) {
    if (error instanceof FieldError) {
      return deepFreeze({
        ok: false,
        errors: [{ code: error.code, field: error.field, message: error.message }],
      });
    }
    throw error;
  }
}

/**
 * Boundary 2: Job Planning.
 * Revalidates changes and verifies source dataset and per-definition coverage.
 * Previously validated requests are not trusted across this boundary.
 */
export function validatePlan(plan, context) {
  try {
    const verifiedContext = checkedContext(context);
    if (!isPlainRecord(plan)) {
      throw new ExecutionValidationError("INVALID_PLAN", "Plan must be a plain object");
    }

    const changes = ownValue(plan, "changes");
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > FIELD_LIMITS.changes) {
      throw new ExecutionValidationError("INVALID_FIELD_CHANGES", "A bounded, nonempty changes array is required");
    }

    // Revalidate changes to ensure integrity.
    const validatedChanges = assertValidChanges(changes, verifiedContext);

    // Verify source coverage for all involved fields (canonical and dynamic).
    const coverage = ownValue(verifiedContext, "coverage");
    if (coverage !== undefined) {
      const fieldDescriptors = changes.map(change => requireValueField(ownValue(change, "field")));
      const coverageResult = checkSourceCoverage(fieldDescriptors, coverage, verifiedContext);
      if (!coverageResult.ready) {
        throw new ExecutionValidationError(
          "COVERAGE_NOT_READY",
          "Source coverage is incomplete for planned fields",
          coverageResult.missing?.[0] || coverageResult.missingDefinitions?.[0]
        );
      }
    }

    return deepFreeze({
      ok: true,
      plan: {
        shopId: verifiedContext.shopId,
        changes: validatedChanges,
      },
      errors: [],
    });
  } catch (error) {
    if (error instanceof FieldError) {
      return deepFreeze({
        ok: false,
        errors: [{ code: error.code, field: error.field, message: error.message }],
      });
    }
    throw error;
  }
}

/**
 * Boundary 3: Pre-Mutation Execution.
 * Immediately before mutation execution, repeat checks whose inputs can become stale:
 * lease currency, fresh snapshot ID, and value validity.
 */
export function validateMutationPrecheck(step, context) {
  try {
    const verifiedContext = checkedContext(context);
    if (!isPlainRecord(step)) {
      throw new ExecutionValidationError("INVALID_MUTATION_STEP", "Mutation step must be a plain object");
    }

    // Check lease currency.
    const leaseExpiresAt = ownValue(verifiedContext, "leaseExpiresAt");
    if (leaseExpiresAt !== undefined && (typeof leaseExpiresAt !== "number" || leaseExpiresAt <= Date.now())) {
      throw new ExecutionValidationError("LEASE_EXPIRED", "Coordinator execution lease has expired");
    }

    // Check generation and snapshot consistency.
    const generation = ownValue(step, "generation");
    if (generation !== undefined && generation !== ownValue(verifiedContext, "generation")) {
      throw new ExecutionValidationError("GENERATION_MISMATCH", "Mutation step generation does not match current execution context");
    }

    const field = requireValueField(ownValue(step, "field"));
    const value = ownValue(step, "value");

    // Revalidate field value immediately before applying mutation.
    const validatedValue = requireValidFieldValue(field, value, { purpose: "edit" });

    return deepFreeze({
      ok: true,
      step: {
        field: field.id,
        value: validatedValue,
      },
      errors: [],
    });
  } catch (error) {
    if (error instanceof FieldError) {
      return deepFreeze({
        ok: false,
        errors: [{ code: error.code, field: error.field, message: error.message }],
      });
    }
    throw error;
  }
}
