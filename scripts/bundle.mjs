// Bundles each MCP server into a single ESM file: no `npm install` or `tsc` step on the user machine.
// Also regenerates THIRD_PARTY_NOTICES.md from the npm packages that ended up inside the bundles,
// because their licences require their copyright notice to travel with the bundled code.
import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const servers = ["regression-tracer", "workflow-gate", "apk-inspector", "ticket-reader", "docs-lookup"]
  .filter((s) => existsSync(join(root, "mcp", s, "src", "server.ts")));

const packages = new Map(); // "name@version" -> { name, version, license, text }

function collectPackage(inputPath) {
  const m = inputPath.replace(/\\/g, "/").match(/^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (!m) return;
  const dir = join(root, m[1]);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return; }
  const id = `${pkg.name}@${pkg.version}`;
  if (packages.has(id)) return;
  const licenseFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\..*)?$/i.test(f));
  packages.set(id, {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see package",
    text: licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : "(no licence file shipped with the package)",
  });
}

for (const name of servers) {
  const outfile = join(root, "bundle", `${name}.mjs`);
  const result = await build({
    entryPoints: [join(root, "mcp", name, "src", "server.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    metafile: true,
    // Some CommonJS dependencies expect require() inside an ESM bundle.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    legalComments: "none",
    logLevel: "warning",
  });
  for (const input of Object.keys(result.metafile.inputs)) collectPackage(input);
  console.log(`${name}: ${(statSync(outfile).size / 1024).toFixed(0)} KB -> bundle/${name}.mjs`);
}

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = [
  "# Third-party notices",
  "",
  "Proofbench is MIT-licensed (see `LICENSE`). The pre-built files in `bundle/` include the open-source npm packages listed below, each under its own licence, reproduced here as those licences require.",
  "",
  "No code from other AI-agent projects is included: the MCP servers and skills in this repository are original work.",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
  ...list.flatMap((p) => [`## ${p.name} ${p.version}`, "", "```text", p.text, "```", ""]),
].join("\n");
writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), out);
console.log(`THIRD_PARTY_NOTICES.md: ${list.length} packages`);
