import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import { git, type GitResult } from "./git.js";
import { addEvidence, type Evidence, type Investigation, type ReusedAnswer, type Snapshot } from "./investigation.js";
import { sessionSecrets } from "./jira-session.js";
import { assertInWorktrees, defaultWorktreesDir, restoreCopyFiles } from "./snapshot.js";
import { isComparable, maybeSameCommit, normalizeScenario } from "./verdict.js";

export interface BisectStep {
  done: boolean;
  testSha?: string;
  worktree: string;
  culprit?: string;
  remainingEstimate: number;
  /** Bisect finished without a culprit: the culprit is one of these. */
  possibleCommits?: string[];
  /** What remains to be done when the bisect ends without a culprit for lack of a test. */
  instruction?: string;
  /** Assisted bisect: answers reused from an earlier attestation, since its start. */
  reusedAnswers?: ReusedAnswer[];
  /** Culprit found thanks to these reuses: nothing is written before `bisectConfirm`. `done` stays false. */
  pendingCulprit?: string;
}

export type BisectAutoStep = BisectStep & {
  stoppedByBudget: boolean;
  /** Why the loop stopped before the end; absent if the bisect completed. */
  stopReason?: string;
};

export type BisectAnswer = "good" | "bad" | "skip";

export interface BisectStartInput {
  /** How the bug reproduces. */
  scenario: string;
  reuseAnswers: boolean;
}

/** Saves the investigation along the way: the server supplies it, git advances without waiting for the end of the call. */
export type Persist = () => void;
const noPersist: Persist = () => undefined;

export interface Attestation {
  statement: string;
  version: string;
  sha?: string;
  outcome?: "bad" | "good";
  intermittent?: boolean;
  kind: "tested" | "asserted";
  /** `tested` only: how the bug was reproduced. Without it, the answer is not reused. */
  scenario?: string;
}

const IS_WIN = process.platform === "win32";
const SHA_RE = /^[0-9a-f]{40}$/;
/** A `git bisect` changes commit: on a large repository, much longer than git()'s default timeout. */
const GIT_STEP_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const OUTPUT_CAP = 20_000;
/** After the kill, delay given to the output to close before handing control back anyway. */
const KILL_GRACE_MS = 3_000;
const STRIPPED_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
const SECRET_ENV = new Set(["GITLAB_TOKEN", "JIRA_API_TOKEN", "JIRA_EMAIL"]);
const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|KEY/;
const REDACTED = "[redacted]";
/** Any shorter and masking would erase unrelated text: a `1` would make the evidence unreadable. */
const MIN_SECRET_LENGTH = 8;
const CONFIRMATION_FAILED = "confirmation_failed";

const ATTEST_BOUND_INSTRUCTION =
  "The bad commit was never tested: attest it (tested attestation, result bad), then redo the bisect.";
const CLEAN_LIMIT = "Caches outside the working copy and build daemons are not cleaned.";
const WINDOWS_KILL_LIMIT =
  "On Windows, a process killed from outside exits with code 1, indistinguishable from a real failure: only the confirmation runs limit this risk.";

const short = (sha: string) => sha.slice(0, 12);

function addNote(inv: Investigation, note: string): void {
  if (!inv.coverage.notExamined.includes(note)) inv.coverage.notExamined.push(note);
}

/** Start of the notes of a bisect on this repository: everything they say about it lapses when a culprit comes out. */
const failedPrefix = (repoId: string) => `bisect (${repoId}): `;

function addBisectNote(inv: Investigation, repoId: string, note: string): void {
  addNote(inv, `${failedPrefix(repoId)}${note}`);
}

/** A culprit being found makes the failed attempts of its repository obsolete. Another repository keeps its own. */
function clearBisectNotes(inv: Investigation, repoId: string): void {
  const prefix = failedPrefix(repoId);
  inv.coverage.notExamined = inv.coverage.notExamined.filter((n) => !n.startsWith(prefix));
}

/** A verified copy, with the folder where it must stay: each cleanup checks it again. */
type OwnedSnapshot = Snapshot & { worktreesDir: string };

/**
 * Rejects any path that is not a copy of the investigation: `git bisect` moves HEAD wherever it runs.
 * Returns the investigation's entry, the only trusted source of `copyFiles`.
 */
function ownedSnapshot(inv: Investigation, snapshot: Snapshot, worktreesDir: string): OwnedSnapshot {
  const owned = inv.snapshots.find((s) => s.path === snapshot?.path);
  if (!owned) throw new Error(`Bisect refused, working copy outside the investigation: ${JSON.stringify(snapshot?.path)}`);
  assertInWorktrees(owned, worktreesDir);
  return { ...owned, worktreesDir };
}

const busy = new Set<string>();

/** The server is a single process: this lock is enough to keep two bisects from crossing on one copy. */
async function exclusive<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const key = resolvePath(cwd);
  if (busy.has(key)) throw new Error(`Working copy busy with another bisect: ${cwd}`);
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}

/** Throws if git failed: a failed restore must never pass for a success. */
function must(r: GitResult, what: string): void {
  if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim()}`);
}

const gitStep = (cwd: string, args: string[]) => git(cwd, args, { timeoutMs: GIT_STEP_TIMEOUT_MS });

/**
 * Only a linked worktree has a git-dir distinct from the common repository. The investigation file may be corrupted:
 * nothing destructive must be able to target a real repository, even if `inv.snapshots` designates it.
 */
async function assertLinkedWorktree(cwd: string): Promise<void> {
  const dir = await git(cwd, ["rev-parse", "--git-dir"]);
  const common = await git(cwd, ["rev-parse", "--git-common-dir"]);
  const linked =
    dir.code === 0 &&
    common.code === 0 &&
    dir.stdout.trim() !== "" &&
    common.stdout.trim() !== "" &&
    resolvePath(cwd, dir.stdout.trim()) !== resolvePath(cwd, common.stdout.trim());
  if (!linked) throw new Error(`Bisect refused, this path is not a linked worktree: ${cwd}`);
}

/**
 * Removes everything a build left behind, ignored files included, then restores the files copied at opening. The command
 * of an automatic bisect runs between two cleanups: the path is re-checked every time.
 */
async function cleanWorktree(snapshot: OwnedSnapshot): Promise<void> {
  assertInWorktrees(snapshot, snapshot.worktreesDir);
  await assertLinkedWorktree(snapshot.path);
  must(await gitStep(snapshot.path, ["clean", "-ffdx"]), "git clean");
  restoreCopyFiles(snapshot);
}

async function hardReset(snapshot: OwnedSnapshot): Promise<void> {
  assertInWorktrees(snapshot, snapshot.worktreesDir);
  await assertLinkedWorktree(snapshot.path);
  must(await gitStep(snapshot.path, ["reset", "-q", "--hard"]), "git reset");
}

/** Evidence with no recorded repository attaches to nothing: better to remove it than to keep it wrongly. */
function supersedeCulprits(inv: Investigation, repoId: string): void {
  for (const e of inv.evidence) {
    if (e.subject?.outcome !== "culprit") continue;
    const repo = (e.data as { repoId?: unknown } | null)?.repoId;
    if (repo === undefined || repo === repoId) e.superseded = true;
  }
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  if (typeof ref !== "string" || ref === "" || ref.startsWith("-") || ref.includes("\0")) {
    throw new Error(`Reference refused: ${JSON.stringify(ref)}`);
  }
  const r = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(sha)) throw new Error(`Unknown reference: ${ref}`);
  return sha;
}

async function resolveRange(cwd: string, good: string, bad: string): Promise<{ good: string; bad: string }> {
  const range = { good: await resolveCommit(cwd, good), bad: await resolveCommit(cwd, bad) };
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", range.good, range.bad]);
  if (range.good === range.bad || ancestor.code !== 0) {
    throw new Error(`The good state ${good} must be a strict ancestor of the bad state ${bad}`);
  }
  return range;
}

interface BisectState {
  head: string;
  /** The commit git wanted tested: it differs from HEAD if its checkout failed. */
  expected: string;
  bad: string;
  goods: string[];
  skips: string[];
  /** Commits where the first bad one may still be, `bad` and ignored included. */
  candidates: string[];
  /** Candidates still to test: neither `bad` nor ignored. */
  untested: string[];
}

/** The state comes from the copy's bisect refs, specific to each worktree: nothing else is persisted. */
async function readState(cwd: string): Promise<BisectState | null> {
  const refs = await git(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/bisect/"]);
  if (refs.code !== 0) throw new Error(`Cannot read the bisect state: ${refs.stderr.trim()}`);

  let bad: string | undefined;
  const goods: string[] = [];
  const skips: string[] = [];
  for (const line of refs.stdout.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (!sha || !name) continue;
    if (name === "refs/bisect/bad") bad = sha;
    else if (name.startsWith("refs/bisect/good-")) goods.push(sha);
    else if (name.startsWith("refs/bisect/skip-")) skips.push(sha);
  }
  if (bad === undefined) return null;

  const listed = await gitStep(cwd, ["rev-list", bad, ...goods.map((g) => `^${g}`), "--"]);
  if (listed.code !== 0) throw new Error(`Cannot read the bisect state: ${listed.stderr.trim()}`);
  const candidates = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  const expected = (await git(cwd, ["rev-parse", "--verify", "--quiet", "BISECT_EXPECTED_REV"])).stdout.trim();
  const untested = candidates.filter((c) => c !== bad && !skips.includes(c));
  return { head, expected, bad, goods, skips, candidates, untested };
}

/** The start bounds, re-read from the copy's log. Commit messages appear there only as comments. */
async function readBounds(cwd: string): Promise<{ good: string; bad: string }> {
  const r = await git(cwd, ["bisect", "log"]);
  must(r, "git bisect log");
  const m = /^git bisect start '([0-9a-f]{40})' '([0-9a-f]{40})'/m.exec(r.stdout);
  if (!m) throw new Error("Bisect bounds not found in the log");
  return { bad: m[1]!, good: m[2]! };
}

async function assertNoBisect(cwd: string): Promise<void> {
  if (await readState(cwd)) throw new Error("A bisect is already in progress in this working copy");
}

/** A tracked modification survives the commit change and would skew every following test. */
async function assertTrackedClean(cwd: string): Promise<void> {
  const r = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (r.code !== 0 || r.stdout.trim() !== "") {
    throw new Error(`Tracked files modified in the working copy, restore them first: ${r.stdout.trim() || r.stderr.trim()}`);
  }
}

function assertAtTestCommit(state: BisectState): void {
  if (state.head !== state.expected || !state.untested.includes(state.head)) {
    throw new Error(`The working copy is not at the commit to test: HEAD ${state.head}, expected ${state.expected}`);
  }
}

type Conclusion =
  | { kind: "next"; sha: string; remaining: number }
  | { kind: "culprit"; sha: string }
  | { kind: "undetermined"; commits: string[] };

/**
 * The computation on the refs decides, and git's text must confirm it: neither alone
 * designates a culprit. Git's output contains the commit messages: it is never parsed,
 * we only look in it for the sha already computed.
 */
function conclude(state: BisectState, r: GitResult): Conclusion {
  if (state.untested.length > 0) {
    if (r.code !== 0) throw new Error(`git bisect failed: ${r.stderr.trim()}`);
    assertAtTestCommit(state);
    return { kind: "next", sha: state.head, remaining: Math.ceil(Math.log2(state.untested.length + 1)) };
  }
  if (state.candidates.length > 1) return { kind: "undetermined", commits: state.candidates };
  const confirmed = `${r.stdout}\n${r.stderr}`.includes(`${state.bad} is the first bad commit`);
  if (state.candidates[0] !== state.bad || !confirmed) {
    throw new Error(`End of bisect not confirmed by git for ${state.bad}: ${r.stderr.trim()}`);
  }
  return { kind: "culprit", sha: state.bad };
}

async function startBisect(cwd: string, good: string, bad: string): Promise<{ r: GitResult; state: BisectState }> {
  const r = await gitStep(cwd, ["bisect", "start", bad, good, "--"]);
  const state = await readState(cwd);
  if (!state) throw new Error(`git bisect start failed: ${r.stderr.trim()}`);
  return { r, state };
}

async function applyAnswer(
  cwd: string,
  answer: BisectAnswer,
  sha: string,
): Promise<{ r: GitResult; state: BisectState }> {
  const r = await gitStep(cwd, ["bisect", answer, sha]);
  const state = await readState(cwd);
  const recorded =
    state !== null &&
    (answer === "good" ? state.goods.includes(sha) : answer === "skip" ? state.skips.includes(sha) : state.bad === sha);
  if (!state || !recorded) throw new Error(`git bisect ${answer} was not taken into account: ${r.stderr.trim()}`);
  return { r, state };
}

function noteUndetermined(inv: Investigation, repoId: string, commits: string[]): void {
  addBisectNote(inv, repoId, `culprit undetermined because of ignored commits, possible ones: ${commits.map(short).join(", ")}`);
}

/** The investigation's entry, the one that gets saved: `OwnedSnapshot` is only a copy of it. */
const entryOf = (inv: Investigation, owned: OwnedSnapshot) => inv.snapshots.find((s) => s.path === owned.path);

const dataOf = (e: Evidence) =>
  (e.data ?? {}) as { repoId?: unknown; scenario?: unknown; intermittent?: unknown; answer?: unknown; sha?: unknown; statement?: unknown };

function assertScenario(scenario: unknown): void {
  if (typeof scenario !== "string" || scenario.trim() === "") throw new Error(`Empty scenario: ${JSON.stringify(scenario)}`);
}

/**
 * The word the user already gave on this commit, for this scenario, or nothing if it must be asked again. It must
 * follow their last "no" to the intermittency question, and no "cannot be tested" may follow it. Evidence with no
 * recorded repository or scenario attaches to nothing, so it is not reused.
 */
function priorAnswer(inv: Investigation, repoId: string, sha: string, scenario: string): ReusedAnswer | null {
  if (inv.intermittent !== false) return null;
  const standing = inv.evidence.filter((e) => !e.superseded);
  const about = standing.filter((e) => maybeSameCommit(e.subject?.sha ?? "", sha)).map((e) => e.subject?.outcome);
  if (about.includes("good") && about.includes("bad")) return null;

  const wanted = normalizeScenario(scenario);
  const since = inv.evidence.map((e) => dataOf(e).intermittent === false).lastIndexOf(true);
  if (since < 0) return null;
  let found: { e: Evidence; outcome: "good" | "bad" } | undefined;
  for (const e of inv.evidence.slice(since + 1).filter((x) => !x.superseded)) {
    const data = dataOf(e);
    if (data.repoId !== repoId) continue;
    if (data.answer === "skip" && data.sha === sha) {
      found = undefined;
      continue;
    }
    const outcome = e.subject?.outcome;
    if (e.kind !== "attestation" || e.subject?.sha !== sha || (outcome !== "good" && outcome !== "bad")) continue;
    if (typeof data.scenario === "string" && normalizeScenario(data.scenario) === wanted) found = { e, outcome };
  }
  if (!found) return null;
  const { statement } = dataOf(found.e);
  return { sha, outcome: found.outcome, evidenceId: found.e.id, ...(typeof statement === "string" ? { statement } : {}) };
}

/**
 * Applies the answers already given up to a commit with no answer or the end of the bisect. No cleanup: nothing
 * has been built on these commits. Each answer removes at least one commit from the candidates, hence the bound.
 * The reuse is written before git advances: a crash between the two must not make us forget there was one.
 */
async function advanceOnPriorAnswers(
  inv: Investigation,
  owned: OwnedSnapshot,
  moved: { r: GitResult; state: BisectState },
  persist: Persist,
): Promise<{ conclusion: Conclusion; state: BisectState }> {
  const assisted = entryOf(inv, owned)?.assisted;
  let { r, state } = moved;
  for (let left = state.candidates.length; ; left--) {
    const conclusion = conclude(state, r);
    if (conclusion.kind !== "next" || !assisted?.reuseAnswers) return { conclusion, state };
    const answer = priorAnswer(inv, owned.repoId, conclusion.sha, assisted.scenario);
    if (!answer) return { conclusion, state };
    if (left <= 0) throw new Error("Bisect refused: the reused answers do not make it advance");
    await assertLinkedWorktree(owned.path);
    assisted.reused.push(answer);
    persist();
    ({ r, state } = await applyAnswer(owned.path, answer.outcome, conclusion.sha));
  }
}

/** The sequence shared by start and answers. `opening`: this bisect has not yet replaced any culprit. */
async function nextAssistedStep(
  inv: Investigation,
  owned: OwnedSnapshot,
  moved: { r: GitResult; state: BisectState },
  opening: boolean,
  persist: Persist,
): Promise<BisectStep> {
  const { conclusion, state } = await advanceOnPriorAnswers(inv, owned, moved, persist);
  const assisted = entryOf(inv, owned)?.assisted;
  const reusedAnswers = [...(assisted?.reused ?? [])];
  // A reused answer may come from a failed reproduction: only the user can draw a culprit from it.
  if (conclusion.kind === "culprit" && assisted && reusedAnswers.length > 0 && hasTest(inv, conclusion.sha, "bad", assisted.scenario)) {
    assisted.pendingCulprit = conclusion.sha;
    if (opening) supersedeCulprits(inv, owned.repoId);
    return { done: false, pendingCulprit: conclusion.sha, worktree: owned.path, remainingEstimate: 0, reusedAnswers };
  }
  if (conclusion.kind !== "next") return closeAssisted(inv, owned, conclusion, state, opening);
  await cleanWorktree(owned);
  if (opening) supersedeCulprits(inv, owned.repoId);
  return { done: false, testSha: conclusion.sha, worktree: owned.path, remainingEstimate: conclusion.remaining, reusedAnswers };
}

export async function bisectStart(
  inv: Investigation,
  snapshot: Snapshot,
  good: string,
  bad: string,
  input: BisectStartInput,
  worktreesDir: string = defaultWorktreesDir(),
  persist: Persist = noPersist,
): Promise<BisectStep> {
  const owned = ownedSnapshot(inv, snapshot, worktreesDir);
  const cwd = owned.path;
  assertScenario(input?.scenario);
  if (typeof input.reuseAnswers !== "boolean") throw new Error(`reuseAnswers must be a boolean: ${JSON.stringify(input.reuseAnswers)}`);
  const { scenario, reuseAnswers } = input;
  return exclusive(cwd, async () => {
    await assertLinkedWorktree(cwd);
    const range = await resolveRange(cwd, good, bad);
    await assertNoBisect(cwd);
    await assertTrackedClean(cwd);

    // Without a commit in between, git would conclude without any test having taken place.
    const between = await git(cwd, ["rev-list", "--count", range.bad, `^${range.good}`, "--"]);
    if (between.stdout.trim() === "1") {
      throw new Error(`Nothing to bisect: ${good} is the direct parent of ${bad}, test both`);
    }

    try {
      await cleanWorktree(owned);
      const { r, state } = await startBisect(cwd, range.good, range.bad);
      if (conclude(state, r).kind !== "next") throw new Error("git bisect start offered no commit to test");
      const entry = entryOf(inv, owned);
      if (entry) entry.assisted = { scenario, reuseAnswers, reused: [], answerIds: [] };
      persist();
      return await nextAssistedStep(inv, owned, { r, state }, true, persist);
    } catch (e) {
      delete entryOf(inv, owned)?.assisted;
      const reset = await gitStep(cwd, ["bisect", "reset"]);
      if (reset.code !== 0) throw new Error(`${(e as Error).message}; git bisect reset failed: ${reset.stderr.trim()}`);
      throw e;
    }
  });
}

/** A test from another explicit scenario says nothing about this one. */
function hasTest(inv: Investigation, sha: string, outcome: "good" | "bad", scenario?: string): boolean {
  const wanted = scenario === undefined ? undefined : normalizeScenario(scenario);
  return inv.evidence.some(
    (e) =>
      !e.superseded &&
      (e.kind === "execution" || e.kind === "attestation") &&
      e.subject?.sha === sha &&
      e.subject.outcome === outcome &&
      isComparable(e, wanted),
  );
}

async function parentsOf(cwd: string, sha: string): Promise<string[]> {
  const r = await git(cwd, ["rev-list", "--parents", "-n", "1", sha, "--"]);
  must(r, "git rev-list --parents");
  return r.stdout.trim().split(" ").slice(1);
}

/** Ends a finished assisted bisect, never writing a culprit if the copy could not be restored. */
async function closeAssisted(
  inv: Investigation,
  owned: OwnedSnapshot,
  conclusion: Exclude<Conclusion, { kind: "next" }>,
  state: BisectState,
  opening: boolean,
): Promise<BisectStep> {
  const cwd = owned.path;
  const entry = entryOf(inv, owned);
  const reusedAnswers = [...(entry?.assisted?.reused ?? [])];
  const scenario = entry?.assisted?.scenario;
  const finished = { done: true, worktree: cwd, remainingEstimate: 0, reusedAnswers };
  const bounds = await readBounds(cwd);
  must(await gitStep(cwd, ["bisect", "reset"]), "git bisect reset");
  if (entry) delete entry.assisted;
  await cleanWorktree(owned);
  if (opening) supersedeCulprits(inv, owned.repoId);

  if (conclusion.kind === "undetermined") {
    addEvidence(inv, {
      kind: "attestation",
      summary: `Bisect finished without a culprit: ${conclusion.commits.length} possible commits`,
      source: "bisect_answer",
      data: { possibleCommits: conclusion.commits, reusedAnswers },
      untrusted: false,
    });
    noteUndetermined(inv, owned.repoId, conclusion.commits);
    return { ...finished, possibleCommits: conclusion.commits };
  }

  const culprit = conclusion.sha;
  if (!hasTest(inv, culprit, "bad", scenario)) {
    addBisectNote(inv, owned.repoId, `no culprit, commit ${short(culprit)} was never tested bad`);
    return { ...finished, possibleCommits: [culprit], instruction: ATTEST_BOUND_INSTRUCTION };
  }

  clearBisectNotes(inv, owned.repoId);
  const untestedParents = (await parentsOf(cwd, culprit)).filter((p) => !hasTest(inv, p, "good", scenario));
  if (untestedParents.length > 0) {
    addBisectNote(inv, owned.repoId, `parents never tested, the culprit ${short(culprit)} depends on them: ${untestedParents.map(short).join(", ")}`);
  }
  addEvidence(inv, {
    kind: "attestation",
    summary: `Bisect finished: first bad commit ${short(culprit)}`,
    source: "bisect_answer",
    data: {
      culprit,
      repoId: owned.repoId,
      goodBound: bounds.good,
      badBound: bounds.bad,
      command: null,
      goods: state.goods,
      skips: state.skips,
      parentsTested: untestedParents.length === 0,
      limits: [CLEAN_LIMIT],
      reusedAnswers,
      ...(scenario === undefined ? {} : { scenario }),
    },
    untrusted: false,
    subject: { sha: culprit, outcome: "culprit" },
  });
  return { ...finished, culprit };
}

/** `expectedSha` is the `testSha` shown: an answer only applies to the commit actually tested. */
export async function bisectAnswer(
  inv: Investigation,
  snapshot: Snapshot,
  answer: BisectAnswer,
  expectedSha: string,
  worktreesDir: string = defaultWorktreesDir(),
  persist: Persist = noPersist,
): Promise<BisectStep> {
  const owned = ownedSnapshot(inv, snapshot, worktreesDir);
  const cwd = owned.path;
  if (answer !== "good" && answer !== "bad" && answer !== "skip") {
    throw new Error(`Unknown answer: ${JSON.stringify(answer)}`);
  }
  return exclusive(cwd, async () => {
    await assertLinkedWorktree(cwd);
    const current = await readState(cwd);
    if (!current) throw new Error("No bisect in progress in this working copy");
    if (current.untested.length === 0) throw new Error("This bisect is already finished: bisect_confirm if it awaits a culprit, otherwise bisect_abort");
    assertAtTestCommit(current);
    if (expectedSha !== current.head) {
      throw new Error(`expectedSha ${JSON.stringify(expectedSha)} differs from the commit to test ${current.head}`);
    }
    await assertTrackedClean(cwd);
    await cleanWorktree(owned);

    const sha = current.head;
    const moved = await applyAnswer(cwd, answer, sha);
    const assisted = entryOf(inv, owned)?.assisted;
    const given = addEvidence(inv, {
      kind: "attestation",
      summary: `Bisect: ${short(sha)} declared ${answer}`,
      source: "bisect_answer",
      data: { sha, answer, repoId: owned.repoId, ...(assisted ? { scenario: assisted.scenario } : {}) },
      untrusted: false,
      ...(answer === "skip" ? {} : { subject: { sha, outcome: answer } }),
    });
    assisted?.answerIds.push(given.id);
    return nextAssistedStep(inv, owned, moved, false, persist);
  });
}

/**
 * Writes the culprit held pending by a reuse, under the same conditions as a bisect that concludes on its own, without
 * rebuilding anything. Each reuse must still hold: the user may have changed their mind since it was shown to them.
 */
export async function bisectConfirm(
  inv: Investigation,
  snapshot: Snapshot,
  expectedCulprit: string,
  worktreesDir: string = defaultWorktreesDir(),
): Promise<BisectStep> {
  const owned = ownedSnapshot(inv, snapshot, worktreesDir);
  const cwd = owned.path;
  return exclusive(cwd, async () => {
    await assertLinkedWorktree(cwd);
    const assisted = entryOf(inv, owned)?.assisted;
    const pending = assisted?.pendingCulprit;
    if (!assisted || pending === undefined) throw new Error("No culprit awaiting confirmation in this working copy");
    if (expectedCulprit !== pending) {
      throw new Error(`expectedCulprit ${JSON.stringify(expectedCulprit)} differs from the pending culprit ${pending}`);
    }
    const state = await readState(cwd);
    if (!state || state.untested.length > 0 || state.bad !== pending || state.candidates.length !== 1) {
      throw new Error(`This copy's bisect no longer designates ${pending}: bisect_abort, then redo it`);
    }
    const stale = assisted.reused.filter((a) => priorAnswer(inv, owned.repoId, a.sha, assisted.scenario)?.outcome !== a.outcome);
    if (stale.length > 0) {
      throw new Error(`Reused answers obsolete (${stale.map((a) => short(a.sha)).join(", ")}): bisect_abort, then redo it`);
    }
    await assertTrackedClean(cwd);
    return closeAssisted(inv, owned, { kind: "culprit", sha: pending }, state, true);
  });
}

/** Ends a bisect without concluding anything and removes the answers given to this bisect, except with `keepAnswers`. */
export async function bisectAbort(
  inv: Investigation,
  snapshot: Snapshot,
  worktreesDir: string = defaultWorktreesDir(),
  keepAnswers: boolean = false,
): Promise<BisectStep> {
  const owned = ownedSnapshot(inv, snapshot, worktreesDir);
  const cwd = owned.path;
  return exclusive(cwd, async () => {
    await assertLinkedWorktree(cwd);
    if (!(await readState(cwd))) throw new Error("No bisect in progress in this working copy");
    await hardReset(owned);
    await cleanWorktree(owned);
    must(await gitStep(cwd, ["bisect", "reset"]), "git bisect reset");
    const given = entryOf(inv, owned)?.assisted?.answerIds ?? [];
    if (!keepAnswers) {
      for (const e of inv.evidence) if (given.includes(e.id)) e.superseded = true;
    }
    delete entryOf(inv, owned)?.assisted;
    await cleanWorktree(owned);
    addBisectNote(inv, owned.repoId, "abandoned before its end, no culprit");
    return { done: true, worktree: cwd, remainingEstimate: 0 };
  });
}

interface RunResult {
  exitCode: number | null;
  /** Launch failure, signal or output too long: no usable exit code. */
  failure?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV.has(upper) || SECRET_NAME_RE.test(upper);
}

/** The code under test receives neither the server's credentials nor its caller's git settings. */
function commandEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.has(k.toUpperCase()) && !isSecretName(k)),
  );
}

/** Longest first: a value contained in another leaves no remainder. */
function redact(text: string): string {
  const values = Object.entries(process.env)
    .filter(([k, v]) => isSecretName(k) && v !== undefined && v.length >= MIN_SECRET_LENGTH)
    .map(([, v]) => v as string)
    .concat(sessionSecrets())
    .sort((a, b) => b.length - a.length);
  return values.reduce((out, value) => out.split(value).join(REDACTED), text);
}

/** Kills the descendants too: a surviving grandchild would keep the output open, and the copy busy. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WIN) {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function resultOf(error: ExecFileException | null, stdout: string, stderr: string, timedOut: boolean): RunResult {
  if (!error) return { exitCode: 0, timedOut, stdout, stderr };
  if (typeof error.code === "number" && !error.signal) return { exitCode: error.code, timedOut, stdout, stderr };
  return { exitCode: null, failure: error.signal ? `signal ${error.signal}` : error.message, timedOut, stdout, stderr };
}

/**
 * No shell. On Windows, killing a process gives code 1: for the budget, only `timedOut` says what
 * happened; a stop coming from elsewhere stays indistinguishable, hence the culprit confirmation.
 */
function runCommand(command: string[], cwd: string, limitMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve(result);
    };

    // `detached` creates the process group that killTree targets outside Windows.
    const options = {
      cwd,
      env: commandEnv(),
      windowsHide: true,
      detached: !IS_WIN,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8" as const,
    };
    let child: ChildProcess;
    try {
      child = execFile(command[0]!, command.slice(1), options, (error, stdout, stderr) => {
        settle(resultOf(error, stdout, stderr, timedOut));
      });
    } catch (e) {
      settle({ exitCode: null, failure: (e as Error).message, timedOut, stdout: "", stderr: "" });
      return;
    }
    child.stdin?.end();
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree(child);
        timers.push(
          setTimeout(() => settle({ exitCode: null, failure: "forced stop", timedOut, stdout: "", stderr: "" }), KILL_GRACE_MS),
        );
      }, limitMs),
    );
  });
}

/** Masks before cutting: a secret straddling the limit must not come out half-revealed. The end carries the failure. */
function storedOutput(text: string): string {
  const clean = redact(text);
  return clean.length > OUTPUT_CAP ? `[truncated]\n${clean.slice(-OUTPUT_CAP)}` : clean;
}

function checkAutoInput(command: string[], budgetMs: number, expectedFailure: string | undefined): void {
  const valid = Array.isArray(command) && command.length > 0 && command[0] !== "" && command.every((c) => typeof c === "string");
  if (!valid) throw new Error(`Invalid command: ${redact(JSON.stringify(command) ?? "")}`);
  if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error(`Invalid budget: ${String(budgetMs)}`);
  }
  if (expectedFailure !== undefined && (typeof expectedFailure !== "string" || expectedFailure === "")) {
    throw new Error(`Invalid expectedFailure: ${redact(JSON.stringify(expectedFailure) ?? "")}`);
  }
}

/** 126 and 127 say the command could not run; beyond that, it is no longer a test result. */
function answerOf(result: RunResult, expectedFailure: string | undefined): BisectAnswer | undefined {
  const code = result.exitCode;
  if (result.timedOut || code === null) return undefined;
  if (code === 0) return "good";
  if (code === 125) return "skip";
  if (code < 1 || code > 124) return undefined;
  const seen = expectedFailure === undefined || `${result.stdout}\n${result.stderr}`.includes(expectedFailure);
  return seen ? "bad" : "skip";
}

interface AutoRun {
  inv: Investigation;
  snapshot: OwnedSnapshot;
  cwd: string;
  command: string[];
  expectedFailure: string | undefined;
  /** Masked versions: the only ones allowed into evidence. */
  storedCommand: string[];
  storedExpectedFailure: string | undefined;
  source: string;
  budgetMs: number;
  deadline: number;
  /** Output of the last test of each commit: the culprit keeps the one that shows it broken. */
  outputs: Map<string, { exitCode: number | null; stdout: string; stderr: string }>;
  badBoundExit: number | null;
}

interface Stop {
  stop: string;
  budget: boolean;
}

function stopAuto(run: AutoRun, reason: string, budget = false): Stop {
  addBisectNote(run.inv, run.snapshot.repoId, `automatic stopped, no culprit: ${reason}`);
  return { stop: reason, budget };
}

const budgetReason = (run: AutoRun) => `budget of ${run.budgetMs} ms reached`;

function stopped(run: AutoRun, s: Stop, remainingEstimate = 0): BisectAutoStep {
  return { done: false, worktree: run.cwd, remainingEstimate, stoppedByBudget: s.budget, stopReason: s.stop };
}

/** HEAD and tracked files. The rest is removed by the cleanup; a git that fails stops everything. */
async function workspace(cwd: string): Promise<string> {
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  must(head, "git rev-parse HEAD");
  const status = await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=no"]);
  must(status, "git status");
  return `${head.stdout}\0${status.stdout}`;
}

function addExecution(run: AutoRun, sha: string, result: RunResult, summary: string, outcome?: "good" | "bad"): void {
  addEvidence(run.inv, {
    kind: "execution",
    summary,
    source: run.source,
    data: {
      sha,
      command: run.storedCommand,
      expectedFailure: run.storedExpectedFailure,
      exitCode: result.exitCode,
      stdout: storedOutput(result.stdout),
      stderr: storedOutput(result.stderr),
    },
    untrusted: true,
    ...(outcome ? { subject: { sha, outcome } } : {}),
  });
}

/** Runs the command on the current commit, from a clean copy. A doubtful result stops everything. */
async function testCommit(run: AutoRun, sha: string): Promise<{ answer: BisectAnswer } | Stop> {
  const left = run.deadline - Date.now();
  if (left <= 0) return stopAuto(run, budgetReason(run), true);

  await cleanWorktree(run.snapshot);
  await assertTrackedClean(run.cwd);
  const before = await workspace(run.cwd);
  const result = await runCommand(run.command, run.cwd, left);
  const after = await workspace(run.cwd);
  const answer = answerOf(result, run.expectedFailure);

  let reason: string | undefined;
  if (result.timedOut) reason = budgetReason(run);
  else if (answer === undefined) reason = result.failure ? redact(result.failure) : `exit code ${String(result.exitCode)}`;
  else if (after !== before) reason = `the command modified the working copy at commit ${short(sha)}`;

  if (reason !== undefined || answer === undefined) {
    addExecution(run, sha, result, `Automatic bisect stopped at ${short(sha)}`);
    return stopAuto(run, reason ?? "unusable result", result.timedOut);
  }
  await cleanWorktree(run.snapshot);
  run.outputs.set(sha, {
    exitCode: result.exitCode,
    stdout: storedOutput(result.stdout),
    stderr: storedOutput(result.stderr),
  });
  addExecution(run, sha, result, `Command on ${short(sha)}: code ${String(result.exitCode)}, ${answer}`, answer === "skip" ? undefined : answer);
  return { answer };
}

async function testAt(run: AutoRun, sha: string): Promise<{ answer: BisectAnswer } | Stop> {
  await cleanWorktree(run.snapshot);
  must(await gitStep(run.cwd, ["checkout", "-q", "--detach", sha]), `git checkout ${short(sha)}`);
  return testCommit(run, sha);
}

/**
 * A broken command fails everywhere, and git would then designate the first commit after the good state;
 * a command that passes everywhere, the bad state. Both bounds must therefore be observed.
 */
async function verifyBounds(run: AutoRun, good: string, bad: string): Promise<Stop | null> {
  const bounds: [string, string, "good" | "bad"][] = [
    [bad, "bad", "bad"],
    [good, "good", "good"],
  ];
  for (const [sha, label, expected] of bounds) {
    const tested = await testAt(run, sha);
    if ("stop" in tested) return tested;
    if (tested.answer !== expected) {
      return stopAuto(run, `the ${label} bound ${short(sha)} gives ${tested.answer}: wrong command or bounds`);
    }
  }
  run.badBoundExit = run.outputs.get(bad)?.exitCode ?? null;
  return null;
}

/**
 * Replays each parent from a clean copy, then the culprit. An unstable test, or a failure unrelated
 * to the bug, does not reproduce identically: this is also the remedy for Windows' code 1.
 */
async function confirmCulprit(run: AutoRun, culprit: string): Promise<Stop | null> {
  const fail = (detail: string) => {
    addBisectNote(run.inv, run.snapshot.repoId, `automatic, confirmation of ${short(culprit)} failed, ${detail}`);
    return stopAuto(run, CONFIRMATION_FAILED);
  };
  for (const parent of await parentsOf(run.cwd, culprit)) {
    const tested = await testAt(run, parent);
    if ("stop" in tested) return tested.budget ? tested : fail(`parent ${short(parent)}: ${tested.stop}`);
    if (tested.answer !== "good") return fail(`parent ${short(parent)}: ${tested.answer}`);
  }
  const tested = await testAt(run, culprit);
  if ("stop" in tested) return tested.budget ? tested : fail(tested.stop);
  const exitCode = run.outputs.get(culprit)?.exitCode ?? null;
  if (tested.answer !== "bad") return fail(tested.answer);
  if (exitCode !== run.badBoundExit) {
    return fail(`code ${String(exitCode)} instead of code ${String(run.badBoundExit)} of the bad bound`);
  }
  return null;
}

async function autoLoop(run: AutoRun, good: string, bad: string): Promise<BisectAutoStep> {
  const { inv, cwd, source, storedCommand, storedExpectedFailure } = run;
  await cleanWorktree(run.snapshot);
  let { r, state } = await startBisect(cwd, good, bad);
  conclude(state, r);
  supersedeCulprits(inv, run.snapshot.repoId);
  for (;;) {
    const conclusion = conclude(state, r);
    if (conclusion.kind === "culprit") {
      const stop = await confirmCulprit(run, conclusion.sha);
      if (stop) return stopped(run, stop);
      clearBisectNotes(inv, run.snapshot.repoId);
      addEvidence(inv, {
        kind: "execution",
        summary: `Automatic bisect finished: first bad commit ${short(conclusion.sha)}`,
        source,
        data: {
          culprit: conclusion.sha,
          repoId: run.snapshot.repoId,
          goodBound: good,
          badBound: bad,
          command: storedCommand,
          expectedFailure: storedExpectedFailure,
          goods: state.goods,
          skips: state.skips,
          parentsTested: true,
          limits: [CLEAN_LIMIT, ...(IS_WIN ? [WINDOWS_KILL_LIMIT] : [])],
          ...run.outputs.get(conclusion.sha),
        },
        untrusted: true,
        subject: { sha: conclusion.sha, outcome: "culprit" },
      });
      return { done: true, worktree: cwd, culprit: conclusion.sha, remainingEstimate: 0, stoppedByBudget: false };
    }
    if (conclusion.kind === "undetermined") {
      addEvidence(inv, {
        kind: "execution",
        summary: `Automatic bisect finished without a culprit: ${conclusion.commits.length} possible commits`,
        source,
        data: { possibleCommits: conclusion.commits, command: storedCommand },
        untrusted: true,
      });
      noteUndetermined(inv, run.snapshot.repoId, conclusion.commits);
      return { done: true, worktree: cwd, remainingEstimate: 0, possibleCommits: conclusion.commits, stoppedByBudget: false };
    }
    const tested = await testCommit(run, conclusion.sha);
    if ("stop" in tested) return stopped(run, tested, conclusion.remaining);
    ({ r, state } = await applyAnswer(cwd, tested.answer, conclusion.sha));
  }
}

/** Puts the copy back at its starting commit. Never throws: a result already written must not be lost. */
async function restoreWorktree(snapshot: OwnedSnapshot, origin: string): Promise<string | null> {
  const cwd = snapshot.path;
  try {
    await hardReset(snapshot);
    await cleanWorktree(snapshot);
    if (await readState(cwd)) must(await gitStep(cwd, ["bisect", "reset"]), "git bisect reset");
    must(await gitStep(cwd, ["checkout", "-q", "--detach", origin]), "git checkout");
    await cleanWorktree(snapshot);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function bisectAuto(
  inv: Investigation,
  snapshot: Snapshot,
  good: string,
  bad: string,
  command: string[],
  budgetMs: number,
  expectedFailure?: string,
  worktreesDir: string = defaultWorktreesDir(),
): Promise<BisectAutoStep> {
  const owned = ownedSnapshot(inv, snapshot, worktreesDir);
  const cwd = owned.path;
  checkAutoInput(command, budgetMs, expectedFailure);
  return exclusive(cwd, async () => {
    await assertLinkedWorktree(cwd);
    const range = await resolveRange(cwd, good, bad);
    await assertNoBisect(cwd);
    await assertTrackedClean(cwd);

    const storedCommand = command.map(redact);
    const run: AutoRun = {
      inv,
      snapshot: owned,
      cwd,
      command,
      expectedFailure,
      storedCommand,
      storedExpectedFailure: expectedFailure === undefined ? undefined : redact(expectedFailure),
      source: `automatic bisect: ${storedCommand.join(" ")}`,
      budgetMs,
      deadline: Date.now() + budgetMs,
      outputs: new Map(),
      badBoundExit: null,
    };
    const origin = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    let result: BisectAutoStep;
    try {
      const stop = await verifyBounds(run, range.good, range.bad);
      result = stop ? stopped(run, stop) : await autoLoop(run, range.good, range.bad);
    } catch (e) {
      result = stopped(run, stopAuto(run, redact((e as Error).message)));
    }
    const failure = await restoreWorktree(owned, origin);
    if (failure) addNote(inv, `automatic bisect: restoring the copy failed: ${failure}`);
    return result;
  });
}

/**
 * `tested`: the user tested this commit, good or bad result. Never "culprit": only a finished
 * bisect produces one. `asserted`: a mere statement, with no subject. `repoId` is required only for
 * `tested`, whose sha resolves in the repository.
 */
export async function recordAttestation(inv: Investigation, a: Attestation, repoId?: string): Promise<Evidence> {
  if (typeof a.statement !== "string" || a.statement.trim() === "") throw new Error("Empty statement");
  if (a.kind !== "tested" && a.kind !== "asserted") throw new Error(`Unknown attestation type: ${JSON.stringify(a.kind)}`);
  if (a.intermittent !== undefined && typeof a.intermittent !== "boolean") {
    throw new Error(`intermittent must be a boolean: ${JSON.stringify(a.intermittent)}`);
  }
  if (a.scenario !== undefined) assertScenario(a.scenario);
  const intermittency = a.intermittent === undefined ? {} : { intermittent: a.intermittent };

  let evidence: Omit<Evidence, "id">;
  if (a.kind === "asserted") {
    evidence = {
      kind: "claim",
      summary: `Assertion about version ${a.version}`,
      source: "attestation",
      data: { statement: a.statement, version: a.version, ...intermittency },
      untrusted: true,
    };
  } else {
    if (a.sha === undefined) throw new Error("A tested attestation requires a sha");
    if (a.outcome !== "good" && a.outcome !== "bad") {
      throw new Error(`A tested attestation requires a good or bad result: ${JSON.stringify(a.outcome)}`);
    }
    const repo = inv.repos.find((r) => r.repoId === repoId);
    if (!repo) throw new Error(`Unknown repository: ${String(repoId)}`);
    const sha = await resolveCommit(repo.path, a.sha);
    evidence = {
      kind: "attestation",
      summary: `Tested on version ${a.version}: ${short(sha)} ${a.outcome}`,
      source: "attestation",
      data: {
        statement: a.statement,
        version: a.version,
        sha,
        repoId: repo.repoId,
        ...intermittency,
        ...(a.scenario === undefined ? {} : { scenario: a.scenario }),
      },
      untrusted: true,
      subject: { sha, outcome: a.outcome },
    };
  }

  if (a.intermittent !== undefined) inv.intermittent = a.intermittent;
  return addEvidence(inv, evidence);
}
