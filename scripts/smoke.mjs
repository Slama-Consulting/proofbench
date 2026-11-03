// Starts each bundle the way an MCP client would (stdio) and checks initialize + tools/list.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = { "regression-tracer": 18, "workflow-gate": 8, "apk-inspector": 8, "ticket-reader": 2, "docs-lookup": 4 };
let failed = false;

async function probe(name) {
  const child = spawn(process.execPath, [join(root, "bundle", `${name}.mjs`)], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name}: no response to ${method}`)), 15000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await call(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await call(2, "tools/list", {});
    const n = list.result.tools.length;
    const ok = n >= expected[name];
    console.log(`${ok ? "OK " : "KO "} ${name}: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${n} tools`);
    if (!ok) failed = true;
  } catch (e) {
    console.log(`KO  ${e.message}`);
    failed = true;
  } finally {
    child.kill();
  }
}

for (const name of Object.keys(expected)) await probe(name);
process.exit(failed ? 1 : 0);
