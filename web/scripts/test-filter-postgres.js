/** Disposable local PostgreSQL only; no application DATABASE_URL is read. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, realpath, access } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import pg from "pg";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await realpath(tmpdir());
const arguments_ = process.argv.slice(2);
if (arguments_.some(value => !["--roles","--schema","--operations","--exports","--history","--history-upgrade","--phase1","--sync-progress"].includes(value)) || arguments_.length > 1) throw new Error("Unknown isolated test option");
const testFile = arguments_.includes("--roles") ? "security/runtime-roles.postgres.test.js" : arguments_.includes("--sync-progress") ? "services/catalog-import-progress.postgres.test.js" : arguments_.includes("--phase1") ? "filters/integration/phase1-postgres.test.js" : arguments_.some(value => ["--history","--history-upgrade"].includes(value)) ? "edit-history/integration/schema-v2.test.js" : arguments_.includes("--exports") ? "export/integration/postgres.test.js" : arguments_.includes("--operations") ? "prisma/operation-dispatch.test.js" : arguments_.includes("--schema") ? "prisma/schema.test.js" : "filters/integration/postgres.test.js";
let container;
let cluster, pgCtl, started = false;
function command(executable, args, timeout = 60000) {
  // PostgreSQL children can retain pg_ctl's pipe handles on Windows, causing
  // spawnSync to wait after pg_ctl exits. Server diagnostics go to postgres.log.
  const detachedServerControl = process.platform === "win32" && /pg_ctl\.exe$/i.test(executable);
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout,
    ...(detachedServerControl ? { stdio: "ignore" } : {}) });
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "Docker command failed");
  return result.stdout?.trim() ?? "";
}
const docker = (args, timeout) => command("docker", args, timeout);
try {
  const password = randomBytes(24).toString("hex");
  let port;
  if (process.env.FILTER_POSTGRES_BIN) {
    const bin = resolve(process.env.FILTER_POSTGRES_BIN), suffix = process.platform === "win32" ? ".exe" : "";
    pgCtl = join(bin, `pg_ctl${suffix}`);
    console.log(command(join(bin, `postgres${suffix}`), ["--version"]));
    cluster = await mkdtemp(join(temporaryRoot, "metamax-filter-pg-"));
    const passwordFile = join(cluster, "qa-password");
    await writeFile(passwordFile, password, { mode: 0o600 });
    command(join(bin, `initdb${suffix}`), ["-D", join(cluster, "data"), "-U", "postgres", "--pwfile", passwordFile,
      "--auth-host=scram-sha-256", "--auth-local=trust", "--no-locale", "--encoding=UTF8"]);
    port = await new Promise((resolvePort, reject) => {
      const server = createServer(); server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(String(port))); });
    });
    command(pgCtl, ["-D", join(cluster, "data"), "-l", join(cluster, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
    started = true;
    const client = new pg.Client({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres` });
    try { await client.connect(); await client.query("CREATE DATABASE metamax_filter_test"); }
    finally { await client.end(); }
  } else {
    docker(["info", "--format", "{{.ServerVersion}}"], 20000);
    container = docker(["run", "--detach", "--rm", "--memory", "256m", "--cpus", "1",
      "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`,
      "--env", "POSTGRES_DB=metamax_filter_test", "--env", "PGDATA=/var/lib/postgresql/data",
      "--tmpfs", "/var/lib/postgresql/data", "postgres:18-alpine"], 180000);
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid disposable container identity");
    port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  }
  if (!port) throw new Error("Disposable database must bind only localhost");
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/metamax_filter_test`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try { await client.connect(); await client.query("SELECT 1"); ready = true; }
    catch {} finally { await client.end().catch(() => {}); }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", testFile], {
    cwd, stdio: "inherit", windowsHide: true, timeout: 300000,
    env: { ...process.env, FILTER_TEST_DATABASE_URL: url, FILTER_TEST_DATABASE_ISOLATED: "1", HISTORY_TEST_UPGRADE: arguments_.includes("--history-upgrade") ? "1" : "0" },
  });
  process.exitCode = result.error || result.status !== 0 ? 1 : 0;
} catch (error) {
  console.error(`PostgreSQL integration tests could not run: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) {
    try { docker(["rm", "--force", container]); }
    catch { console.error("Disposable PostgreSQL cleanup failed; remove the test container."); process.exitCode = 1; }
  }
  if (cluster) {
    let running = started;
    try { await access(join(cluster, "data", "postmaster.pid")); running = true; } catch {}
    if (running) {
      try { command(pgCtl, ["-D", join(cluster, "data"), "-m", "fast", "-w", "stop"]); running = false; }
      catch { console.error(`Test PostgreSQL shutdown failed; cluster preserved: ${cluster}`); process.exitCode = 1; }
    }
    if (!running) {
      // Recursive deletion is restricted to this runner's own real temporary
      // directory. Never remove a configured binary folder or external cluster.
      const absolute = resolve(cluster);
      if (dirname(absolute) !== temporaryRoot || !basename(absolute).startsWith("metamax-filter-pg-") || await realpath(cluster) !== absolute) {
        throw new Error("Unsafe temporary cluster cleanup path");
      }
      await rm(absolute, { recursive: true });
    }
  }
}
