import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMetafieldRegistry,
  resolveField,
  requireResolvedField,
  validateFieldValue,
  validateFieldValues,
  validateEditOperation,
  assertValidChange,
  resolveFieldValue,
  FieldError,
} from "../../fields/index.js";
import {
  validateSubmission,
  validatePlan,
  validateMutationPrecheck,
  ExecutionValidationError,
} from "../../execution/index.js";

const shopId = "unified-test.myshopify.com";
const otherShop = "other-shop.myshopify.com";

const definitions = [
  {
    owner: "product",
    namespace: "custom",
    key: "material",
    type: "single_line_text_field",
    definitionVersion: "v1",
    validations: [
      { name: "min", value: "3" },
      { name: "max", value: "10" },
    ],
  },
  {
    owner: "variant",
    namespace: "custom",
    key: "weight",
    type: "number_decimal",
    definitionVersion: "v1",
    validations: [
      { name: "min", value: "0.5" },
      { name: "max", value: "100.0" },
      { name: "max_precision", value: "2" },
    ],
  },
  {
    owner: "product",
    namespace: "custom",
    key: "badge",
    type: "single_line_text_field",
    definitionVersion: "v1",
    validations: [
      { name: "choices", value: JSON.stringify(["NEW", "FEATURED", "CLEARANCE"]) },
    ],
  },
];

const registry = createMetafieldRegistry(shopId, definitions, {
  generation: "gen-1",
  snapshotId: "snap-1",
});

const context = Object.freeze({
  shopId,
  authorized: true,
  coverageReady: true,
  writeAdapterReady: true,
  undoJournalReady: true,
  completedDatasets: ["products"],
  metafields: registry,
  scopes: ["write_products", "read_products"],
  generation: "gen-1",
  snapshotId: "snap-1",
});

test("unified validation validates trusted resolved dynamic descriptors against definition rules", () => {
  const material = requireResolvedField("metafield:product:custom.material", context);
  const weight = requireResolvedField("metafield:variant:custom.weight", context);
  const badge = requireResolvedField("metafield:product:custom.badge", context);

  // Material text length constraints [3, 10]
  assert.equal(validateFieldValue(material, "Cotton", { purpose: "read" }).valid, true);
  assert.equal(validateFieldValue(material, "Al", { purpose: "read" }).code, "BELOW_MINIMUM_LENGTH");
  assert.equal(validateFieldValue(material, "ExtraLongMaterialName", { purpose: "read" }).code, "ABOVE_MAXIMUM_LENGTH");
  assert.equal(validateFieldValue(material, "Line1\nLine2", { purpose: "read" }).code, "INVALID_SINGLE_LINE_TEXT");

  // Weight decimal constraints [0.5, 100.0], max precision 2
  assert.equal(validateFieldValue(weight, "10.50", { purpose: "read" }).valid, true);
  assert.equal(validateFieldValue(weight, "0.1", { purpose: "read" }).code, "BELOW_MINIMUM");
  assert.equal(validateFieldValue(weight, "150.0", { purpose: "read" }).code, "ABOVE_MAXIMUM");
  assert.equal(validateFieldValue(weight, "10.555", { purpose: "read" }).code, "MAX_PRECISION_EXCEEDED");

  // Badge choices
  assert.equal(validateFieldValue(badge, "FEATURED", { purpose: "read" }).valid, true);
  assert.equal(validateFieldValue(badge, "UNKNOWN_CHOICE", { purpose: "read" }).code, "INVALID_CHOICE");
});

test("raw dynamic strings and forged descriptor clones cannot bypass validation", () => {
  const rawId = "metafield:product:custom.material";
  const material = requireResolvedField(rawId, context);

  // Raw dynamic string has no static canonical entry and fails closed:
  assert.equal(validateFieldValue(rawId, "Cotton", { purpose: "read" }).code, "UNKNOWN_FIELD");
  assert.equal(validateEditOperation(rawId, "set", "Cotton").code, "UNKNOWN_FIELD");

  // Clones and serialized objects lack WeakMap provenance and fail closed:
  const cloned = { ...material };
  assert.equal(validateFieldValue(cloned, "Cotton", { purpose: "read" }).code, "UNKNOWN_FIELD");
  assert.equal(validateEditOperation(cloned, "set", "Cotton").code, "UNKNOWN_FIELD");

  const deserialized = JSON.parse(JSON.stringify(material));
  assert.equal(validateFieldValue(deserialized, "Cotton", { purpose: "read" }).code, "UNKNOWN_FIELD");
});

test("operations API correctly gates dynamic descriptors through requireValueField", () => {
  const material = requireResolvedField("metafield:product:custom.material", context);

  // Dynamic fields currently have editable: false in metadata registry
  const opResult = validateEditOperation(material, "set", "Cotton");
  assert.equal(opResult.valid, false);
  assert.equal(opResult.code, "OPERATION_NOT_SUPPORTED");

  // Canonical field works seamlessly with the same API:
  const canonicalResult = validateEditOperation("product.title", "set", "Summer T-Shirt");
  assert.equal(canonicalResult.valid, true);
  assert.equal(canonicalResult.value, "Summer T-Shirt");
});

test("resolveFieldValue accepts canonical descriptors and fails closed on dynamic descriptors without adapter", () => {
  const title = resolveField("product.title");
  const material = requireResolvedField("metafield:product:custom.material", context);

  const mockProduct = {
    data: {
      title: "Handcrafted Mug",
    },
  };

  assert.equal(resolveFieldValue(title, mockProduct), "Handcrafted Mug");
  assert.throws(() => resolveFieldValue(material, mockProduct), {
    code: "NOT_SUPPORTED",
  });
});

test("validateSubmission resolves dynamic fields, validates tenancy, and enforces change contracts", () => {
  // Submission with canonical field
  const canonicalSub = {
    shopId,
    changes: [
      { field: "product.title", operation: "set", value: "Autumn Hat" },
    ],
  };

  const validResult = validateSubmission(canonicalSub, context);
  assert.equal(validResult.ok, true);
  assert.equal(validResult.submission.changes.length, 1);
  assert.equal(validResult.submission.changes[0].value, "Autumn Hat");

  // Submission with shop mismatch fails
  const badShopResult = validateSubmission({ ...canonicalSub, shopId: otherShop }, context);
  assert.equal(badShopResult.ok, false);
  assert.equal(badShopResult.errors[0].code, "SHOP_MISMATCH");

  // Submission with duplicate field change fails
  const dupResult = validateSubmission({
    shopId,
    changes: [
      { field: "product.title", operation: "set", value: "Title 1" },
      { field: "product.title", operation: "set", value: "Title 2" },
    ],
  }, context);
  assert.equal(dupResult.ok, false);
  assert.equal(dupResult.errors[0].code, "DUPLICATE_FIELD_CHANGE");

  // Dynamic field without edit capability fails closed safely
  const dynamicSub = {
    shopId,
    changes: [
      { field: "metafield:product:custom.material", operation: "set", value: "Silk" },
    ],
  };
  const dynamicResult = validateSubmission(dynamicSub, context);
  assert.equal(dynamicResult.ok, false);
  assert.equal(dynamicResult.errors[0].code, "OPERATION_NOT_SUPPORTED");
});

test("validatePlan revalidates changes and verifies source coverage across execution boundaries", () => {
  const plan = {
    changes: [
      { field: "product.title", operation: "set", value: "New Title" },
    ],
  };

  // Plan revalidation succeeds when coverage is satisfied
  const coverageOkContext = {
    ...context,
    coverage: {
      shopId,
      generation: "gen-1",
      snapshotId: "snap-1",
      datasets: { products: true, variants: true },
      definitions: {},
    },
  };

  const planResult = validatePlan(plan, coverageOkContext);
  assert.equal(planResult.ok, true);
  assert.equal(planResult.plan.changes[0].field, "product.title");

  // Plan revalidation fails if coverage is missing required datasets
  const coverageMissingContext = {
    ...context,
    coverage: {
      shopId,
      generation: "gen-1",
      snapshotId: "snap-1",
      datasets: { products: false, variants: true },
      definitions: {},
    },
  };
  const missingResult = validatePlan(plan, coverageMissingContext);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.errors[0].code, "COVERAGE_NOT_READY");
});

test("validateMutationPrecheck detects stale inputs, expired leases, and revalidates values", () => {
  const step = {
    field: "product.title",
    value: "Final Verified Title",
    generation: "gen-1",
  };

  // Pre-mutation check succeeds with valid unexpired lease
  const freshContext = {
    ...context,
    leaseExpiresAt: Date.now() + 60000,
  };
  const freshResult = validateMutationPrecheck(step, freshContext);
  assert.equal(freshResult.ok, true);
  assert.equal(freshResult.step.value, "Final Verified Title");

  // Pre-mutation check rejects expired lease
  const expiredContext = {
    ...context,
    leaseExpiresAt: Date.now() - 1000,
  };
  const expiredResult = validateMutationPrecheck(step, expiredContext);
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.errors[0].code, "LEASE_EXPIRED");

  // Pre-mutation check rejects mismatched generation token
  const genMismatchStep = { ...step, generation: "gen-stale" };
  const genResult = validateMutationPrecheck(genMismatchStep, freshContext);
  assert.equal(genResult.ok, false);
  assert.equal(genResult.errors[0].code, "GENERATION_MISMATCH");

  // Pre-mutation check rejects invalid field value
  const invalidValueStep = { ...step, value: "" };
  const valResult = validateMutationPrecheck(invalidValueStep, freshContext);
  assert.equal(valResult.ok, false);
  assert.equal(valResult.errors[0].code, "INVALID_FIELD_VALUE");
});
