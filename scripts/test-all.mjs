// Runs the four servers tests, then rebuilds the bundles and checks that they start.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npx" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

for (const s of ["regression-tracer", "workflow-gate", "apk-inspector", "ticket-reader", "docs-lookup"]) run("npx", ["vitest", "run"], join(root, "mcp", s));
run(process.execPath, [join(root, "scripts", "bundle.mjs")], root);
run(process.execPath, [join(root, "scripts", "smoke.mjs")], root);
