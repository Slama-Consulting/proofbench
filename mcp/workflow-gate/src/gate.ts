import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CHECKLISTS, type CommandKey, type Step, type Workflow } from "./checklists.js";
import { controlKind, hasLintCount, isTestPath, parseTests, parseWarnings, readJunitXml, type TestCounts, type Warnings } from "./counts.js";
import { baseName, checkCommand, commandKey, DEFAULT_TIMEOUT_MS, runCommand, storedOutput } from "./exec.js";
import { git } from "./git.js";
import { maskArgv, redact } from "./secrets.js";

export { parseWarnings };

export type Finding = Record<string, string>;

export interface Proof {
  step: string;
  command: string[];
  /** `null`: the command produced no result; such a proof never counts. */
  exitCode: number | null;
  sha: string;
  dirty: string;
  timestamp: string;
  output: string;
  failure?: string;
  warnings?: Warnings;
  tests?: TestCounts;
  /** Hash of only the ignored files under `watchIgnored`. */
  watched?: string;
  /** On a "before" proof: every untracked file and its hash. */
  untracked?: Record<string, string>;
  /** Files cited by the commands, read from disk: an ignored file escapes the diff. */
  commandFiles?: string;
  findings?: Finding[];
  /** Pour `revert_fails`. */
  fix?: string;
  testFile?: string;
  /** No manifest: the step is not applicable, neither proved nor missing. */
  notApplicable?: boolean;
}

export interface Gate {
  id: string;
  workflow: Workflow;
  repo: string;
  sha: string;
  commands: Partial<Record<CommandKey, string[]>>;
  lintMarker?: string;
  /** Source roots whose ignored files still go into the hash. */
  watchIgnored?: string[];
  authorizedBy?: string;
  notes: Record<string, string>;
  examined?: Record<string, { file: string; sha256: string }>;
  proofs: Proof[];
  httpCount: number;
  createdAt: string;
  /** Last score returned by `gate_close`. */
  lastScore?: number;
}

export interface StepResult extends Pick<Step, "id" | "label" | "kind" | "required"> {
  status: "proved" | "noted" | "missing" | "na";
  reason?: string;
}

export interface Cap {
  limit: number;
  reason: string;
}

export interface Evaluation {
  steps: StepResult[];
  caps: Cap[];
  warnings: string[];
}

export interface RepoState {
  sha: string;
  dirty: string;
  watched?: string;
  untracked: Record<string, string>;
}

const REDACTED = "[masked]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultGatesDir(): string {
  return join(homedir(), ".proofbench", "gates");
}

/** An id is accepted only if it has the shape of a UUID: no separator, hence no escape from the folder. */
function fileFor(id: string, root: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Invalid gate id: ${JSON.stringify(id)}`);
  return join(root, `${id}.json`);
}

export function saveGate(gate: Gate, root: string = defaultGatesDir()): void {
  const file = fileFor(gate.id, root);
  mkdirSync(root, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(gate, null, 2), "utf8");
  renameSync(tmp, file);
}

export function loadGate(id: string, root: string = defaultGatesDir()): Gate {
  const file = fileFor(id, root);
  let gate: Gate;
  try {
    gate = JSON.parse(readFileSync(file, "utf8")) as Gate;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Gate not found: ${id}`);
    throw e;
  }
  // The id in the file builds paths: it must be the validated one from the file name.
  if (typeof gate.id !== "string" || gate.id.toLowerCase() !== id.toLowerCase()) throw new Error(`Inconsistent gate file: ${id}`);
  return gate;
}

const DAY_MS = 24 * 3_600_000;

/** Other gates for the repo in the last 24 h: redoing a gate until it scores 10 must be visible. */
export function otherGates(gate: Gate, root: string = defaultGatesDir()): { gateId: string; workflow: string; createdAt: string; score: number | null }[] {
  mkdirSync(root, { recursive: true });
  const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".json"));
  const others: { gateId: string; workflow: string; createdAt: string; score: number | null }[] = [];
  for (const { name } of names) {
    try {
      const other = loadGate(name.slice(0, -".json".length), root);
      const recent = Date.now() - Date.parse(other.createdAt) < DAY_MS;
      if (other.id !== gate.id && other.repo === gate.repo && recent) {
        others.push({ gateId: other.id, workflow: other.workflow, createdAt: other.createdAt, score: other.lastScore ?? null });
      }
    } catch {
      // an unreadable file is not a gate
    }
  }
  return others;
}

/** A relative git path, with nothing that leaves the repo or is read as path syntax. */
export function checkRelative(raw: string, name: string): string {
  const path = raw.replaceAll("\\", "/");
  const parts = path.split("/");
  const bad =
    path === "" || path.startsWith("/") || path.startsWith(":") || /^[A-Za-z]:/.test(path) || path.includes("\0") ||
    parts.some((p) => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git");
  if (bad) throw new Error(`${name} refused (must be repo-relative, without ".."): ${JSON.stringify(raw)}`);
  return path;
}

export function stepOf(gate: Gate, id: string): Step {
  const step = CHECKLISTS[gate.workflow].find((s) => s.id === id);
  if (!step) throw new Error(`Unknown step for ${gate.workflow}: ${JSON.stringify(id)}`);
  return step;
}

export async function gitOut(repo: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const r = await git(repo, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Each path as is, then its bytes. The length removes the ambiguity of content that itself carries a NUL. */
export function hashUntracked(paths: readonly string[], read: (path: string) => Buffer): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = read(path);
    hash.update(path).update("\0").update(String(bytes.length)).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

/** A link is worth its target, without following it. */
function readUntracked(repo: string, path: string): Buffer {
  const full = join(repo, path);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) return Buffer.from(readlinkSync(full));
  return st?.isFile() ? readFileSync(full) : Buffer.alloc(0);
}

/** Git lists a nested repo as `sub/`, without its content: we walk it, except for its `.git`. */
function expandNested(repo: string, path: string): string[] {
  if (!path.endsWith("/")) return [path];
  return readdirSync(join(repo, path), { withFileTypes: true })
    .filter((d) => d.name !== ".git")
    .flatMap((d) => expandNested(repo, `${path}${d.name}${d.isDirectory() ? "/" : ""}`));
}

const FILTER_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The config's `clean` filters would run on `status` and `diff`. Emptied, git runs nothing. Passed through
 * the environment, where key and value stay separate: a name containing `=` could not fool `-c`. A name outside
 * the safe alphabet is refused outright.
 */
export async function noFilters(repo: string): Promise<NodeJS.ProcessEnv> {
  const r = await git(repo, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."]);
  const names = new Set(r.stdout.split("\0").filter(Boolean).map((key) => key.split(".").slice(1, -1).join(".")));
  const keys = [...names].flatMap((n) => {
    if (!FILTER_NAME_RE.test(n)) throw new Error(`Git filter with a refused name: ${JSON.stringify(n)}`);
    return [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]].map(([k, v]) => [`filter.${n}.${k}`, v] as const);
  });
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** `status` would run a submodule's filters: we read its commit, under neutral filters, and its files directly. */
async function submoduleState(repo: string, safe: NodeJS.ProcessEnv): Promise<{ state: string; files: string[] }> {
  const links = (await gitOut(repo, ["ls-files", "-s", "-z"])).split("\0").filter((e) => e.startsWith("160000 "));
  const parts: string[] = [];
  const files: string[] = [];
  for (const link of links) {
    const path = link.slice(link.indexOf("\t") + 1);
    const dir = join(repo, path);
    parts.push(link);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) files.push(...expandNested(repo, `${path}/`));
    if (!lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) continue;
    parts.push((await gitOut(dir, ["rev-parse", "HEAD"], { env: { ...safe, ...(await noFilters(dir)) } })).trim());
  }
  return { state: parts.join("\0"), files };
}

/** A flagged entry makes `status` and `diff` lie: no proof can rely on them. */
async function refuseFlaggedIndex(repo: string): Promise<void> {
  const entries = (await gitOut(repo, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  const flagged = entries.filter((e) => /^[a-zS]/.test(e)).map((e) => e.slice(2));
  if (flagged.length > 0) throw new Error(`Index entries flagged assume-unchanged or skip-worktree, refused: ${flagged.slice(0, 5).join(", ")}`);
}

const KEEP_OUT = [".", ":(exclude).proofbench"];

/** Commit and state hash: status, diff, and the content of untracked files, whose changes status cannot see. */
export async function repoState(repo: string, watchIgnored: readonly string[] = []): Promise<RepoState> {
  await refuseFlaggedIndex(repo);
  const sha = (await gitOut(repo, ["rev-parse", "--verify", "HEAD"])).trim();
  const safe = await noFilters(repo);
  const status = await gitOut(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", ...KEEP_OUT], { env: safe });
  const diff = await gitOut(repo, ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", ...KEEP_OUT], { env: safe });
  const submodules = await submoduleState(repo, safe);
  // Only .gitignore excludes: a file hidden by .git/info/exclude does not escape the hash.
  const listed = (await gitOut(repo, ["ls-files", "-o", "--exclude-per-directory=.gitignore", "-z"])).split("\0");
  const watched = watchIgnored.length === 0 ? [] : (await gitOut(repo, ["ls-files", "-o", "-i", "--exclude-standard", "-z", "--", ...watchIgnored.map((p) => `:(literal)${p}`)])).split("\0");
  const others = [...new Set([...listed, ...watched])].filter((p) => p !== "" && !p.startsWith(".proofbench/")).flatMap((p) => expandNested(repo, p));
  others.push(...submodules.files);
  const contents = hashUntracked(others, (p) => readUntracked(repo, p));
  const watchedPaths = watched.filter((p) => p !== "");
  const untracked = Object.fromEntries(others.map((p) => [p, hashUntracked([p], (x) => readUntracked(repo, x))]));
  return { sha, untracked, ...(watchIgnored.length > 0 ? { watched: hashUntracked(watchedPaths, (p) => readUntracked(repo, p)) } : {}), dirty: createHash("sha256").update(status).update("\0").update(diff).update("\0").update(submodules.state).update("\0").update(contents).digest("hex") };
}

export function addProof(gate: Gate, step: Step, state: RepoState, proof: Pick<Proof, "command" | "exitCode" | "output"> & Partial<Proof>): Proof {
  const stored: Proof = {
    ...proof,
    step: step.id,
    command: maskArgv(proof.command),
    sha: state.sha,
    dirty: state.dirty,
    ...(state.watched ? { watched: state.watched } : {}),
    ...(step.before ? { untracked: state.untracked } : {}),
    commandFiles: commandFilesHash(gate),
    timestamp: new Date().toISOString(),
  };
  gate.proofs.push(stored);
  return stored;
}

export function meets(step: Step, proof: Proof): boolean {
  if (proof.exitCode === null || proof.failure) return false;
  if (step.expect === "any") return true;
  return step.expect === "nonzero" ? proof.exitCode !== 0 : proof.exitCode === 0;
}

/** A masked argv cannot be rerun: the real command stays in memory, never in the gate file. */
const liveCommands = new Map<string, Gate["commands"]>();

export function commandFor(gate: Gate, step: Step): string[] | undefined {
  if (!step.command) return undefined;
  const commands = liveCommands.get(gate.id.toLowerCase()) ?? gate.commands;
  const command = commands[step.command] ?? (step.command === "failingTest" ? commands.test : undefined);
  if (command?.includes(REDACTED) || command?.some((a) => a.endsWith(`=${REDACTED}`))) throw new Error("Command masked, server restarted: reopen a gate with gate_start");
  return command;
}

export interface StartInput {
  workflow: Workflow;
  repoPath: string;
  commands: Gate["commands"];
  lintMarker?: string | undefined;
  watchIgnored?: string[] | undefined;
  authorizedBy?: string | undefined;
}

export async function startGate(input: StartInput, root?: string) {
  const top = await git(input.repoPath, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error(`The path is not inside a git repository: ${input.repoPath}`);
  const repo = top.stdout.trim();
  const watchIgnored = (input.watchIgnored ?? []).map((p) => checkRelative(p, "watchIgnored"));
  for (const [key, command] of Object.entries(input.commands)) checkCommand(command, repo, input.workflow === "fix-bug" && key === "failingTest");
  const distinct = Object.entries(input.commands).filter(([key]) => key !== "failingTest");
  const seen = new Set(distinct.map(([, command]) => commandKey(command, repo)));
  if (seen.size !== distinct.length) throw new Error("Commands refused: two steps have an identical command");
  const authorizedBy = input.authorizedBy?.trim() ? redact(input.authorizedBy.trim()) : undefined;
  if (authorizedBy && (authorizedBy.split(/\s+/).length < 3 || /^(non|no|n)\b/i.test(authorizedBy))) {
    throw new Error("authorizedBy refused: expected a sentence from the user granting authorization, not a single word");
  }
  const gate: Gate = {
    id: randomUUID(),
    workflow: input.workflow,
    repo,
    sha: (await repoState(repo, watchIgnored)).sha,
    ...(watchIgnored.length > 0 ? { watchIgnored } : {}),
    commands: Object.fromEntries(Object.entries(input.commands).map(([key, command]) => [key, maskArgv(command)])),
    ...(input.lintMarker === undefined ? {} : { lintMarker: input.lintMarker }),
    ...(authorizedBy ? { authorizedBy } : {}),
    notes: {},
    proofs: [],
    httpCount: 0,
    createdAt: new Date().toISOString(),
  };
  if (JSON.stringify(gate.commands) !== JSON.stringify(input.commands)) liveCommands.set(gate.id, input.commands);
  const recentGates = otherGates(gate, root);
  saveGate(gate, root);
  const steps = CHECKLISTS[gate.workflow];
  const missingCommands = [...new Set(steps.filter((s) => s.command && s.required && !commandFor(gate, s)).map((s) => s.command as string))];
  return { gateId: gate.id, workflow: gate.workflow, repo, sha: gate.sha, steps, missingCommands, recentGates };
}

export async function runStep(gate: Gate, stepId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
  const step = stepOf(gate, stepId);
  if (step.kind !== "run") throw new Error(`Judged step: use gate_note (${step.id})`);
  if (step.tool) throw new Error(`Step proved by ${step.tool} (${step.id})`);
  const command = commandFor(gate, step);
  if (!command) throw new Error(`No ${String(step.command)} command given to gate_start`);
  // The state before the run: that is the one that was tested, even if the command writes into the repo.
  const state = await repoState(gate.repo, gate.watchIgnored);
  refuseLateBefore(gate, step, state);
  checkCommand(command, gate.repo);
  const started = Date.now();
  const r = await runCommand(command, gate.repo, timeoutMs);
  const text = `${r.stdout}\n${r.stderr}`;
  const usable = step.command === "lint" && r.exitCode !== null;
  const tests = step.command === "test" || step.command === "failingTest" ? await readCounts(gate.repo, text, started) : null;
  const proof = addProof(gate, step, state, {
    command,
    exitCode: r.exitCode,
    output: storedOutput(text),
    ...(r.failure ? { failure: redact(r.failure) } : {}),
    ...(usable ? { warnings: parseWarnings(text, gate.lintMarker) } : {}),
    ...(tests ? { tests } : {}),
  });
  return { step: step.id, exitCode: proof.exitCode, ok: meets(step, proof), expected: step.expect, warnings: proof.warnings, tests: proof.tests, failure: proof.failure, output: proof.output };
}

/** The output first; otherwise the JUnit XML files this run just wrote, usually ignored by git. */
async function readCounts(repo: string, text: string, sinceMs: number): Promise<TestCounts | null> {
  const parsed = parseTests(text);
  if (parsed) return parsed;
  const ignored = (await gitOut(repo, ["ls-files", "-o", "-i", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  return readJunitXml(repo, ignored, sinceMs);
}

const sha256Of = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface NoteInput {
  note: string;
  examinedFile?: string | undefined;
  examinedSha256?: string | undefined;
}

export function noteStep(gate: Gate, stepId: string, input: NoteInput): void {
  const step = stepOf(gate, stepId);
  if (step.kind !== "judged") throw new Error(`Run step: a note does not prove it (${step.id})`);
  const { examinedFile: file, examinedSha256: sha256 } = input;
  if ((file !== undefined || sha256 !== undefined) && !step.evidence) throw new Error(`Step takes no examined file: ${step.id}`);
  if (file !== undefined || sha256 !== undefined) {
    if (file === undefined || sha256 === undefined) throw new Error("examinedFile and examinedSha256 go together");
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Examined file missing: ${file}`);
    if (sha256Of(file) !== sha256.toLowerCase()) throw new Error(`Hash differs from the file's: ${file}`);
    gate.examined = { ...gate.examined, [step.id]: { file, sha256: sha256.toLowerCase() } };
  }
  gate.notes[step.id] = redact(input.note);
}

/** Why the note is worthless. Re-read each time: the file may have changed or vanished. */
function evidenceGap(gate: Gate, step: Step): string | null {
  if (!step.evidence) return null;
  const seen = gate.examined?.[step.id];
  if (!seen) return "note without an examined file";
  if (!lstatSync(seen.file, { throwIfNoEntry: false })?.isFile()) return `examined file gone: ${seen.file}`;
  return sha256Of(seen.file) === seen.sha256 ? null : `examined file changed: ${seen.file}`;
}

function isFinal(proof: Proof, state: RepoState): boolean {
  return proof.sha === state.sha && proof.dirty === state.dirty;
}

async function isAncestor(repo: string, sha: string, of: string): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", sha, of])).code === 0;
}

const usableProofs = (gate: Gate, stepId: string) => gate.proofs.filter((p) => p.step === stepId && p.exitCode !== null);

/** A "before" cannot be redone once the state has moved on: the first proof fixes the reference state. */
function refuseLateBefore(gate: Gate, step: Step, state: RepoState): void {
  if (!step.before) return;
  if (gate.proofs.some((p) => !stepOf(gate, p.step).before)) throw new Error(`Before step refused: after-proofs already exist (${step.id})`);
  const first = usableProofs(gate, step.id)[0];
  if (first && !isFinal(first, state)) throw new Error(`Before step refused: already taken on another state (${step.id})`);
}

/** Decides on the first usable proof; only a new attempt on the same state can replace it. */
async function beforeProof(gate: Gate, step: Step, state: RepoState, limit: number): Promise<{ proof?: Proof; reason: string }> {
  const first = usableProofs(gate, step.id)[0];
  if (!first) return { reason: "no proof" };
  const proof = usableProofs(gate, step.id).filter((p) => p.sha === first.sha && p.dirty === first.dirty).at(-1) as Proof;
  if (!meets(step, proof)) return { reason: "condition not met" };
  if (isFinal(first, state)) return { reason: "taken on the final state, nothing has changed since" };
  if (gate.proofs.indexOf(first) > limit) return { reason: "taken after the final proofs" };
  if (first.sha === state.sha) return step.strictAncestor ? { reason: "the final commit must be a descendant, strict ancestor required" } : { proof, reason: "" };
  if (!(await isAncestor(gate.repo, first.sha, state.sha))) return { reason: "commit that is not an ancestor of the final commit" };
  return { proof, reason: "" };
}

/** Only the comparison matters. A lint that still errors passes if it counts something: a crash would count zero. */
function compareLint(afterProof: Proof, beforeProof: Proof | undefined, ref: string): string | null {
  const after = afterProof.warnings;
  const before = beforeProof?.warnings;
  if (!after || !before) return `cannot compare with ${ref}`;
  const [errorsAfter, errorsBefore] = [after.errors ?? 0, before.errors ?? 0];
  const failed = afterProof.exitCode !== 0;
  if (failed && beforeProof?.exitCode === 0) return `lint failing, it was not before: code ${String(afterProof.exitCode)}`;
  if (failed && after.count + errorsAfter === 0) return `lint failing without counting anything: code ${String(afterProof.exitCode)}`;
  if (after.count > before.count) return `warnings up: ${after.count} vs ${before.count}`;
  if (errorsAfter > errorsBefore) return `errors up: ${errorsAfter} vs ${errorsBefore}`;
  if (after.count + errorsAfter > 0 && after.parser !== before.parser) return `counts not comparable (${before.parser}, ${after.parser})`;
  return null;
}

/** The fix must still be there: same test file, and nothing but tests changed since. */
export async function fixGone(repo: string, fix: string, testFile: string, sha: string): Promise<string | null> {
  if (fix === sha) return null;
  const blob = async (commit: string) => (await git(repo, ["rev-parse", "--verify", "--quiet", `${commit}:${testFile}`])).stdout.trim();
  if ((await blob(fix)) !== (await blob(sha))) return `${testFile} changed since the fix`;
  const changed = (await gitOut(repo, ["diff", "--name-only", "--no-renames", "-z", fix, sha])).split("\0").filter(Boolean);
  const others = changed.filter((p) => !isTestPath(p));
  return others.length === 0 ? null : `commits after the fix outside the tests: ${others.slice(0, 5).join(", ")}`;
}

/** The relative paths cited by the commands, executable included. */
function commandFiles(gate: Gate): Set<string> {
  const paths = Object.values(gate.commands).flat().map((arg) => relative(gate.repo, resolve(gate.repo, arg)).split(sep).join("/"));
  return new Set(paths.filter((p) => p !== "" && !p.startsWith("..") && !isAbsolute(p)));
}

/** Adding a case to a test file is normal work; a removed or changed line is not. */
async function onlyAdditions(repo: string, sha: string, path: string): Promise<boolean> {
  const args = ["diff", "--numstat", "--no-ext-diff", "--no-textconv", sha, "--", `:(literal)${path}`];
  const [, deleted] = (await gitOut(repo, args, { env: await noFilters(repo) })).split("\t");
  return deleted === "0";
}

/** A completed test is allowed on `build-feature` and `fix-bug`: it does not count here, the diff judges it. */
function commandFilesHash(gate: Gate): string {
  const files = [...commandFiles(gate)].filter((p) => gate.workflow === "clean-up" || !isTestPath(p)).sort();
  return hashUntracked(files, (p) => readUntracked(gate.repo, p));
}

/** Anything that is not ordinary source and has changed since the first before-proof caps the score at 9. */
async function controlChanges(gate: Gate, base: Proof, proofs: readonly Proof[], state: RepoState, ev: Evaluation): Promise<void> {
  const repo = gate.repo;
  const tokens = (await gitOut(repo, ["diff", "--name-status", "--find-renames", "-z", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", base.sha], { env: await noFilters(repo) })).split("\0").filter(Boolean);
  const changes: [string, string][] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] as string;
    const renamed = status.startsWith("R") || status.startsWith("C");
    changes.push([status, tokens[renamed ? i + 2 : i + 1] as string]);
    i += renamed ? 3 : 2;
  }
  // The same list as the hash, compared with the first proof: an unchanged untracked file has not changed.
  const before = base.untracked ?? {};
  for (const [path, hash] of Object.entries(state.untracked)) {
    if (before[path] !== hash) changes.push([path in before ? "M" : "A", path]);
  }
  for (const path of Object.keys(before)) {
    // Committed since, it has not vanished: the diff judges it.
    if (!(path in state.untracked) && !lstatSync(join(repo, path), { throwIfNoEntry: false })) changes.push(["D", path]);
  }
  const cited = commandFiles(gate);
  for (const [status, path] of changes) {
    if (path.startsWith(".proofbench/")) continue;
    const kind = controlKind(path, cited);
    if (kind === "control") flag(ev, 9, `control file changed: ${path}`);
    else if (kind === "test" && status === "D") flag(ev, 8, `test deleted: ${path}`);
    else if (kind === "test" && status === "A" && gate.workflow !== "clean-up") ev.warnings.push(`test added: ${path}`);
    else if (kind === "test" && status === "M" && gate.workflow !== "clean-up" && (await onlyAdditions(repo, base.sha, path))) ev.warnings.push(`test extended, added lines only: ${path}`);
    else if (kind === "test") flag(ev, 9, `test ${status === "A" ? "added" : "modified"} since the before-proof: ${path}`);
  }
  if (proofs.some((p) => p.commandFiles !== base.commandFiles)) flag(ev, 9, "files cited by the commands changed, read from disk");
  if (base.watched !== state.watched) flag(ev, 9, `watched ignored files changed: ${(gate.watchIgnored ?? []).join(", ")}`);
}

function flag(ev: Evaluation, limit: number, reason: string): void {
  ev.caps.push({ limit, reason });
  ev.warnings.push(reason);
}

const isTestStep = (step: Step) => step.command === "test" || step.command === "failingTest";

function comparePair(step: Step, after: Proof, before: Proof, ev: Evaluation): string | null {
  const same = JSON.stringify(after.command) === JSON.stringify(before.command);
  if (!same) return step.sameCommand ? `command differs from ${before.step}` : null;
  if (!after.tests || !before.tests) return null;
  if (after.tests.skipped > before.tests.skipped) flag(ev, 8, `skipped tests up: ${after.tests.skipped} vs ${before.tests.skipped}`);
  return after.tests.total < before.tests.total ? `tests down: ${after.tests.total} vs ${before.tests.total}` : null;
}

export async function evaluate(gate: Gate, state: RepoState): Promise<Evaluation> {
  const steps = CHECKLISTS[gate.workflow];
  const results = new Map<string, StepResult>();
  const ev: Evaluation = { steps: [], caps: [], warnings: [] };
  const set = (step: Step, status: StepResult["status"], reason?: string) =>
    results.set(step.id, { id: step.id, label: step.label, kind: step.kind, required: step.required, status, ...(reason ? { reason } : {}) });
  const counted = new Map<string, Proof>();

  for (const step of steps.filter((s) => s.kind === "run" && !s.before)) {
    const mine = gate.proofs.filter((p) => p.step === step.id);
    const latest = mine.filter((p) => isFinal(p, state)).at(-1);
    const gone = latest?.fix && latest.testFile ? await fixGone(gate.repo, latest.fix, latest.testFile, state.sha) : null;
    if (!latest) set(step, "missing", mine.length === 0 ? "no proof" : "stale proof: commit or files changed since");
    else if (latest.notApplicable) set(step, "na", "not applicable: no Android manifest");
    else if (step.allProofs && mine.some((p) => !meets(step, p))) set(step, "missing", "at least one request failed");
    else if (!meets(step, latest)) set(step, "missing", latest.failure ?? `exit code ${String(latest.exitCode)}`);
    else if (gone) set(step, "missing", gone);
    else {
      counted.set(step.id, latest);
      set(step, "proved");
    }
  }
  const firstFinal = Math.min(...[...counted.values()].map((p) => gate.proofs.indexOf(p)), Infinity);
  for (const step of steps.filter((s) => s.before)) {
    const { proof, reason } = await beforeProof(gate, step, state, firstFinal);
    if (proof) counted.set(step.id, proof);
    set(step, proof ? "proved" : "missing", reason);
  }
  for (const step of steps.filter((s) => counted.has(s.id))) {
    const proof = counted.get(step.id) as Proof;
    const before = step.pairedWith ? counted.get(step.pairedWith) : undefined;
    const reason = (before ? comparePair(step, proof, before, ev) : null) ?? (step.noWorseThan ? compareLint(proof, counted.get(step.noWorseThan), step.noWorseThan) : null);
    if (reason) set(step, "missing", reason);
    if (isTestStep(step) && step.id !== "revert_fails" && !proof.tests) flag(ev, 9, `unreadable test count: ${step.id}`);
    if (isTestStep(step) && step.expect !== "nonzero" && proof.tests?.total === 0) flag(ev, 9, `no test run: ${step.id}`);
    if (step.command === "lint" && (step.noWorseThan || step.before) && !hasLintCount(proof.warnings)) flag(ev, 9, `lint without a readable count: ${step.id}`);
  }
  for (const step of steps.filter((s) => s.kind === "judged")) {
    const gap = evidenceGap(gate, step);
    if (step.androidOnly && gate.proofs.filter((p) => p.step === "manifest").at(-1)?.notApplicable) set(step, "na", "not applicable: no Android manifest");
    else if (!gate.notes[step.id]?.trim()) set(step, "missing", "note missing");
    else if (gap) set(step, "missing", gap);
    else set(step, "noted");
  }
  const earliest = gate.proofs.find((p) => p.exitCode !== null && stepOf(gate, p.step).before);
  if (earliest) await controlChanges(gate, earliest, [...counted.values()], state, ev);
  const base = counted.get("tests_before") ?? counted.get("failing_test_before");
  if (gate.workflow === "clean-up" && base) {
    const tree = async (sha: string) => (await gitOut(gate.repo, ["rev-parse", `${sha}^{tree}`])).trim();
    if ((await tree(base.sha)) === (await tree(state.sha))) flag(ev, 9, "nothing to clean up: no difference between before and after");
  }
  const { test, failingTest } = gate.commands;
  if (gate.workflow === "build-feature" && test && failingTest && baseName(test[0] as string) !== baseName(failingTest[0] as string)) {
    flag(ev, 9, "failingTest does not use the same executable as test");
  }
  ev.steps = steps.map((s) => results.get(s.id) as StepResult);
  return ev;
}

/**
 * round(10 × proved required run steps / required run steps). A note does not enter the calculation, so it
 * cannot raise anything; if one is missing, or a run step is: the ceiling is 9. `caps` lowers it further.
 */
export function scoreOf(results: readonly StepResult[], caps: readonly Cap[] = []): number {
  const required = results.filter((r) => r.required && r.status !== "na");
  const runs = required.filter((r) => r.kind === "run");
  const proved = runs.filter((r) => r.status === "proved").length;
  const base = required.every((r) => r.status !== "missing") ? 10 : Math.min(9, Math.round((10 * proved) / runs.length));
  return Math.min(base, ...caps.map((c) => c.limit));
}

export function missingOf(results: readonly StepResult[], caps: readonly Cap[] = []): string[] {
  return [
    ...results.filter((r) => r.required && r.status === "missing").map((r) => `${r.id}: ${r.reason ?? "missing"}`),
    ...caps.map((c) => `cap ${c.limit}: ${c.reason}`),
  ];
}

export async function statusOf(gate: Gate) {
  const state = await repoState(gate.repo, gate.watchIgnored);
  const { steps, caps, warnings } = await evaluate(gate, state);
  return { gateId: gate.id, workflow: gate.workflow, sha: state.sha, steps, missing: missingOf(steps, caps), warnings };
}
