import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Shopify CLI launches this backend command; keep the recovery service running
// beside HTTP during development as it would be supervised in production.
const nodemon = fileURLToPath(
  new URL("../node_modules/nodemon/bin/nodemon.js", import.meta.url)
);
const children = ["index.js", "workers/run.js"].map((file) =>
  spawn(process.execPath, [nodemon, file, "--ignore", "./frontend"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "development" },
    stdio: "inherit",
  })
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code || 0));
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
