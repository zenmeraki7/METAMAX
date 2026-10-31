import test from "node:test";
import assert from "node:assert/strict";
import { describeFilterFailure, FilterInfrastructureError } from "../errors.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { FilterAstError, FILTER_AST_ERROR_CODES as E } from "../ast.js";

test("filter failure responses distinguish input, permission, coverage, contracts and infrastructure", () => {
  const secret = "database password and SQL details";
  for (const [error, status, code, retryable] of [
    [new FilterAstError(E.INVALID_AST, secret), 400, "FILTER_INVALID_INPUT", false],
    [new FieldError(C.INVALID_VALUE, secret), 400, "FILTER_INVALID_INPUT", false],
    [new FieldError(C.PERMISSION_DENIED, secret), 403, "FILTER_PERMISSION_DENIED", false],
    [new FieldError(C.MISSING_DEPENDENCY, secret), 503, "FILTER_COVERAGE_UNAVAILABLE", true],
    [new FieldError(C.CONTRACT_MISMATCH, secret), 500, "FILTER_CONTRACT_FAILURE", false],
    [new FieldError(C.INVALID_SOURCE, secret), 500, "FILTER_CONTRACT_FAILURE", false],
    [new FilterInfrastructureError(new Error(secret)), 503, "FILTER_INFRASTRUCTURE_UNAVAILABLE", true],
    [new FieldError(C.EXECUTION_UNAVAILABLE, secret), 503, "FILTER_INFRASTRUCTURE_UNAVAILABLE", true],
    [new Error(secret), 500, "FILTER_INTERNAL_FAILURE", false],
  ]) {
    const result = describeFilterFailure(error);
    assert.equal(result.status, status); assert.equal(result.code, code); assert.equal(result.retryable, retryable);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(Object.isFrozen(result));
  }
});
