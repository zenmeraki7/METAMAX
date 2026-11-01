import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("production filter dependencies resolve in a fresh process without module mocks", () => {
  const modules = ["../../mirror/coverage.js", "../../services/mirror-schema.server.js",
    "../../mirror/publication-service.server.js", "../../mirror/publication-repository.server.js", "../../services/filter-engine.server.js",
    "../../controllers/filters.controller.js", "../../routes/filters.routes.js", "../../services/filter-schema.server.js", "../resolver.js", "../index.js",
    "../../app.js", "../../security/tenant-db.server.js", "../../security/worker-gateway.server.js",
    "../../security/merchant-gateway.server.js", "../../edit-history/history-execution.server.js"];
  const urls = modules.map(path => new URL(path, import.meta.url).href);
  const source = `await Promise.all(${JSON.stringify(urls)}.map(url => import(url)));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
