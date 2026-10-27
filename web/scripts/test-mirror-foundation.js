// Database-only integration check. Refuses the app database and never needs Redis.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
const root = fileURLToPath(new URL("../", import.meta.url));
const test = parse(readFileSync(new URL("../.env.integration", import.meta.url)));
const app = parse(readFileSync(new URL("../.env", import.meta.url)));
const target = new URL(test.DIRECT_URL || test.DATABASE_URL);
const args = process.argv.slice(2);
let suite = "foundation";
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === "--host" && typeof args[i + 1] === "string" && /^ep-[a-z0-9-]+\.c-\d+\.[a-z0-9-]+\.aws\.neon\.tech$/.test(args[i + 1])) {
    target.hostname = args[i + 1];
    test.DATABASE_URL = target.toString();
  } else if (args[i] === "--suite" && ["foundation", "reconciliation"].includes(args[i + 1])) {
    suite = args[i + 1];
  } else throw Error("Expected --host <disposable Neon endpoint> or --suite foundation|reconciliation");
}
const canonicalHost = value => new URL(value).hostname.replace("-pooler.", ".");
if (!test.DATABASE_URL || [app.DIRECT_URL, app.DATABASE_URL].filter(Boolean).some(value => canonicalHost(value) === canonicalHost(target)))
  throw Error("A separate disposable integration database is required");
target.hostname = target.hostname.replace("-pooler.", ".");
const env = { ...process.env, ...test, DIRECT_URL: target.toString(), DATABASE_URL: test.DATABASE_URL, RUN_INTEGRATION_TESTS: "1" };
for (const args of [["node_modules/prisma/build/index.js", "migrate", "deploy"],
  ["node_modules/prisma/build/index.js", "generate"], ["--test", suite === "foundation" ? "tests/mirror-foundation.integration.test.js" : "tests/reconciliation-guarantees.integration.test.js"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) {
    let diagnostic = (result.stdout || "") + (result.stderr || "");
    for (const url of [test.DATABASE_URL, test.DIRECT_URL, app.DATABASE_URL, app.DIRECT_URL].filter(Boolean)) {
      diagnostic = diagnostic.split(url).join("[redacted connection]");
      const password = new URL(url).password;
      if (password) diagnostic = diagnostic.split(password).join("[redacted]").split(decodeURIComponent(password)).join("[redacted]");
    }
    process.stdout.write(diagnostic.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted connection]"));
    throw Error(`Isolated mirror foundation check failed (${args.includes("--test") ? "tests" : args.at(-1)})`);
  }
  if (args.includes("--test")) process.stdout.write(result.stdout);
  else console.log(`Isolated database: ${args.at(-1)} passed`);
}
