import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { addEvidence, type Evidence, type Investigation, type Snapshot } from "./investigation.js";
import { HISTORY_TRUNCATED_NOTE } from "./verdict.js";

export interface OriginCandidate {
  sha: string;
  author: string;
  date: string;
  subject: string;
  /** A hint, never a verdict: a commit with a hint remains a candidate. */
  hint: "cosmetic" | "dependency_bump" | "unknown";
}

export interface OriginResult {
  candidates: OriginCandidate[];
  shallow: boolean;
  evidenceIds: string[];
}

export interface ChangeSides {
  before: string;
  after: string;
  evidenceIds: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const IGNORE_REVS = ".git-blame-ignore-revs";
/** Maximum commits kept from the `git log -L` history (those from blame are always added). */
const MAX_LOG_COMMITS = 50;
const MAX_TEXT_FILE = 1024 * 1024;
const EVIDENCE_TEXT_CAP = 20_000;
const IGNORE_REVS_UNUSABLE_NOTE = `${IGNORE_REVS} unusable: origin computed without it`;
const LOG_FAILED_NOTE = "origin: git log -L failed, range history limited to blame";
const IGNORED_NOTE_PREFIX = ".git-blame-ignore-revs";
const UNREADABLE_NOTE_PREFIX = "unreadable commits";
const LOG_CAPPED_NOTE = `origin: range history limited to the ${MAX_LOG_COMMITS} most recent commits`;

const BUILD_FILES = new Set(["build.gradle", "build.gradle.kts", "libs.versions.toml", ".gitmodules"]);
const GITLINK_MODE = "160000";
const SOURCE_EXT = /\.(kt|kts|java|groovy|scala|swift|dart|js|jsx|ts|tsx|cs|go|rs|c|cc|cpp|h|hpp|m)$/i;
const KEYWORDS = new Set(
  (
    "abstract as assert boolean break byte case catch char class companion const constructor continue " +
    "data default do double else enum extends external false final finally float for fun get goto if " +
    "implements import in infix init inline inner instanceof int interface internal is it lateinit lazy " +
    "long native new null object open operator out override package private protected public return sealed " +
    "set short static super suspend switch synchronized this throw throws transient true try typealias " +
    "val var vararg void volatile when while yield let guard func struct self nil undefined typeof " +
    "function async await def lambda None True False pass from with elif except raise " +
    "and or not until downTo in is"
  ).split(/\s+/),
);

function failMessage(what: string, stderr: string): Error {
  return new Error(`${what}: ${stderr.trim() || "git failure"}`);
}

function checkLines(startLine: number, endLine: number): void {
  const ok = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!ok(startLine) || !ok(endLine) || startLine > endLine) {
    throw new Error(
      `Invalid line range: ${String(startLine)}-${String(endLine)} (positive integers, start <= end)`,
    );
  }
}

export function checkFile(file: string): void {
  if (typeof file !== "string" || file === "" || file.includes("\0") || file.includes("\n")) {
    throw new Error(`Invalid file path: ${JSON.stringify(file)}`);
  }
}

/** Resolves a reference to a full sha via git; never a caller value as is. */
async function resolveCommit(cwd: string, rev: string): Promise<string> {
  if (typeof rev !== "string" || rev === "" || rev.startsWith("-") || rev.includes("\0")) {
    throw new Error(`Invalid reference: ${JSON.stringify(rev)}`);
  }
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(sha)) throw new Error(`Commit not found: ${rev}`);
  return sha;
}

export async function markShallow(inv: Investigation, cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-shallow-repository"]);
  const shallow = r.code === 0 && r.stdout.trim() === "true";
  if (shallow) addNote(inv, HISTORY_TRUNCATED_NOTE);
  return shallow;
}

/** A counter note: replaces the previous one with the same prefix instead of accumulating. */
function setNote(inv: Investigation, prefix: string, note: string): void {
  inv.coverage.notExamined = inv.coverage.notExamined.filter((n) => !n.startsWith(`${prefix}: `));
  inv.coverage.notExamined.push(note);
}

export function addNote(inv: Investigation, note: string): void {
  if (!inv.coverage.notExamined.includes(note)) inv.coverage.notExamined.push(note);
}

/** Shas listed in .git-blame-ignore-revs (read-only, never a symbolic link). */
function readIgnoredRevs(cwd: string): { path: string; shas: Set<string> } | null {
  const p = join(cwd, IGNORE_REVS);
  try {
    if (!existsSync(p) || lstatSync(p).isSymbolicLink() || !lstatSync(p).isFile()) return null;
    const shas = new Set<string>();
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([0-9a-fA-F]{40})\b/.exec(raw);
      if (m) shas.add(m[1]!.toLowerCase());
    }
    return { path: p, shas };
  } catch {
    return null;
  }
}

async function blameShas(
  inv: Investigation,
  cwd: string,
  rev: string,
  file: string,
  startLine: number,
  endLine: number,
  ignore: { path: string } | null,
): Promise<string[]> {
  const base = ["blame", "--porcelain", "--no-textconv", "-w", "-M", "-C", "-L", `${startLine},${endLine}`];
  let r = ignore
    ? await git(cwd, [...base, "--ignore-revs-file", ignore.path, rev, "--", file])
    : await git(cwd, [...base, rev, "--", file]);
  if (r.code !== 0 && ignore) {
    addNote(inv, IGNORE_REVS_UNUSABLE_NOTE);
    r = await git(cwd, [...base, rev, "--", file]);
  }
  if (r.code !== 0) throw failMessage(`git blame failed on ${file}:${startLine}-${endLine}`, r.stderr);
  const shas: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m && !shas.includes(m[1]!)) shas.push(m[1]!);
  }
  return shas;
}

async function logShas(
  cwd: string,
  rev: string,
  file: string,
  startLine: number,
  endLine: number,
): Promise<{ shas: string[]; capped: boolean; failed: boolean }> {
  const r = await git(cwd, [
    "log", "-L", `${startLine},${endLine}:${file}`, "-s", "--no-ext-diff", "--no-textconv",
    `--max-count=${MAX_LOG_COMMITS + 1}`, "--format=%H", rev, "--",
  ]);
  if (r.code !== 0) return { shas: [], capped: false, failed: true };
  const all = r.stdout.split("\n").map((l) => l.trim()).filter((l) => SHA_RE.test(l));
  return { shas: all.slice(0, MAX_LOG_COMMITS), capped: all.length > MAX_LOG_COMMITS, failed: false };
}

interface RawChange {
  status: string;
  oldMode: string;
  newMode: string;
  path: string;
}

/** Files touched by a commit (first parent or root), without rename detection. */
async function changedFiles(cwd: string, sha: string): Promise<RawChange[] | null> {
  const r = await git(cwd, [
    "diff-tree", "-r", "-z", "--root", "--no-commit-id", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", sha,
  ]);
  if (r.code !== 0) return null;
  const tokens = r.stdout.split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ (\S+)$/.exec(tokens[i]!);
    if (!m) continue;
    const path = tokens[i + 1];
    if (path === undefined) return null;
    out.push({ oldMode: m[1]!, newMode: m[2]!, status: m[3]!, path });
    i++;
  }
  return out;
}

function isDependencyBump(changes: RawChange[]): boolean {
  if (changes.length === 0) return false;
  return changes.every((c) => {
    if (c.oldMode === GITLINK_MODE || c.newMode === GITLINK_MODE) return true;
    const base = c.path.split("/").pop() ?? c.path;
    return BUILD_FILES.has(base);
  });
}

const TOKEN_RE =
  /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|[\p{L}_$][\p{L}\p{N}_$]*|\p{N}[\p{L}\p{N}_.]*|\S/gu;
const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * True if the two sources differ only by whitespace or by a consistent renaming of identifiers
 * (bijection, no new name already present in the old text: an a<->b swap is not a renaming).
 */
function sameModuloRename(oldTexts: string[], newTexts: string[]): boolean {
  const fwd = new Map<string, string>();
  const back = new Map<string, string>();
  const oldNames = new Set<string>();
  const newNames = new Set<string>();
  const counts = new Map<string, number>();
  const declared = new Set<string>();
  for (let f = 0; f < oldTexts.length; f++) {
    const a = tokenize(oldTexts[f]!);
    const b = tokenize(newTexts[f]!);
    if (a.length !== b.length) return false;
    if (hasOpaqueText(oldTexts[f]!) || hasOpaqueText(newTexts[f]!)) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      const xi = isName(x);
      const yi = isName(y);
      if (xi) {
        oldNames.add(x);
        counts.set(x, (counts.get(x) ?? 0) + 1);
        if (isDeclaration(a, i)) declared.add(x);
      }
      if (yi) newNames.add(y);
      if (xi !== yi) return false;
      if (!xi) {
        if (x !== y) return false;
        continue;
      }
      if ((fwd.get(x) ?? y) !== y || (back.get(y) ?? x) !== x) return false;
      fwd.set(x, y);
      back.set(y, x);
    }
  }
  for (const [x, y] of fwd) {
    if (x === y) continue;
    if (oldNames.has(y) || newNames.has(x)) return false;
    // A real renaming: name declared in the old text and present at least twice (declaration + usage).
    if (!declared.has(x) || (counts.get(x) ?? 0) < 2) return false;
  }
  return true;
}

function isName(t: string): boolean {
  return IDENT_RE.test(t) && !KEYWORDS.has(t);
}

/** Raw strings and templates: their content depends on whitespace, so they are not compared token by token. */
function hasOpaqueText(text: string): boolean {
  return text.includes('"""') || text.includes("`");
}

const DECL_KEYWORDS = new Set(
  "val var fun class interface object enum typealias let const def func struct".split(" "),
);

/** Declaration: after a declaration keyword, typed parameter `(x:` / `, x:`, or `Type x =|;|,|)|:` (Java, C). */
function isDeclaration(tokens: string[], i: number): boolean {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  if (prev === undefined) return false;
  if (DECL_KEYWORDS.has(prev)) return true;
  if ((prev === "(" || prev === ",") && next === ":") return true;
  const typed = (IDENT_RE.test(prev) && !KEYWORDS.has(prev)) || prev === ">" || prev === "]";
  return typed && next !== undefined && [ "=", ";", ",", ")", ":" ].includes(next);
}

export async function blob(cwd: string, spec: string): Promise<string | null> {
  const r = await git(cwd, ["cat-file", "blob", spec]);
  return r.code === 0 ? r.stdout : null;
}

async function isRenameOnly(cwd: string, sha: string, changes: RawChange[]): Promise<boolean> {
  if (changes.length === 0) return false;
  const oldTexts: string[] = [];
  const newTexts: string[] = [];
  let total = 0;
  for (const c of changes) {
    if (c.status !== "M" || c.oldMode === GITLINK_MODE || c.newMode === GITLINK_MODE) return false;
    if (c.oldMode !== c.newMode || !SOURCE_EXT.test(c.path)) return false;
    const before = await blob(cwd, `${sha}^:${c.path}`);
    const after = await blob(cwd, `${sha}:${c.path}`);
    if (before === null || after === null) return false;
    total += before.length + after.length;
    if (total > MAX_TEXT_FILE) return false;
    oldTexts.push(before);
    newTexts.push(after);
  }
  return sameModuloRename(oldTexts, newTexts);
}

async function hintFor(cwd: string, sha: string, parentCount: number): Promise<OriginCandidate["hint"]> {
  if (parentCount > 1) return "unknown";
  const changes = await changedFiles(cwd, sha);
  if (changes && isDependencyBump(changes)) return "dependency_bump";
  if (changes && parentCount === 1 && (await isRenameOnly(cwd, sha, changes))) return "cosmetic";
  return "unknown";
}

interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
  parents: number;
  time: number;
}

async function commitInfo(cwd: string, sha: string): Promise<CommitInfo | null> {
  const r = await git(cwd, ["show", "-s", "--no-ext-diff", "--no-textconv", "--format=%H%x00%an%x00%aI%x00%s%x00%P%x00%ct", sha, "--"]);
  if (r.code !== 0) return null;
  const [h, author, date, subject, parents, ct] = r.stdout.replace(/\n+$/, "").split("\0");
  if (!h || !SHA_RE.test(h)) return null;
  return {
    sha: h,
    author: author ?? "",
    date: date ?? "",
    subject: subject ?? "",
    parents: (parents ?? "").split(" ").filter(Boolean).length,
    time: Number(ct) || 0,
  };
}

/**
 * Newest first. Commits from the same second (common after a rebase) are told apart by
 * topological order, obtained in a single `git rev-list --topo-order` call (never run without a tie).
 */
async function sortNewestFirst(cwd: string, infos: CommitInfo[]): Promise<void> {
  const rank = new Map<string, number>();
  if (new Set(infos.map((i) => i.time)).size < infos.length) {
    const r = await git(cwd, ["rev-list", "--topo-order", ...infos.map((i) => i.sha), "--"]);
    if (r.code === 0) {
      r.stdout.split(/\r?\n/).forEach((sha, idx) => {
        if (SHA_RE.test(sha.trim())) rank.set(sha.trim(), idx);
      });
    }
  }
  infos.sort((a, b) => b.time - a.time || (rank.get(a.sha) ?? 0) - (rank.get(b.sha) ?? 0));
}

const HINT_RANK: Record<OriginCandidate["hint"], number> = { unknown: 0, dependency_bump: 1, cosmetic: 2 };

function capText(s: string): string {
  return s.length > EVIDENCE_TEXT_CAP ? `${s.slice(0, EVIDENCE_TEXT_CAP)}\n[truncated]` : s;
}

/**
 * Commits at the origin of a line range: blame (-w -M -C, .git-blame-ignore-revs honoured) then
 * `git log -L` history of the range. Cosmetic or dependency commits remain candidates
 * but come after those with an `unknown` hint; the final judgement stays with the agent.
 */
export async function traceOrigin(
  inv: Investigation,
  snapshot: Snapshot,
  file: string,
  startLine: number,
  endLine: number,
): Promise<OriginResult> {
  checkLines(startLine, endLine);
  checkFile(file);
  const cwd = snapshot.path;
  const rev = await resolveCommit(cwd, snapshot.ref);
  const shallow = await markShallow(inv, cwd);

  const ignore = readIgnoredRevs(cwd);
  const fromBlame = await blameShas(inv, cwd, rev, file, startLine, endLine, ignore);
  const log = await logShas(cwd, rev, file, startLine, endLine);
  if (log.capped) addNote(inv, LOG_CAPPED_NOTE);
  if (log.failed) addNote(inv, LOG_FAILED_NOTE);

  const wanted: string[] = [...fromBlame];
  let ignored = 0;
  for (const s of log.shas) {
    if (wanted.includes(s)) continue;
    if (ignore && ignore.shas.has(s)) ignored++;
    else wanted.push(s);
  }
  if (ignored > 0) {
    setNote(inv, IGNORED_NOTE_PREFIX, `${IGNORED_NOTE_PREFIX}: ${ignored} commit(s) from the range history ruled out`);
  }

  const infos: CommitInfo[] = [];
  let unreadable = 0;
  for (const sha of wanted) {
    const info = await commitInfo(cwd, sha);
    if (info) infos.push(info);
    else unreadable++;
  }
  if (unreadable > 0) {
    setNote(inv, UNREADABLE_NOTE_PREFIX, `${UNREADABLE_NOTE_PREFIX}: ${unreadable} unreadable commit(s), absent from the candidates`);
  }
  await sortNewestFirst(cwd, infos);

  const candidates: OriginCandidate[] = [];
  for (const i of infos) {
    candidates.push({
      sha: i.sha,
      author: i.author,
      date: i.date,
      subject: i.subject,
      hint: await hintFor(cwd, i.sha, i.parents),
    });
  }
  candidates.sort((a, b) => HINT_RANK[a.hint] - HINT_RANK[b.hint]);

  const ev = addEvidence(inv, {
    kind: "code_reading",
    summary: `Origin of ${file}:${startLine}-${endLine}: ${candidates.length} candidate commit(s)`,
    source: `git blame -w -M -C + git log -L ${file}:${startLine}-${endLine} @ ${rev}`,
    data: { file, startLine, endLine, rev, shallow, candidates },
    untrusted: true,
  });
  return { candidates, shallow, evidenceIds: [ev.id] };
}

/** File content just before and just after a commit (empty string if the file does not exist on that side). */
export async function classifyChange(
  inv: Investigation,
  snapshot: Snapshot,
  sha: string,
  file: string,
): Promise<ChangeSides> {
  checkFile(file);
  const cwd = snapshot.path;
  const full = await resolveCommit(cwd, sha);
  const hasParent = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${full}^1^{commit}`])).code === 0;
  const after = (await blob(cwd, `${full}:${file}`)) ?? "";
  const before = hasParent ? ((await blob(cwd, `${full}^1:${file}`)) ?? "") : "";
  const ev = addEvidence(inv, {
    kind: "code_reading",
    summary: `${file} before and after ${full.slice(0, 12)}`,
    source: `git cat-file blob ${full.slice(0, 12)}^1:${file} / ${full.slice(0, 12)}:${file}`,
    data: { sha: full, file, before: capText(before), after: capText(after) },
    untrusted: true,
  });
  return { before, after, evidenceIds: [ev.id] };
}

/**
 * Records the agent's judgement on a commit. A "cosmetic" classification designates the commit;
 * "behavior" has no subject: reading does not prove the bug.
 */
export function recordClassification(
  inv: Investigation,
  sha: string,
  kind: "behavior" | "cosmetic",
  reason: string,
): Evidence {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error(`Invalid sha (40 lowercase hexadecimal characters expected): ${JSON.stringify(sha)}`);
  }
  if (kind !== "behavior" && kind !== "cosmetic") {
    throw new Error(`Unknown classification: ${JSON.stringify(kind)}`);
  }
  return addEvidence(inv, {
    kind: "code_reading",
    summary: `Commit ${sha.slice(0, 12)} classified ${kind}: ${reason}`,
    source: "classification",
    data: { sha, kind, reason },
    untrusted: true,
    ...(kind === "cosmetic" ? { subject: { sha, outcome: "cosmetic" as const } } : {}),
  });
}
