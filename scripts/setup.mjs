#!/usr/bin/env node
// Installs Proofbench for a coding assistant: MCP servers, skills, and the block that triggers the router.
//
//   node scripts/setup.mjs <claude|copilot|codex|cursor|gemini|all> [options]
//
// Options
//   --project <dir>   project folder (copilot, cursor; defaults to the current folder)
//   --scope <s>       user | project (claude, codex; user by default)
//   --dry-run         print what would be done, write nothing
//   --uninstall       remove what this command installed
//   --home <dir>      override the home folder (tests)

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS = ["regression-tracer", "workflow-gate", "apk-inspector", "ticket-reader", "docs-lookup"];
const MARK_START = "<!-- proofbench:start -->";
const MARK_END = "<!-- proofbench:end -->";
const fwd = (p) => p.replace(/\\/g, "/");

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const client = argv.find((a) => !a.startsWith("--") && a !== opt("project") && a !== opt("scope") && a !== opt("home"));
const dry = flag("dry-run");
const uninstall = flag("uninstall");
const HOME = resolve(opt("home") ?? homedir());
const PROJECT = resolve(opt("project") ?? process.cwd());
const CLIENTS = ["claude", "copilot", "codex", "cursor", "gemini"];

if (!client || !(client === "all" || CLIENTS.includes(client))) {
  console.error(`Usage: node scripts/setup.mjs <${CLIENTS.join("|")}|all> [--project dir] [--scope user|project] [--dry-run] [--uninstall]`);
  process.exit(2);
}

// ---------- checks ----------
const bundle = (s) => join(ROOT, "bundle", `${s}.mjs`);
for (const s of SERVERS) {
  if (!existsSync(bundle(s))) {
    console.error(`bundle/${s}.mjs is missing. Run first: npm install && npm run bundle`);
    process.exit(1);
  }
}
if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error("Node 20 or later is required.");
  process.exit(1);
}

// ---------- operations ----------
const log = (msg) => console.log(`${dry ? "[dry-run] " : ""}${msg}`);

function backupOnce(file) {
  const bak = `${file}.proofbench.bak`;
  // Only the original file is worth saving: a copy that already contains Proofbench is useless.
  if (existsSync(file) && !existsSync(bak) && !/proofbench|regression-tracer/.test(readFileSync(file, "utf8"))) {
    if (!dry) copyFileSync(file, bak);
    log(`  backup ${bak}`);
  }
}

function skillNames() {
  return readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, "skills", d.name, "SKILL.md")))
    .map((d) => d.name);
}

function copySkills(dest) {
  for (const n of skillNames()) {
    const to = join(dest, n);
    if (uninstall) { log(`remove ${to}`); if (!dry) rmSync(to, { recursive: true, force: true }); continue; }
    log(`skill ${n} -> ${to}`);
    if (!dry) { mkdirSync(dest, { recursive: true }); cpSync(join(ROOT, "skills", n), to, { recursive: true }); }
  }
}

function upsertBlock(file, body) {
  const block = `${MARK_START}\n${body.trim()}\n${MARK_END}`;
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
  let next;
  if (uninstall) { next = cur.replace(re, ""); if (next === cur) return; log(`remove the Proofbench block from ${file}`); }
  else { next = re.test(cur) ? cur.replace(re, block + "\n") : (cur ? cur.replace(/\s*$/, "\n\n") : "") + block + "\n"; log(`Proofbench block -> ${file}`); }
  if (dry) return;
  backupOnce(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

function mergeJson(file, key, entries) {
  let data = {};
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, "utf8")); }
    catch { console.error(`  ${file} is not valid JSON: leaving it alone. Add by hand: ${JSON.stringify({ [key]: entries })}`); return; }
  } else if (uninstall) return;
  data[key] ??= {};
  for (const [name, def] of Object.entries(entries)) {
    if (uninstall) delete data[key][name]; else data[key][name] = def;
  }
  log(`${uninstall ? "remove MCP servers from" : "MCP servers ->"} ${file}`);
  if (dry) return;
  backupOnce(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function upsertToml(file) {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const body = SERVERS.map((s) => `[mcp_servers.${s}]\ncommand = "node"\nargs = ["${fwd(bundle(s))}"]`).join("\n\n");
  const block = `# proofbench:start\n${body}\n# proofbench:end`;
  const tomlRe = /# proofbench:start[\s\S]*?# proofbench:end\n?/;
  let next;
  if (uninstall) { next = cur.replace(tomlRe, ""); if (next === cur) return; }
  else next = tomlRe.test(cur) ? cur.replace(tomlRe, block + "\n") : (cur ? cur.replace(/\s*$/, "\n\n") : "") + block + "\n";
  log(`${uninstall ? "remove MCP servers from" : "MCP servers ->"} ${file}`);
  if (dry) return;
  backupOnce(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

const stdio = (s, extra = {}) => ({ ...extra, command: "node", args: [fwd(bundle(s))] });
const stdioAll = (extra) => Object.fromEntries(SERVERS.map((s) => [s, stdio(s, extra)]));

const BLOCK =
  "## Proofbench\n\n" +
  "Before answering any development request (bug analysis, regression, fix, new feature, cleanup, security, APK, ticket), " +
  "load the `using-proofbench` skill and follow it. It names the right skill.";

const blockWithPath = () =>
  BLOCK.replace("load the `using-proofbench` skill and follow it.", `read \`${fwd(join(ROOT, "skills", "using-proofbench", "SKILL.md"))}\` and follow it. The other skills are in \`${fwd(join(ROOT, "skills"))}/<name>/SKILL.md\`.`);

// ---------- clients ----------
const installers = {
  claude() {
    const scope = opt("scope") ?? "user";
    const base = scope === "project" ? join(PROJECT, ".claude") : join(HOME, ".claude");
    copySkills(join(base, "skills"));
    upsertBlock(scope === "project" ? join(PROJECT, "CLAUDE.md") : join(base, "CLAUDE.md"), BLOCK);
    for (const s of SERVERS) {
      const args = uninstall ? ["mcp", "remove", "--scope", scope, s] : ["mcp", "add", "--scope", scope, s, "--", "node", fwd(bundle(s))];
      log(`claude ${args.join(" ")}`);
      if (dry) continue;
      const r = spawnSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
      if (r.status !== 0) console.error(`  The command failed (is the \`claude\` CLI missing?). Run it yourself: claude ${args.join(" ")}`);
    }
  },
  copilot() {
    copySkills(join(PROJECT, ".github", "skills"));
    upsertBlock(join(PROJECT, ".github", "copilot-instructions.md"), BLOCK);
    mergeJson(join(PROJECT, ".vscode", "mcp.json"), "servers", stdioAll({ type: "stdio" }));
  },
  codex() {
    const project = (opt("scope") ?? "user") === "project";
    copySkills(project ? join(PROJECT, ".agents", "skills") : join(HOME, ".agents", "skills"));
    upsertBlock(project ? join(PROJECT, "AGENTS.md") : join(HOME, ".codex", "AGENTS.md"), BLOCK);
    upsertToml(project ? join(PROJECT, ".codex", "config.toml") : join(HOME, ".codex", "config.toml"));
  },
  cursor() {
    mergeJson(join(PROJECT, ".cursor", "mcp.json"), "mcpServers", stdioAll());
    const rule = join(PROJECT, ".cursor", "rules", "proofbench.mdc");
    if (uninstall) { log(`remove ${rule}`); if (!dry) rmSync(rule, { force: true }); return; }
    log(`rule -> ${rule}`);
    if (!dry) {
      mkdirSync(dirname(rule), { recursive: true });
      writeFileSync(rule, `---\ndescription: Proofbench, routing of development requests\nalwaysApply: true\n---\n\n${blockWithPath()}\n`);
    }
  },
  gemini() {
    const base = join(HOME, ".gemini");
    mergeJson(join(base, "settings.json"), "mcpServers", stdioAll());
    upsertBlock(join(base, "GEMINI.md"), `@${fwd(join(ROOT, "skills", "using-proofbench", "SKILL.md"))}\n\nThe other skills are in \`${fwd(join(ROOT, "skills"))}/<name>/SKILL.md\`.`);
  },
};

for (const c of client === "all" ? CLIENTS : [client]) {
  console.log(`\n== ${c} ${uninstall ? "(uninstall)" : ""}`);
  installers[c]();
}
console.log(uninstall ? "\nDone. Restart your assistant." : "\nDone. Restart your assistant, then ask for example: \"analyze this bug\".");
