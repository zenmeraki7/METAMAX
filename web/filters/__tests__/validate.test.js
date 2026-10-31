import test from "node:test";
import assert from "node:assert/strict";
import * as validation from "../validate.js";
import * as compiler from "../compile.js";
import * as filters from "../index.js";

test("semantic validator exports no brand issuer or compiler capability", () => {
  assert.deepEqual(Object.keys(validation), ["FILTER_EXECUTION_LIMITS", "assertAuthorizedFilterService", "createFilterService"]);
  assert.throws(() => validation.assertAuthorizedFilterService({}), { code: "FIELD_PERMISSION_DENIED" });
  assert.deepEqual(Object.keys(compiler), ["FILTER_COMPILER_VERSION", "assertCompiledFilter", "createFilterCompiler"]);
  assert.equal(filters.createFilterService, validation.createFilterService);
  for (const key of ["createFilterBindingRegistry", "getFilterBindingRegistry", "assertFilterBindingRegistry",
    "markValidatedFilter", "assertValidatedFilter", "getValidatedFilterBinding", "compileSql", "compileFilter"]) {
    assert.equal(Object.hasOwn(filters, key), false);
  }
  assert.equal(typeof filters.fingerprintFilterExecution, "function");
  assert.equal(typeof filters.describeFilterFailure, "function");
});

test("semantic validation is available only through a configured service", () => {
  assert.equal(Object.hasOwn(validation, "validateFilter"), false);
  assert.equal(Object.hasOwn(filters, "validateFilter"), false);
  assert.throws(() => validation.createFilterService(), TypeError);
  assert.throws(() => validation.createFilterService({}), TypeError);
});

test("forged trust flags and permissive callbacks cannot configure semantic validation", () => {
  let called = false;
  const forgedContext = {
    trusted: true, validated: true, authorized: true, shopId: "forged.myshopify.com",
    authorizeAccess: async () => { called = true; return true; },
    verifyCoverage: async () => { called = true; return { ready: true }; },
    markValidatedFilter: () => { called = true; },
  };
  assert.throws(() => validation.createFilterService(forgedContext), TypeError);
  assert.equal(called, false);
});

test("a service lookalike cannot replace the authenticated field resolver", () => {
  assert.throws(() => validation.createFilterService({ fieldService: {
    requireFields() {}, assertResolution() {}, revalidateResolution() {},
  } }), { code: "FIELD_PERMISSION_DENIED" });
});
