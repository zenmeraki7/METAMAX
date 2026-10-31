import test from "node:test";
import assert from "node:assert/strict";
import { getFilterBindingRegistry } from "../bindings.js";
import { createInstalledFilterHttpRuntime } from "../../services/filter-engine.server.js";
import { verifyInstalledFilterSchema } from "../../services/filter-schema.server.js";
import { catalogPool } from "./catalog-fixture.js";

test("installed metadata cannot enable HTTP queries against an absent physical mirror", async () => {
  assert.equal(getFilterBindingRegistry().listFieldIds().length, 28);
  const unexpected = () => assert.fail("Unverified mirror reached session, publication or execution queries");
  const f = catalogPool();
  delete f.state.tables.products;
  await assert.rejects(() => verifyInstalledFilterSchema({ database: f.pool }), { code: "FIELD_CONTRACT_MISMATCH" });
  await assert.rejects(() => createInstalledFilterHttpRuntime({
    database: f.pool,
    sessionStorage: { loadSession: unexpected },
    fieldServiceFactory: unexpected,
    coverageRepository: { getPublishedSnapshot: unexpected },
    publishedContextRepository: { getPublishedContext: unexpected },
  }), { code: "FIELD_CONTRACT_MISMATCH" });
  assert.equal(f.state.commands.at(-1).sql, "ROLLBACK");
  assert.ok(f.state.released > 0);
});

test("installed HTTP bootstrap rejects caller-controlled schema and mapping overrides", () => {
  for (const property of ["schema", "fieldMappings", "mirrorSchemaVersion", "sourceContractVersion", "barrierTable"]) {
    assert.throws(() => createInstalledFilterHttpRuntime({ [property]: undefined }), /Unsupported filter bootstrap/);
  }
});
