import test,{mock} from "node:test";
import assert from "node:assert/strict";
import { createLegacyArtifactExportService } from "./export.server.js";
import { createImportPreviewService } from "./import-preview.server.js";
const actualRuntime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...actualRuntime,assertRuntimeDatabaseProfile(){}}});
const {createSchedulesService}=await import('./schedules.server.js');
import { createSavedFiltersService } from "./saved-filters.server.js";

test("I/O services cannot initialize without trusted authorization and durable dependencies", () => {
  assert.throws(() => createLegacyArtifactExportService({database:{query(){}}}), /Export requires/);
  assert.throws(() => createImportPreviewService({database:{query(){}}}), /Import previews require/);
});

test("schedules service: discovery persists occurrences without selection, approval or dispatch", async () => {
  const shopId = "schedule-test.myshopify.com";
  let scheduleState = {
    id: "sched-1",
    shop_id: shopId,
    recurrence: "DAILY",
    operation: "bulk_edit",
    template: { filter: { version: 1 }, contractPayload: { action: "discount" } },
    fence: 0,
  };

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("mirror.job_schedules") && sql.includes("FOR UPDATE OF j SKIP LOCKED")) {
        return { rows: [scheduleState] };
      }
      if(sql.includes("INSERT INTO mirror.schedule_occurrences"))return {rows:[{id:"occurrence",shop_id:shopId,schedule_id:scheduleState.id}]};
      if (sql.includes("UPDATE mirror.job_schedules") && sql.includes("SET lease_token = $1")) {
        scheduleState.fence += 1;
        return { rowCount: 1 };
      }
      if (sql.includes("UPDATE mirror.job_schedules") && sql.includes("lease_token = null")) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  mockDb.connect=async()=>({query:mockDb.query,release(){}});
  scheduleState.next_run_at=new Date();

  let freshSelectionCreated = false;
  const mockSelection = {
    async createSelection() {
      freshSelectionCreated = true;
      return { snapshotId: "fresh-snap-1", shopId };
    },
  };

  let freshContractApproved = false;
  const mockApproval = {
    async approveContract() {
      freshContractApproved = true;
      return { contractId: "fresh-contract-1" };
    },
  };

  let dispatched = false;
  const mockDispatch = {
    async dispatchBulkEdit() {
      dispatched = true;
      return { commandId: "cmd-sched-1" };
    },
  };

  const service = createSchedulesService({
    database: mockDb,workerDatabase:mockDb,
    selectionService: mockSelection,
    approvalService: mockApproval,
    jobDispatchService: mockDispatch,
    getScheduleAuthContext: async () => Object.freeze({}),
    resolveShop:async()=>shopId,
  });

  const triggered = await service.triggerDueSchedules({ workerId: "sched-worker" });

  assert.equal(triggered.length, 1);
  assert.equal(freshSelectionCreated, false);
  assert.equal(freshContractApproved, false);
  assert.equal(dispatched, false);
});

test("saved filters: stores AST recipe and revalidates semantically on load", async () => {
  const shopId = "saved-test.myshopify.com";
  const authContext=Object.freeze({});
  let stored = null;

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO mirror.saved_filters")) {
        stored = {
          id: params[1],
          shop_id: params[0],
          name: params[2],
          ast_version: params[3],
          ast: params[4],
          fingerprint: params[5],
        };
        return { rows: [stored] };
      }
      if (sql.includes("FROM mirror.saved_filters") && sql.includes("WHERE shop_id = $1 AND id = $2")) {
        return { rows: [stored] };
      }
      return { rows: [] };
    },
  };

  let validatedCalled = false;
  const mockCompiler = {
    async validateFilter(ast) {
      validatedCalled = true;
      return { valid: true, ast };
    },
  };

  const service = createSavedFiltersService({
    database: mockDb,
    compiler: mockCompiler,
    resolveShop:async context=>{assert.equal(context,authContext);return shopId;},
    resolveDatasets:async()=>({executionContext:{operationId:"saved",generationId:"gen",coverageRevision:"rev"}}),
  });

  const saved = await service.saveFilter({
    authContext,
    name: "Summer Products",
    ast: { version: 1, root: { kind: "condition", field: "product.title", operator: "contains", value: "Summer" } },
  });

  assert.ok(saved.id);
  assert.equal(saved.name, "Summer Products");

  const loaded = await service.loadAndValidateFilter({
    authContext,
    filterId: saved.id,
  });

  assert.equal(loaded.name, "Summer Products");
  stored.fingerprint='0'.repeat(64);
  await assert.rejects(()=>service.loadAndValidateFilter({authContext,filterId:saved.id}),{code:'FIELD_CONTRACT_MISMATCH'});
  assert.equal(validatedCalled, true);
});
