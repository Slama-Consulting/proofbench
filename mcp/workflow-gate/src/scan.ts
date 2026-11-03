import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./exec.js";
import { addProof, gitOut, meets, repoState, stepOf, type Finding, type Gate } from "./gate.js";
import { gitLines } from "./git.js";
import {
  CONFIG_FILE_RE, GREP_PREFILTER, HARMLESS_KEY_RE, isPlaceholder, KEYSTORE_RE, maskValue, SECRET_PATTERNS, TEMPLATE_FILE_RE, UNQUOTED_RE, VALUE_FILE_RE, VALUE_LINE_RE,
} from "./secrets.js";

const MAX_FINDINGS = 200;
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const SKIPPED_MANIFEST_RE = /(^|\/)src\/(debug|test|androidTest)\//;
const EXPORTABLE = "activity|activity-alias|service|receiver|provider";

/** Collects while deduplicating on the value without keeping it: only its hash stays in memory. */
class Collector {
  readonly findings: Finding[] = [];
  total = 0;
  private readonly seen = new Set<string>();

  private record(kind: string, value: string, masked: string, where: Where): void {
    const key = createHash("sha256").update(`${where.source}\0${where.file}\0${value}`).digest("hex");
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.total += 1;
    if (this.findings.length < MAX_FINDINGS) this.findings.push({ ...where, kind, masked });
  }

  add(line: string, where: Where): void {
    for (const p of SECRET_PATTERNS) {
      for (const match of line.matchAll(p.re)) {
        const value = match[1] as string;
        if (p.visible > 0 || !isPlaceholder(value)) this.record(p.kind, value, maskValue(value, p.visible), where);
      }
    }
    if (CONFIG_FILE_RE.test(where.file)) {
      for (const match of line.matchAll(UNQUOTED_RE)) {
        const value = match[1] as string;
        if (!isPlaceholder(value)) this.record("assigned", value, maskValue(value, 0), where);
      }
    }
    if (VALUE_FILE_RE.test(where.file) && !TEMPLATE_FILE_RE.test(where.file)) {
      const [, name, value] = VALUE_LINE_RE.exec(line) ?? [];
      if (name && value && !line.trimStart().startsWith("#") && !HARMLESS_KEY_RE.test(name) && !isPlaceholder(value)) {
        this.record("config", value, maskValue(value, 0), where);
      }
    }
  }

  /** The file itself is the secret: it has no value, its name is enough. */
  addName(where: Where): void {
    if (KEYSTORE_RE.test(where.file)) this.record("keystore", where.file, "***", where);
  }
}

type Where = Omit<Finding, "kind" | "masked"> & { source: string; file: string };

function pathOfDiffLine(raw: string): string {
  const unquoted = raw.replace(/\t$/, "").replace(/^"(.*)"$/, "$1");
  return unquoted.replace(/^b\//, "");
}

async function scanHead(gate: Gate, sha: string, found: Collector, timeoutMs: number): Promise<string | null> {
  const names = (await gitOut(gate.repo, ["ls-tree", "-r", "-z", "--name-only", sha])).split("\0").filter(Boolean);
  for (const file of names) {
    const where = { source: "head", file, commit: sha };
    found.addName(where);
    if (!VALUE_FILE_RE.test(file)) continue;
    for (const line of (await gitOut(gate.repo, ["show", "--no-textconv", "--no-ext-diff", `${sha}:${file}`])).split(/\r?\n/)) found.add(line, where);
  }
  const args = ["grep", "-I", "-n", "-z", "-i", "--no-color", "--no-textconv", "-E", "-e", GREP_PREFILTER, sha, "--"];
  const r = await gitLines(gate.repo, args, (line) => {
    const [location, lineNumber, ...text] = line.split("\0");
    if (location === undefined || lineNumber === undefined) return;
    found.add(text.join("\0"), { source: "head", file: location.slice(sha.length + 1), commit: sha, line: lineNumber });
  }, timeoutMs);
  // git grep exits with 1 when nothing matches.
  return r.code === 0 || r.code === 1 ? null : `git grep: code ${r.code}`;
}

async function scanHistory(gate: Gate, found: Collector, timeoutMs: number): Promise<string | null> {
  let commit = "";
  let file = "";
  // Between `diff --git` and the first `@@` we are in the header: only there does `+++ ` name a file.
  let inHeader = false;
  const args = ["log", "--all", "-m", "-p", "--no-ext-diff", "--no-textconv", "--no-color", "--format=%x01%H"];
  const r = await gitLines(gate.repo, args, (line) => {
    if (line.startsWith("\u0001")) {
      commit = line.slice(1);
    } else if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = pathOfDiffLine(line.slice(line.lastIndexOf(" b/") + 1));
      found.addName({ source: "history", file, commit });
    } else if (line.startsWith("@@")) {
      inHeader = false;
    } else if (inHeader) {
      if (line.startsWith("+++ ") && line !== "+++ /dev/null") file = pathOfDiffLine(line.slice(4));
    } else if (line.startsWith("+")) {
      found.add(line.slice(1), { source: "history", file, commit });
    }
  }, timeoutMs);
  return r.code === 0 ? null : `git log: code ${r.code}`;
}

/** What is not committed yet and that git could pick up on the next `add`. */
async function scanUntracked(gate: Gate, found: Collector): Promise<void> {
  const files = (await gitOut(gate.repo, ["ls-files", "-o", "--exclude-standard", "-z"])).split("\0").filter((p) => p && !p.endsWith("/") && !p.startsWith(".proofbench/"));
  for (const file of files) {
    const where = { source: "untracked", file, commit: "untracked" };
    found.addName(where);
    const full = join(gate.repo, file);
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue;
    for (const line of bytes.toString("utf8").split(/\r?\n/)) found.add(line, where);
  }
}

export async function scanSecrets(gate: Gate, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
  const step = stepOf(gate, "secrets");
  const state = await repoState(gate.repo, gate.watchIgnored);
  const found = new Collector();
  const failure = (await scanHead(gate, state.sha, found, timeoutMs)) ?? (await scanHistory(gate, found, timeoutMs));
  await scanUntracked(gate, found);
  const proof = addProof(gate, step, state, {
    command: ["git grep HEAD", "git log -m -p --all", "untracked files"],
    // An incomplete walk has no code: it means neither "nothing found" nor "found".
    exitCode: failure ? null : found.total > 0 ? 1 : 0,
    output: `${found.total} finding(s)`,
    findings: found.findings,
    ...(failure ? { failure } : {}),
  });
  return { step: step.id, exitCode: proof.exitCode, ok: meets(step, proof), total: found.total, findings: found.findings, failure: proof.failure };
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" };

/** A single pass: `&amp;#116;` stays text. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|apos|amp|lt|gt));/gi, (whole, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : Number.parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attrs(raw: string): Map<string, string> {
  return new Map([...raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1] as string, decodeEntities(m[2] ?? m[3] ?? "").trim()]));
}

function tags(xml: string, names: string): { tag: string; attrs: Map<string, string>; body: string }[] {
  const re = new RegExp(`<(${names})\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>`, "g");
  return [...xml.matchAll(re)].map((m) => {
    const end = m[3] === "/" ? -1 : xml.indexOf(`</${m[1]}>`, m.index);
    return { tag: m[1] as string, attrs: attrs(m[2] as string), body: end === -1 ? "" : xml.slice(m.index, end) };
  });
}

/** The app's entry point must be exported: that is not a finding. */
const isLauncher = (body: string) => body.includes("android.intent.action.MAIN") && body.includes("android.intent.category.LAUNCHER");

const ANDROID_URI = "http://schemas.android.com/apk/res/android";

/** The prefixes bound to the Android URI, read from real opening tags: one file may bind several. */
function androidPrefixes(xml: string): string[] {
  const bound = new Set<string>();
  for (const tag of xml.matchAll(/<[A-Za-z][\w:.-]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    for (const [name, value] of attrs(tag[1] as string)) {
      if (name.startsWith("xmlns:") && value === ANDROID_URI) bound.add(name.slice("xmlns:".length));
    }
  }
  return bound.size > 0 ? [...bound] : ["android"];
}

export function auditManifest(text: string, file: string): Finding[] {
  // A single alternation, left to right: a `<!--` inside a CDATA opens nothing, and vice versa.
  const xml = text.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "");
  const prefixes = androidPrefixes(xml);
  const values = (a: Map<string, string>, name: string) => prefixes.flatMap((p) => a.get(`${p}:${name}`) ?? []);
  /** Anything other than a literal `false`: `@bool/x` or `${y}` may be true at build time. */
  const maybeTrue = (a: Map<string, string>, name: string) => values(a, name).some((v) => v.toLowerCase() !== "false");
  const findings: Finding[] = [];
  const add = (rule: string, detail: string, component?: string) => findings.push({ file, rule, detail, ...(component ? { component } : {}) });
  for (const { attrs: a } of tags(xml, "application")) {
    const backup = values(a, "allowBackup");
    if (backup.length === 0) add("allowBackup", "allowBackup absent, true by default");
    else if (maybeTrue(a, "allowBackup")) add("allowBackup", "allowBackup=true");
    if (maybeTrue(a, "debuggable")) add("debuggable", "debuggable=true");
    if (maybeTrue(a, "usesCleartextTraffic")) add("cleartext", "usesCleartextTraffic=true");
  }
  for (const { tag, attrs: a, body } of tags(xml, EXPORTABLE)) {
    const declared = values(a, "exported");
    const exported = declared.length > 0 ? maybeTrue(a, "exported") : body.includes("<intent-filter");
    const both = values(a, "readPermission").length > 0 && values(a, "writePermission").length > 0;
    const guarded = values(a, "permission").length > 0 || (tag === "provider" && both);
    if (exported && !guarded && !isLauncher(body)) add("exported", "exported component without permission", values(a, "name")[0] ?? "(no name)");
  }
  return findings;
}

const BUILD_FILE_RE = /^build\.gradle(\.kts)?$/;

/** "Not applicable" has to be proved: the whole repo on disk, ignored files and submodules included, without following links. */
function looksAndroid(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "AndroidManifest.xml" || BUILD_FILE_RE.test(entry.name)) {
      if (entry.isSymbolicLink()) return true;
    } else if (entry.isSymbolicLink()) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && looksAndroid(full)) return true;
    } else if (entry.name === "AndroidManifest.xml") {
      return true;
    } else if (BUILD_FILE_RE.test(entry.name) && readFileSync(full, "utf8").includes("com.android")) {
      return true;
    }
  }
  return false;
}

export async function scanManifest(gate: Gate) {
  const step = stepOf(gate, "manifest");
  const state = await repoState(gate.repo, gate.watchIgnored);
  const listed = (await gitOut(gate.repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .split("\0")
    .filter((p) => p === "AndroidManifest.xml" || p.endsWith("/AndroidManifest.xml"));
  const skipped = listed.filter((p) => SKIPPED_MANIFEST_RE.test(p));
  const read = listed.filter((p) => !SKIPPED_MANIFEST_RE.test(p) && lstatSync(join(gate.repo, p), { throwIfNoEntry: false })?.isFile());
  const findings = read.flatMap((p) => auditManifest(readFileSync(join(gate.repo, p), "utf8"), p));
  // Reading nothing proves nothing: code 2 is neither a finding nor a success.
  const exitCode = read.length === 0 ? 2 : findings.length > 0 ? 1 : 0;
  const proof = addProof(gate, step, state, { command: ["scan AndroidManifest.xml"], exitCode, output: `${read.length} manifest(s) read`, findings, ...(read.length === 0 && listed.length === 0 && !looksAndroid(gate.repo) ? { notApplicable: true } : {}) });
  return { step: step.id, exitCode, ok: meets(step, proof), read, skipped, findings };
}
