/** Safe response metadata only. Log the original error separately on the server. */
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { FilterAstError } from "./ast.js";

export const FILTER_FAILURE_CODES = Object.freeze({
  INVALID_FILTER: "FILTER_INVALID_INPUT",
  PERMISSION_DENIED: "FILTER_PERMISSION_DENIED",
  COVERAGE_UNAVAILABLE: "FILTER_COVERAGE_UNAVAILABLE",
  CONTRACT_FAILURE: "FILTER_CONTRACT_FAILURE",
  INFRASTRUCTURE_UNAVAILABLE: "FILTER_INFRASTRUCTURE_UNAVAILABLE",
  INTERNAL_FAILURE: "FILTER_INTERNAL_FAILURE",
});

/** Trusted adapters can wrap transient infrastructure errors without leaking details. */
export class FilterInfrastructureError extends Error {
  constructor(cause) {
    super("Filter infrastructure unavailable", { cause });
    this.name = "FilterInfrastructureError";
  }
}

export function describeFilterFailure(error) {
  let code = FILTER_FAILURE_CODES.INTERNAL_FAILURE, status = 500, retryable = false;
  let message = "Filter processing failed";
  if (error instanceof FilterAstError || (error instanceof FieldError &&
      [C.INVALID_TYPE, C.INVALID_VALUE, C.UNKNOWN_FIELD, C.UNSUPPORTED_OPERATION].includes(error.code))) {
    code = FILTER_FAILURE_CODES.INVALID_FILTER; status = 400; message = "Invalid filter";
  } else if (error instanceof FieldError && [C.PERMISSION_DENIED, C.READ_ONLY].includes(error.code)) {
    code = FILTER_FAILURE_CODES.PERMISSION_DENIED; status = 403; message = "Filter access denied";
  } else if (error instanceof FieldError && error.code === C.MISSING_DEPENDENCY) {
    code = FILTER_FAILURE_CODES.COVERAGE_UNAVAILABLE; status = 503; retryable = true;
    message = "Required filter data or services are unavailable";
  } else if (error instanceof FieldError && [C.INVALID_DEFINITION, C.INVALID_SOURCE, C.CONTRACT_MISMATCH].includes(error.code)) {
    code = FILTER_FAILURE_CODES.CONTRACT_FAILURE; message = "Filter contract requires revalidation";
  } else if (error instanceof FilterInfrastructureError || (error instanceof FieldError && error.code === C.EXECUTION_UNAVAILABLE)) {
    code = FILTER_FAILURE_CODES.INFRASTRUCTURE_UNAVAILABLE; status = 503; retryable = true;
    message = "Filter service temporarily unavailable";
  }
  return Object.freeze({ code, status, retryable, message });
}
