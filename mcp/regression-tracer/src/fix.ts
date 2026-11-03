import { basename } from "node:path";
import { git } from "./git.js";
import type { MrInfo } from "./gitlab.js";
import { redact } from "./http.js";
import { addEvidence, type Evidence, type Investigation, type RepoRef } from "./investigation.js";
import { sessionSecrets } from "./jira-session.js";
import { extractTickets, gitlabClient, linkChange, requireRepo, type LinkDeps, type LinkResult } from "./links.js";
import { addNote, blob, checkFile, markShallow } from "./origin.js";
import { HISTORY_TRUNCATED_NOTE } from "./verdict.js";

export interface CandidateFix {
  sha: string;
  subject: string;
  via: "history" | "patch_id" | "ticket";
}

export interface TargetFinding {
  target: string;
  kind: "tag" | "branch" | "open_mr";
  containsCulprit?: boolean;
  /**
   * `false`: snippet literally absent from the file and not found elsewhere on the target. Absent: file
   * not located, content not comparable, snippet possibly reformatted, or code not read (open MR).
   */
  faultyCodePresent?: boolean;
  /** Log text present in the target's code. A marker: its presence does not prove the bug. Absent: no `logText`, or code not read. */
  logTextPresent?: boolean;
  candidateFixes: CandidateFix[];
  /** Untrusted data: an MR claims it, which proves nothing. */
  claimedBy: MrInfo[];
}

export interface FixResult {
  targets: TargetFinding[];
  coverage: string[];
  evidenceIds: string[];
}

export interface FixInput {
  culprit?: string;
  file: string;
  faultySnippet: string;
  targets?: string[];
  logText?: string;
}

/** What a `check_fix` reading established about a target, re-read from its evidence. */
export interface FixReading {
  repoId: string;
  target: string;
  file: string;
  snippet: string;
  faultyCodePresent?: boolean;
  containsCulprit?: boolean;
  /** Culprit given to `check_fix`: `containsCulprit` only holds for it. */
  culprit?: string;
}

interface Missing {
  name: string;
  reason: string;
}

interface TargetSpec {
  name: string;
  kind: "tag" | "branch";
}

/** A comparison of the snippet with a file: `reason` says why `present` stays absent. */
interface Reading {
  present?: boolean;
  reason?: string;
}

/** A target that was read, with what was used to read it. */
interface ReadTarget {
  finding: TargetFinding;
  sha: string;
  range: string;
  paths: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const NAMED_REF_RE = /^refs\/(heads|tags|remotes)\//;
/** Start of the source of a target reading: tells these pieces of evidence apart from any other code reading. */
const READING_SOURCE = "git cat-file blob ";
const FETCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4_000;
const MAX_TARGETS = 30;
const MAX_HISTORY = 50;
const MAX_MOVED_FILES = 20;
const MAX_LINK_LOOKUPS = 10;
const MAX_LOG_TERMS = 5;
const MIN_LOG_TERM = 8;
const SYMLINK_MODE = "120000 ";
const LFS_POINTER = "version https://git-lfs.github.com/spec/";
const OPEN_MRS = "open MRs";
const NOT_ASKED = "outside the requested list";
const FILE_NOT_FOUND = "file not found";
const CODE_NOT_READ = "code not read, MR metadata only";
const OPAQUE_FILE = "symbolic link or LFS pointer: content not compared";
const UNDECODED_FILE = "file cannot be decoded: absence of the snippet not proven";
const REFORMATTED = "snippet found apart from whitespace, possibly reformatted: to be re-read";
const SEARCH_CAPPED = `snippet not found, but search limited to ${MAX_MOVED_FILES} files`;
const FALSE_NOTE = "faultyCodePresent false: snippet literally absent from the files read; code rewritten differently is not ruled out";
const LOG_TEXT_NOTE = "logTextPresent: log text searched as is in the target's code; its presence does not prove the bug";
/** What an MR that announces a fix says, in French or in English. */
const CLAIM_RE =
  /(?<![\p{L}\p{N}])(?:bug\s?fix|hot\s?fix|fix(?:e[sd]|ing)?|resolv\p{L}*|close[sd]?)(?![\p{L}\p{N}])/iu;
/** `1.2`, `v1.2.3`, `2.0-rc1`, or `app-1.2`, `android/v1.2`: a prefix requires a dotted number. */
const VERSION_TAG_RE = /^(?:[vV]?\d+(?:\.\d+)*|[A-Za-z][\w-]*[-_/][vV]?\d+(?:\.\d+)+)(?:[-_+.][0-9A-Za-z.+-]+)?$/;
/** Pre-release suffixes: `v2.0-rc1` comes after `v2.0`. */
const VERSION_SUFFIXES = ["-rc", "-beta", "-alpha"];

function fetchedEntry(repoId: string): string {
  return `remote references of ${repoId} up to date (git fetch)`;
}

function staleNote(repoId: string): string {
  return `remote references of ${repoId} not refreshed (git fetch not run or failed): targets read as they are`;
}

/** Strips URL credentials and known secrets from git output. */
export function scrubGitOutput(text: string, secrets: readonly string[]): string {
  return redact(text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@"), secrets);
}

/** True if an MR's text announces a fix. A lead: the code may say otherwise. */
export function claimsFix(text: string): boolean {
  return CLAIM_RE.test(text);
}

/** Values to mask, longest first: one may contain another. Without spaces: the GitLab clients strip them too. */
export function knownSecrets(): string[] {
  return [process.env.GITLAB_TOKEN, process.env.JIRA_API_TOKEN, process.env.JIRA_EMAIL, ...sessionSecrets()]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .sort((a, b) => b.length - a.length);
}

/** Re-reads a `check_fix` evidence. `null` for any other evidence, including an open MR whose code is not read. */
export function readFixReading(evidence: Evidence): FixReading | null {
  if (evidence.kind !== "code_reading" || !evidence.source.startsWith(READING_SOURCE)) return null;
  const data = evidence.data as Partial<Record<keyof FixReading, unknown>> | null;
  if (typeof data !== "object" || data === null) return null;
  const { repoId, target, file, snippet, faultyCodePresent, containsCulprit, culprit } = data;
  if (typeof repoId !== "string" || typeof target !== "string" || typeof file !== "string" || typeof snippet !== "string") {
    return null;
  }
  const flag = (value: unknown) => value === undefined || typeof value === "boolean";
  if (!flag(faultyCodePresent) || !flag(containsCulprit) || !(culprit === undefined || typeof culprit === "string")) return null;
  return {
    repoId,
    target,
    file,
    snippet,
    ...(faultyCodePresent === undefined ? {} : { faultyCodePresent: faultyCodePresent as boolean }),
    ...(containsCulprit === undefined ? {} : { containsCulprit: containsCulprit as boolean }),
    ...(culprit === undefined ? {} : { culprit: culprit as string }),
  };
}

/** Targets whose code was read for this repository: the `target:` lines only hold for the last question asked. */
export function examinedTargets(inv: Investigation, repoId: string): string[] {
  const [askedRepo] = JSON.parse(inv.fixQuery ?? "[]") as unknown[];
  if (askedRepo !== repoId) return [];
  return inv.coverage.examined.filter((l) => l.startsWith("target:")).map((l) => l.slice("target:".length));
}

function recordFetch(inv: Investigation, repoId: string, ok: boolean): void {
  const entry = fetchedEntry(repoId);
  inv.coverage.examined = inv.coverage.examined.filter((e) => e !== entry);
  if (ok) {
    inv.coverage.examined.push(entry);
    inv.coverage.notExamined = inv.coverage.notExamined.filter((n) => n !== staleNote(repoId));
  } else {
    addNote(inv, staleNote(repoId));
  }
}

/**
 * `git fetch --all --tags`: the only write allowed in the user's repository, limited to references.
 * No pruning (even with `fetch.prune`), no merge, no working copy, no submodules. Does not throw for an
 * unreachable remote. The output is untrusted (the remote server writes to it); credentials are stripped from it.
 */
export async function fetchRefs(inv: Investigation, repoId: string): Promise<{ ok: boolean; output: string }> {
  const repo = requireRepo(inv, repoId);
  const remotes = await git(repo.path, ["remote"]);
  if (remotes.code === 0 && remotes.stdout.trim() === "") {
    recordFetch(inv, repoId, false);
    return { ok: false, output: "no remote: nothing was refreshed" };
  }
  const r = await git(
    repo.path,
    ["-c", "protocol.ext.allow=never", "fetch", "--all", "--tags", "--no-prune", "--no-recurse-submodules", "--no-auto-maintenance"],
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  const ok = r.code === 0;
  recordFetch(inv, repoId, ok);
  const output = scrubGitOutput(`${r.stdout}${r.stderr}`, knownSecrets()).trim();
  return { ok, output: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[truncated]` : output };
}

function normalizeEol(text: string): string {
  return text.split("\r\n").join("\n");
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Resolves a reference to a sha, or says why it is ruled out. The name reaches git only as data. */
export async function resolveTarget(cwd: string, name: string): Promise<{ sha: string } | { reason: string }> {
  if (typeof name !== "string" || name === "" || name.startsWith("-") || /[\x00-\x20\x7f]/.test(name)) {
    return { reason: "name refused" };
  }
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(sha) ? { sha } : { reason: "reference not found" };
}

/** The full reference of a name, whatever it is. Never a sha or an expression (`main~1`). */
export async function resolveFullRef(cwd: string, name: string): Promise<{ sha: string; ref: string } | { reason: string }> {
  if (/[~^:]|@\{/.test(name)) return { reason: "expression refused" };
  const resolved = await resolveTarget(cwd, name);
  if (!("sha" in resolved)) return resolved;
  const r = await git(cwd, ["rev-parse", "--symbolic-full-name", name]);
  const ref = r.stdout.trim();
  return r.code === 0 && ref.startsWith("refs/") ? { sha: resolved.sha, ref } : { reason: "neither branch nor tag" };
}

/**
 * A verdict target: a branch or a tag, named for itself. `HEAD`, `@`, `head` on Windows and
 * `main-worktree/HEAD` resolve to `refs/heads/main`: only a name that spells out the reference passes.
 * `checkFix` keeps `resolveTarget`, which is broader: reading asserts nothing.
 */
export async function resolveNamedTarget(cwd: string, name: string): Promise<{ sha: string; ref: string } | { reason: string }> {
  const resolved = await resolveFullRef(cwd, name);
  if (!("sha" in resolved)) return resolved;
  const { ref } = resolved;
  const spelled = ref === name || ref.endsWith(`/${name}`);
  return spelled && NAMED_REF_RE.test(ref) ? resolved : { reason: "neither branch nor tag" };
}

/** The latest version tag: "the latest version", for `check_fix` as for `locate_version`. */
export async function latestTag(cwd: string): Promise<{ tag?: string; ignored: number; total: number }> {
  const suffixes = VERSION_SUFFIXES.flatMap((s) => ["-c", `versionsort.suffix=${s}`]);
  const r = await git(cwd, [...suffixes, "tag", "--sort=-v:refname"]);
  const tags = r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const versions = tags.filter((t) => VERSION_TAG_RE.test(t));
  return { tag: versions[0], ignored: tags.length - versions.length, total: tags.length };
}

async function defaultBranch(cwd: string): Promise<string | undefined> {
  const head = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const names = [head.code === 0 ? head.stdout.trim() : "", "origin/main", "origin/master", "main", "master"];
  for (const name of names.filter(Boolean)) {
    if ("sha" in (await resolveTarget(cwd, name))) return name;
  }
  return undefined;
}

async function releaseBranches(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim().replace(/^refs\/remotes\//, ""))
    .filter((n) => n.startsWith("origin/release"));
}

/** Default targets found, those that do not exist in this repository, and what was ruled out of the choice. */
async function defaultTargets(cwd: string): Promise<{ found: TargetSpec[]; missing: Missing[]; notes: string[] }> {
  const found: TargetSpec[] = [];
  const missing: Missing[] = [];
  const notes: string[] = [];
  const latest = await latestTag(cwd);
  if (latest.tag) found.push({ name: latest.tag, kind: "tag" });
  else missing.push({ name: "latest tag", reason: latest.total === 0 ? "no tag" : "no version tag" });
  if (latest.ignored > 0) notes.push(`non-version tags ruled out of the latest tag choice: ${latest.ignored}`);
  const branch = await defaultBranch(cwd);
  if (branch) found.push({ name: branch, kind: "branch" });
  else missing.push({ name: "default branch", reason: "not found" });
  const releases = await releaseBranches(cwd);
  if (releases.length === 0) missing.push({ name: "origin/release*", reason: "no branch" });
  for (const name of releases) found.push({ name, kind: "branch" });
  return { found, missing, notes };
}

async function targetKind(cwd: string, name: string): Promise<"tag" | "branch"> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/tags/${name}`]);
  return r.code === 0 ? "tag" : "branch";
}

/** True or false according to ancestry; absent if git cannot answer. */
export async function isAncestor(cwd: string, sha: string, target: string): Promise<boolean | undefined> {
  const r = await git(cwd, ["merge-base", "--is-ancestor", sha, target]);
  if (r.code === 0) return true;
  return r.code === 1 ? false : undefined;
}

async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(cwd, ["merge-base", a, b]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(sha) ? sha : undefined;
}

/** Successive paths of `file` following the renames of `range`, oldest to newest. */
async function renameChain(cwd: string, range: string, file: string): Promise<string[]> {
  const r = await git(cwd, [
    "log", "-M", "--diff-filter=R", "--name-status", "-z", "--format=", "--no-ext-diff", "--no-textconv",
    "--reverse", "--topo-order", range, "--",
  ]);
  if (r.code !== 0) return [];
  const tokens = r.stdout.split("\0").map((t) => t.replace(/^\n+/, ""));
  const chain: string[] = [];
  let current = file;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (!/^R\d*$/.test(tokens[i]!)) continue;
    const [from, to] = [tokens[i + 1]!, tokens[i + 2]!];
    i += 2;
    if (from === current) {
      chain.push(to);
      current = to;
    }
  }
  return chain;
}

/** Files touched by the commits of `range` that change the number of occurrences of the snippet. */
async function filesChangingSnippet(cwd: string, range: string, snippet: string): Promise<string[]> {
  const r = await git(cwd, [
    "log", `-S${snippet}`, "--name-only", "-z", "--format=", "--no-renames", "--no-ext-diff", "--no-textconv", range, "--",
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\0").map((t) => t.replace(/^\n+/, "")).filter(Boolean);
}

/** Files of the target containing the longest line of the snippet: `git grep` only compares line by line. */
async function filesHoldingLine(cwd: string, sha: string, snippet: string): Promise<string[]> {
  const lines = snippet.split("\n").map((l) => l.trim());
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const r = await git(cwd, ["grep", "-F", "-l", "-z", "-e", longest, sha, "--"]);
  if (r.code !== 0) return [];
  const prefix = `${sha}:`;
  return r.stdout.split("\0").filter(Boolean).map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p));
}

/** Looks for the snippet outside the paths already read: as is first, otherwise apart from whitespace (`reformatted`). */
async function findElsewhere(
  cwd: string,
  sha: string,
  range: string,
  snippet: string,
  known: string[],
): Promise<{ path?: string; reformatted?: string; capped: boolean }> {
  const found = [...(await filesChangingSnippet(cwd, range, snippet)), ...(await filesHoldingLine(cwd, sha, snippet))];
  const others = [...new Set(found)].filter((p) => !known.includes(p));
  const collapsed = collapseSpaces(snippet);
  let reformatted: string | undefined;
  for (const candidate of others.slice(0, MAX_MOVED_FILES)) {
    const text = await blob(cwd, `${sha}:${candidate}`);
    if (text === null) continue;
    if (normalizeEol(text).includes(snippet)) return { path: candidate, capped: false };
    if (reformatted === undefined && collapseSpaces(text).includes(collapsed)) reformatted = candidate;
  }
  return { ...(reformatted === undefined ? {} : { reformatted }), capped: others.length > MAX_MOVED_FILES };
}

/** Compares the snippet with the target's file. `null`: the file does not exist there. */
async function compare(cwd: string, sha: string, path: string, snippet: string): Promise<Reading | null> {
  const text = await blob(cwd, `${sha}:${path}`);
  if (text === null) return null;
  if (normalizeEol(text).includes(snippet)) return { present: true };
  const entry = await git(cwd, ["ls-tree", sha, "--", path]);
  if (entry.stdout.startsWith(SYMLINK_MODE) || text.startsWith(LFS_POINTER)) return { reason: OPAQUE_FILE };
  if (text.includes("�")) return { reason: UNDECODED_FILE };
  if (collapseSpaces(text).includes(collapseSpaces(snippet))) return { reason: REFORMATTED };
  return { present: false };
}

/**
 * Reads the snippet on the target: given path, then renames if the file has disappeared, then the rest of the
 * target. A reused old name does not count as a fix: as long as the snippet exists elsewhere, it is present.
 * A missing or non-comparable file leaves `present` absent, never `false`.
 */
async function readSnippet(
  cwd: string,
  sha: string,
  range: string,
  file: string,
  snippet: string,
): Promise<Reading & { paths: string[] }> {
  let reading = await compare(cwd, sha, file, snippet);
  let paths = [file];
  if (!reading) {
    const chain = await renameChain(cwd, range, file);
    const last = chain[chain.length - 1];
    const moved = last === undefined ? null : await compare(cwd, sha, last, snippet);
    if (moved) {
      reading = moved;
      paths = [file, ...chain];
    }
  }
  if (reading?.present === true) return { ...reading, paths };

  const other = await findElsewhere(cwd, sha, range, snippet, paths);
  if (other.path !== undefined) return { present: true, paths: [...paths, other.path] };
  if (other.reformatted !== undefined) return { reason: REFORMATTED, paths: [...paths, other.reformatted] };
  if (!reading) return { reason: FILE_NOT_FOUND, paths };
  if (reading.present === false && other.capped) return { reason: SEARCH_CAPPED, paths };
  return { ...reading, paths };
}

async function logTextAt(cwd: string, sha: string, lines: string[]): Promise<boolean | undefined> {
  if (lines.length === 0) return undefined;
  const r = await git(cwd, ["grep", "-F", "-q", ...lines.flatMap((l) => ["-e", l]), sha, "--"]);
  if (r.code === 0) return true;
  return r.code === 1 ? false : undefined;
}

async function fileHistory(
  cwd: string,
  range: string,
  paths: string[],
): Promise<{ commits: CandidateFix[]; capped: boolean } | null> {
  const r = await git(cwd, [
    "log", "--format=%H%x00%s", `--max-count=${MAX_HISTORY + 1}`, "--no-ext-diff", "--no-textconv", range, "--", ...paths,
  ]);
  if (r.code !== 0) return null;
  const commits: CandidateFix[] = [];
  for (const line of r.stdout.split("\n")) {
    const [sha, subject = ""] = line.split("\0");
    if (sha && SHA_RE.test(sha)) commits.push({ sha, subject, via: "history" });
  }
  return { commits: commits.slice(0, MAX_HISTORY), capped: commits.length > MAX_HISTORY };
}

/** Commits of `range` that cite a ticket of the culprit. `git log -F` also matches PROJ-123 for PROJ-12: re-read afterwards. */
async function ticketCommits(
  cwd: string,
  range: string,
  tickets: string[],
): Promise<{ commits: CandidateFix[]; capped: boolean } | null> {
  const r = await git(cwd, [
    "log", "-z", "--format=%H%n%s%n%B", "-F", ...tickets.map((t) => `--grep=${t}`), `--max-count=${MAX_HISTORY + 1}`,
    "--no-ext-diff", "--no-textconv", range, "--",
  ]);
  if (r.code !== 0) return null;
  const commits: CandidateFix[] = [];
  for (const record of r.stdout.split("\0")) {
    const [sha = "", subject = "", ...body] = record.replace(/^\n+/, "").split("\n");
    if (!SHA_RE.test(sha)) continue;
    const cited = extractTickets(body.join("\n"), "commit_mention").map((t) => t.key);
    if (cited.some((key) => tickets.includes(key))) commits.push({ sha, subject, via: "ticket" });
  }
  return { commits: commits.slice(0, MAX_HISTORY), capped: commits.length > MAX_HISTORY };
}

/** Adds to the candidates the commits citing a ticket of the culprit: a fix may touch another file. */
async function addTicketCommits(cwd: string, read: ReadTarget[], tickets: string[], culprit: string | undefined, notes: Set<string>): Promise<void> {
  if (tickets.length === 0) return;
  for (const t of read) {
    const name = t.finding.target;
    const found = await ticketCommits(cwd, t.range, tickets);
    if (!found) notes.add(`scope:${name}: search by culprit ticket unreadable`);
    if (found?.capped) notes.add(`scope:${name}: search by ticket limited to ${MAX_HISTORY} commits`);
    for (const c of found?.commits ?? []) {
      if (c.sha !== culprit && !t.finding.candidateFixes.some((d) => d.sha === c.sha)) t.finding.candidateFixes.push(c);
    }
  }
}

/** Stable patch-id of each commit (a commit without a simple diff, like a merge, has none). */
async function patchIds(cwd: string, shas: string[]): Promise<Map<string, string> | null> {
  const ids = new Map<string, string>();
  if (shas.length === 0) return ids;
  const show = await git(cwd, ["show", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", "--pretty=medium", ...shas, "--"]);
  if (show.code !== 0) return null;
  const r = await git(cwd, ["patch-id", "--stable"], { input: show.stdout });
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const [id, sha] = line.trim().split(/\s+/);
    if (id && sha) ids.set(sha, id);
  }
  return ids;
}

/** Marks as `patch_id` a commit whose patch is that of another candidate commit on another target. */
async function markPatchMatches(cwd: string, read: ReadTarget[]): Promise<boolean> {
  if (read.length < 2) return true;
  const shas = [...new Set(read.flatMap((t) => t.finding.candidateFixes.map((c) => c.sha)))];
  const ids = await patchIds(cwd, shas);
  if (!ids) return false;
  for (const t of read) {
    for (const c of t.finding.candidateFixes) {
      const id = ids.get(c.sha);
      if (id === undefined) continue;
      const elsewhere = read.some(
        (o) => o !== t && o.finding.candidateFixes.some((d) => d.sha !== c.sha && ids.get(d.sha) === id),
      );
      if (elsewhere) c.via = "patch_id";
    }
  }
  return true;
}

/** MRs linked to the candidate commits; the text stays untrusted and only the match comes out of it. */
async function linkCandidates(
  inv: Investigation,
  repo: RepoRef,
  read: ReadTarget[],
  deps: LinkDeps,
  notes: Set<string>,
  evidenceIds: string[],
): Promise<void> {
  if (repo.forge !== "gitlab") return;
  const shas = [...new Set(read.flatMap((t) => t.finding.candidateFixes.map((c) => c.sha)))];
  if (shas.length > MAX_LINK_LOOKUPS) notes.add(`MRs of the candidate commits: only ${MAX_LINK_LOOKUPS} commits out of ${shas.length} are linked`);
  const links = new Map<string, LinkResult>();
  for (const sha of shas.slice(0, MAX_LINK_LOOKUPS)) {
    const link = await linkChange(inv, repo.repoId, sha, deps);
    links.set(sha, link);
    evidenceIds.push(...link.evidenceIds);
    for (const miss of link.misses) notes.add(miss);
  }
  for (const t of read) {
    const seen = new Set<number>();
    for (const c of t.finding.candidateFixes) {
      const mr = links.get(c.sha)?.mr;
      if (!mr || seen.has(mr.iid) || !claimsFix(`${mr.title}\n${mr.description}`)) continue;
      seen.add(mr.iid);
      t.finding.claimedBy.push(mr);
    }
  }
}

/** Texts that link an open MR to this investigation. Compared case-insensitively with the title, description and branch. */
function claimTerms(paths: string[], culprit: string | undefined, tickets: string[], logLines: string[]): string[] {
  const terms = [...new Set(paths.map((p) => basename(p)))];
  terms.push(...logLines.filter((l) => l.length >= MIN_LOG_TERM).slice(0, MAX_LOG_TERMS));
  if (culprit) terms.push(culprit.slice(0, 7));
  terms.push(...tickets);
  return terms.map((t) => t.toLowerCase());
}

/**
 * Reads the open MRs through the API, metadata only: never a fetch of `refs/merge-requests/*`, never a
 * checkout. An MR that cites a file found, the culprit, a ticket or the log text becomes a line
 * whose code stays unread. Any incomplete read puts the "open MRs" target in not examined.
 */
async function openMrFindings(
  repo: RepoRef,
  terms: string[],
  deps: LinkDeps,
  notes: Set<string>,
): Promise<{ rows: TargetFinding[]; missing?: Missing }> {
  const name = OPEN_MRS;
  if (repo.forge !== "gitlab") return { rows: [], missing: { name, reason: `platform ${repo.forge}: MRs not searched` } };
  const misses: string[] = [];
  const gl = await gitlabClient(repo.path, deps.env ?? process.env, deps.fetchFn ?? fetch, deps, misses);
  if (!gl) return { rows: [], missing: { name, reason: misses.join("; ") || "GitLab unavailable" } };

  const mrs = await gl.client.openMrs(gl.project);
  const rows = mrs
    .filter((mr) => {
      const text = `${mr.title}\n${mr.description}\n${mr.sourceBranch}`.toLowerCase();
      return terms.some((t) => text.includes(t));
    })
    .map<TargetFinding>((mr) => ({ target: `!${mr.iid}`, kind: "open_mr", candidateFixes: [], claimedBy: [mr] }));
  notes.add(`scope:${OPEN_MRS}: ${mrs.length} read, ${rows.length} linked to the investigation by their text; no MR's code is read`);
  const partial = [...new Set(gl.client.misses)].join("; ");
  return partial ? { rows, missing: { name, reason: partial } } : { rows };
}

function displayName(name: unknown): string {
  return String(name).replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 200);
}

/**
 * Records the coverage of this pass. The `target:` and `scope:` lines hold for one question (repository,
 * file, snippet): another question erases them all, a re-run replaces those of the same targets.
 */
function recordCoverage(inv: Investigation, query: string, examined: string[], missing: Missing[], notes: string[]): string[] {
  const entry = (name: string) => `target:${name}`;
  if (inv.fixQuery !== query) {
    const other = (l: string) => !l.startsWith("target:") && !l.startsWith("scope:");
    inv.coverage.examined = inv.coverage.examined.filter(other);
    inv.coverage.notExamined = inv.coverage.notExamined.filter(other);
    inv.fixQuery = query;
  }
  const stale = new Set([...examined, ...missing.filter((m) => m.reason !== NOT_ASKED).map((m) => m.name)]);
  const isStale = (line: string) =>
    [...stale].some((n) => line === entry(n) || line.startsWith(`${entry(n)}: `) || line.startsWith(`scope:${n}: `));
  inv.coverage.examined = inv.coverage.examined.filter((l) => !isStale(l));
  inv.coverage.notExamined = inv.coverage.notExamined.filter((l) => !isStale(l));

  const lines: string[] = [];
  for (const name of examined) {
    inv.coverage.examined.push(entry(name));
    lines.push(entry(name));
  }
  for (const m of missing) {
    const line = `${entry(m.name)}: ${m.reason}`;
    lines.push(line);
    // "Not asked" does not replace what a previous pass established about this target.
    const known = inv.coverage.examined.includes(entry(m.name)) || inv.coverage.notExamined.some((l) => l.startsWith(`${entry(m.name)}: `));
    if (m.reason === NOT_ASKED && known) continue;
    addNote(inv, line);
  }
  for (const note of notes) {
    addNote(inv, note);
    lines.push(note);
  }
  return lines;
}

async function chooseTargets(
  cwd: string,
  asked: string[] | undefined,
): Promise<{ specs: TargetSpec[]; missing: Missing[]; notes: string[]; defaultsOnly: boolean }> {
  const defaults = await defaultTargets(cwd);
  const missing = [...defaults.missing];
  if (!asked || asked.length === 0) return { specs: defaults.found, missing, notes: defaults.notes, defaultsOnly: true };

  const specs: TargetSpec[] = [];
  for (const name of new Set(asked)) specs.push({ name, kind: await targetKind(cwd, name) });
  for (const d of defaults.found) {
    if (!specs.some((s) => s.name === d.name)) missing.push({ name: d.name, reason: NOT_ASKED });
  }
  return { specs, missing, notes: defaults.notes, defaultsOnly: false };
}

/**
 * Searches for the fix target by target. The server returns reading facts: the status is chosen in the
 * verdict. A target is "examined" only if its code was read; everything else appears in `coverage` with
 * its reason, because an absence only holds for what was looked at.
 */
export async function checkFix(inv: Investigation, repoId: string, input: FixInput, deps: LinkDeps = {}): Promise<FixResult> {
  const repo = requireRepo(inv, repoId);
  const cwd = repo.path;
  checkFile(input.file);
  const snippet = normalizeEol(String(input.faultySnippet ?? ""));
  if (snippet.trim() === "" || snippet.includes("\0")) {
    throw new Error("Faulty snippet empty or invalid: the code to search for on each target is required");
  }

  let culprit: string | undefined;
  if (input.culprit !== undefined) {
    const r = await resolveTarget(cwd, input.culprit);
    if (!("sha" in r)) throw new Error(`Culprit not found: ${JSON.stringify(input.culprit)}`);
    culprit = r.sha;
  }
  const logLines = (input.logText ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.includes("\0"));

  const notes = new Set<string>();
  if (await markShallow(inv, cwd)) notes.add(HISTORY_TRUNCATED_NOTE);
  if (!inv.coverage.examined.includes(fetchedEntry(repoId))) notes.add(staleNote(repoId));

  const evidenceIds: string[] = [];
  let tickets: string[] = [];
  if (culprit) {
    const link = await linkChange(inv, repoId, culprit, deps);
    tickets = link.tickets.map((t) => t.key);
    evidenceIds.push(...link.evidenceIds);
    for (const miss of link.misses) notes.add(miss);
  }

  const { specs, missing, notes: targetNotes, defaultsOnly } = await chooseTargets(cwd, input.targets);
  for (const note of targetNotes) notes.add(note);
  const examined: string[] = [];
  const read: ReadTarget[] = [];

  for (const spec of specs.slice(MAX_TARGETS)) missing.push({ name: displayName(spec.name), reason: `cap of ${MAX_TARGETS} targets reached` });
  for (const spec of specs.slice(0, MAX_TARGETS)) {
    const resolved = await resolveTarget(cwd, spec.name);
    if (!("sha" in resolved)) {
      missing.push({ name: displayName(spec.name), reason: resolved.reason });
      continue;
    }
    const { sha } = resolved;
    const containsCulprit = culprit ? await isAncestor(cwd, culprit, sha) : undefined;
    const base = !culprit ? undefined : containsCulprit ? culprit : await mergeBase(cwd, culprit, sha);
    const range = base ? `${base}..${sha}` : sha;

    const found = await readSnippet(cwd, sha, range, input.file, snippet);
    const history = await fileHistory(cwd, range, found.paths);
    const logTextPresent = await logTextAt(cwd, sha, logLines);
    const shown = found.paths.map(displayName).join(", ");
    notes.add(`scope:${spec.name}: history limited to ${shown}; fixes in other files not searched`);
    if (history?.capped) notes.add(`scope:${spec.name}: search limited to the ${MAX_HISTORY} most recent commits of the file`);

    const finding: TargetFinding = {
      target: spec.name,
      kind: spec.kind,
      ...(containsCulprit === undefined ? {} : { containsCulprit }),
      ...(found.present === undefined ? {} : { faultyCodePresent: found.present }),
      ...(logTextPresent === undefined ? {} : { logTextPresent }),
      candidateFixes: history?.commits ?? [],
      claimedBy: [],
    };
    read.push({ finding, sha, range, paths: found.paths });

    if (found.present === undefined) missing.push({ name: spec.name, reason: found.reason ?? FILE_NOT_FOUND });
    else if (!history) missing.push({ name: spec.name, reason: "file history unreadable" });
    else examined.push(spec.name);
  }
  if (read.some((t) => t.finding.faultyCodePresent === false)) notes.add(FALSE_NOTE);
  if (logLines.length > 0) notes.add(LOG_TEXT_NOTE);

  if (!(await markPatchMatches(cwd, read))) notes.add("patch-id unavailable: cherry-picks not compared between targets");
  await addTicketCommits(cwd, read, tickets, culprit, notes);
  await linkCandidates(inv, repo, read, deps, notes, evidenceIds);

  for (const t of read) {
    const f = t.finding;
    const path = t.paths[t.paths.length - 1]!;
    const state = f.faultyCodePresent === undefined ? "not established" : f.faultyCodePresent ? "present" : "literally absent";
    const ev = addEvidence(inv, {
      kind: "code_reading",
      summary: `Target ${f.target}: faulty code ${state} on reading, ${f.candidateFixes.length} candidate commit(s), ${f.claimedBy.length} announcement(s)`,
      source: `${READING_SOURCE}${t.sha.slice(0, 12)}:${path} + git log`,
      data: { ...f, repoId, ...(culprit ? { culprit } : {}), sha: t.sha, file: input.file, path, snippet },
      untrusted: true,
    });
    evidenceIds.push(ev.id);
  }

  const findings = read.map((t) => t.finding);
  if (defaultsOnly) {
    const terms = claimTerms([input.file, ...read.flatMap((t) => t.paths)], culprit, tickets, logLines);
    const mrs = await openMrFindings(repo, terms, deps, notes);
    if (mrs.missing) missing.push(mrs.missing);
    else examined.push(OPEN_MRS);
    for (const row of mrs.rows) {
      findings.push(row);
      missing.push({ name: row.target, reason: CODE_NOT_READ });
      const mr = row.claimedBy[0]!;
      const ev = addEvidence(inv, {
        kind: "code_reading",
        summary: `Lead: open MR !${mr.iid} is linked to the investigation by its text (announcement, code not read)`,
        source: "gitlab:merge_requests?state=opened",
        data: { mr },
        untrusted: true,
      });
      evidenceIds.push(ev.id);
    }
  } else {
    missing.push({ name: OPEN_MRS, reason: NOT_ASKED });
  }

  const query = JSON.stringify([repoId, input.file, snippet]);
  return { targets: findings, coverage: recordCoverage(inv, query, examined, missing, [...notes]), evidenceIds };
}
