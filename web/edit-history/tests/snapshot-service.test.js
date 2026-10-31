import test from "node:test";
import assert from "node:assert/strict";
import { createFieldService } from "../../fields/resolve.js";
import { createFilterService } from "../../filters/validate.js";
import { fingerprintFilterAst } from "../../filters/fingerprint.js";
import { createHistorySnapshotService } from "../snapshot-service.server.js";
import { CANONICAL_REGISTRY_INFO } from "../../fields/canonical.js";

async function fixture() {
  const state = { allowed: true, shopId: "alpha.myshopify.com", revision: "coverage1", approval: "approval1" };
  const authContext = { sessionId: "trusted-session" };
  const fieldService = createFieldService({
    adapter: { resolveOne() { assert.fail("Unexpected dynamic resolution"); }, resolveBatch() { assert.fail("Unexpected dynamic resolution"); } },
    resolveShop: async () => state.shopId,
    authorizeAccess: async () => state.allowed,
    verifyCoverage: async ({ executionContext }) => ({ ready: true, generationId: "generation1",
      coverageRevision: state.revision, targetingSnapshotId: executionContext.approvedTargetingSnapshot.snapshotId,
      mirrorSchemaVersion: "metamax_mirror_v1", sourceContractVersion: "metamax_sources_v1" }),
    verifyExecutionContext: async ({ shopId, operation, executionContext, targetingSnapshot }) => ({ approved: true,
      shopId, operation, operationId: executionContext.operationId, generationId: executionContext.generationId,
      targetingSnapshotId: targetingSnapshot.snapshotId, executionContractId: "contract1", approvalRevision: state.approval }),
  });
  const context = { authContext, operation: "bulk_edit", executionContext: { operationId: "job1", generationId: "generation1",
    approvedTargetingSnapshot: { shopId: state.shopId, snapshotId: "target1", generationId: "generation1", coverageRevision: state.revision } } };
  const filterService = createFilterService({ fieldService });
  const validatedFilter = await filterService.validateFilter({ version: 1,
    root: { kind: "condition", field: "product.title", operator: "eq", value: "Test" } }, context);
  const fieldResolution = await fieldService.requireFields({ ...context, fieldIds: ["variant.price"], access: "write" });
  const service = createHistorySnapshotService({ fieldService, filterService });
  const identity = { shopId: state.shopId, installationId: "install1", executionJobId: "1", executionItemId: "2",
    mutationId: "mutation1", resourceGid: "gid://shopify/ProductVariant/1", fieldId: "variant.price" };
  const input = { authContext, fieldResolution, validatedFilter, identity, kind: "BEFORE", valueKind: "VALUE", value: "12.5000",
    observation: { observationId: "observation1", source: "MIRROR_PINNED", observedAt: "2026-10-30T00:00:00.000Z",
      resourceGid: identity.resourceGid, fieldId: identity.fieldId, sourceRevision: "1", receiptId: "receipt1",
      receiptFingerprint: `sha256:${"a".repeat(64)}` } };
  return { state, service, input, fieldService, filterService, context };
}

test("history uses actual engine digests, canonical IDs and money normalization", async () => {
  const { service, input } = await fixture();
  const snapshot = await service.createSnapshot(input);
  assert.equal(snapshot.identity.fieldId, "variant.price");
  assert.equal(snapshot.value, "12.5");
  assert.equal(snapshot.binding.filterFingerprint, `sha256:${fingerprintFilterAst(input.validatedFilter.ast)}`);
  assert.equal(snapshot.binding.executionFingerprint, `sha256:${input.validatedFilter.fingerprint}`);
  assert.equal(snapshot.binding.fieldResolutionFingerprint, `sha256:${input.fieldResolution.registryVersion}`);
  assert.equal(snapshot.binding.mappingVersion, input.fieldResolution.registryVersion);
  assert.equal(snapshot.binding.fieldDefinitionRevision, String(CANONICAL_REGISTRY_INFO.registryVersion));
  const { kind, observation, ...intentInput } = input;
  const intent = await service.createIntent({ ...intentInput, beforeSnapshot: snapshot, value: "15.25",
    mutationPlanFingerprint: `sha256:${"b".repeat(64)}` });
  assert.equal(intent.intendedValue, "15.25");
  // Read observations may contain signed money; outgoing writes may not.
  assert.equal((await service.createSnapshot({ ...input, value: "-1" })).value, "-1");
  await assert.rejects(() => service.createIntent({ ...intentInput, beforeSnapshot: snapshot, value: "-1",
    mutationPlanFingerprint: `sha256:${"b".repeat(64)}` }));
});

test("forged services, copied resolutions and copied filters cannot issue history", async () => {
  const { service, input, fieldService, filterService } = await fixture();
  assert.throws(() => createHistorySnapshotService({ fieldService: { ...fieldService }, filterService }));
  assert.throws(() => createHistorySnapshotService({ fieldService, filterService: { ...filterService } }));
  await assert.rejects(() => service.createSnapshot({ ...input, fieldResolution: { ...input.fieldResolution } }));
  await assert.rejects(() => service.createSnapshot({ ...input, validatedFilter: { ...input.validatedFilter } }));
});

test("caller fields, bindings and fingerprints cannot override engine outputs", async () => {
  const { service, input } = await fixture();
  for (const extra of [{ binding: {} }, { field: {} }, { executionFingerprint: "invented" }]) {
    await assert.rejects(() => service.createSnapshot({ ...input, ...extra }));
  }
  for (const identity of [{ ...input.identity, fieldId: "price" }, { ...input.identity, shopId: "other.myshopify.com" }]) {
    await assert.rejects(() => service.createSnapshot({ ...input, identity }));
  }
});

test("live authorization, coverage and approval changes fail closed", async () => {
  for (const change of [{ allowed: false }, { shopId: "other.myshopify.com" }, { revision: "coverage2" }, { approval: "approval2" }]) {
    const { service, input, state } = await fixture();
    Object.assign(state, change);
    await assert.rejects(() => service.createSnapshot(input));
  }
});

test("history rejects mismatched approved targeting and invalid values", async () => {
  const { service, input, filterService, context } = await fixture();
  const otherFilter = await filterService.validateFilter(input.validatedFilter.ast, { ...context,
    executionContext: { ...context.executionContext, operationId: "otherJob" } });
  await assert.rejects(() => service.createSnapshot({ ...input, validatedFilter: otherFilter }));
  await assert.rejects(() => service.createSnapshot({ ...input, value: "invalid money" }));
  const { value, ...absent } = input;
  await assert.rejects(() => service.createSnapshot({ ...absent, valueKind: "ABSENT" }));
});
