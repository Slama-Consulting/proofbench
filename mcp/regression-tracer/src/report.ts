import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { examinedTargets, isAncestor, knownSecrets, readFixReading, resolveFullRef, resolveNamedTarget, scrubGitOutput, type FixReading } from "./fix.js";
import { git } from "./git.js";
import { isInvestigationId, saveInvestigation, type Evidence, type Investigation } from "./investigation.js";
import { closeSnapshots } from "./snapshot.js";
import {
  bisectProofs,
  citedIds,
  hasPairWithoutScenario,
  hasTestOn,
  isComparable,
  isTestOn,
  isStandingCosmetic,
  isTestWithOutcome,
  maybeSameCommit,
  PAIR_SCENARIO_NOTE,
  reliedReusedAnswers,
  REQUIRED_OUTCOME,
  reusedAnswersOf,
  sameCommit,
  scenarioOf,
  scoreVerdict,
  standingCulprits,
  validateVerdict,
  verdictScenario,
  type Candidate,
  type FixLine,
  type FixStatus,
  type Origin,
  type ProposedFix,
  type Score,
  type Verdict,
} from "./verdict.js";

export interface SubmitOptions {
  root?: string;
  worktreesDir?: string;
}

export type SubmitResult =
  | { ok: true; markdownPath: string; jsonPath: string; warnings?: string[] }
  | { ok: false; errors: string[] };

export type FeedbackOutcome = "useful" | "dead_end" | "fixed";

interface Feedback {
  date: string;
  outcome: FeedbackOutcome;
  note?: string;
}

interface GoodState {
  evidenceId: string;
  kind: Evidence["kind"];
  sha?: string;
  /** True unless the test was executed: a word stays a word. */
  unverified: boolean;
  statement?: string;
  summary: string;
}

interface Attestation {
  evidenceId: string;
  statement: string;
  /** Answer from an earlier bisect reused without a new test. */
  reused?: boolean;
}

interface Intermittency {
  evidenceId: string;
  intermittent: boolean;
  statement: string;
}

interface Rejected {
  sha: string;
  reason: string;
}

interface ReportFix extends FixLine {
  testedCommit?: string;
  caveat?: string;
}

/** What the report displays: the Markdown and the JSON both come from this object, already free of secrets. */
interface ReportData {
  investigationId: string;
  repoId: string;
  date: string;
  origin: Origin;
  firstFeatureCommit?: string;
  candidates: Candidate[];
  goodState: GoodState | null;
  attestations: Attestation[];
  /** The user's latest answer to the intermittency question. */
  intermittency: Intermittency | null;
  /** Server caveats about the evidence, displayed at the top. */
  flags: string[];
  scores: { cause: Score; fix: Score | null };
  fixes: ReportFix[];
  proposedFix?: ProposedFix;
  noProposedFixReason?: string;
  observed: string[];
  inferred: string[];
  unknown: string[];
  rejected: Rejected[];
  coverage: { examined: string[]; notExamined: string[] };
  feedback: Feedback[];
}

const FEEDBACK_OUTCOMES: readonly FeedbackOutcome[] = ["useful", "dead_end", "fixed"];
const EXCLUDE_ENTRY = ".proofbench/";
const FEEDBACK_HEADING = "## User feedback";
const NOT_SET = "—";
const NOTHING = "Nothing reported.";
const CODE_FIXED_CAVEAT = "code literally absent, not tested";
const LATER_COMMITS_CAVEAT = "later commits of the target not tested";
const SHALLOW_NOTE = "shallow clone, history truncated: dig deeper before concluding";
const ERROR_NOTES: Record<string, string> = {
  TEST_REQUIRED: PAIR_SCENARIO_NOTE,
  GOOD_STATE_NOT_ANCESTOR: "the good state contains the culprit, or has no common history with it",
  TEST_WITHOUT_CULPRIT: "the tested commit does not contain the culprit: what never had it fixed nothing",
  BUG_NOT_SHOWN:
    "no bad test on a commit that contains a candidate and precedes the tested commit: nothing says there was a bug to fix",
  TEST_NOT_ON_TARGET:
    "the test must be on a commit of the target later than the culprit, and for NOT_FIXED on the tip of the target",
};
/** The refusals that a truncated history can cause on its own. */
const HISTORY_CODES = ["SHA_UNKNOWN", "GOOD_STATE_NOT_ANCESTOR", "GOOD_STATE_NOT_PARENT", "TEST_NOT_ON_TARGET", "TEST_WITHOUT_CULPRIT", "BUG_NOT_SHOWN"];
const SHA_INPUT_RE = /^[0-9a-f]{4,64}$/;
const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}-/;
const REPORT_DATE_LENGTH = "2026-01-01-".length;
const REPORT_TAIL_RE = /^(?:-\d+)?\.(?:md|json)$/;

/** The code reading that each status describing what was read on the target requires. */
const EXPECTED_READING: Partial<Record<FixStatus, boolean>> = {
  FIX_PRESENT_UNTESTED: false,
  NOT_FIXED_ON_READING: true,
};

const LINE_BREAK_RE = /\r\n|[\n\r\v\f\x85\u2028\u2029]/;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
/** Invisible and reading-direction characters: they make the reader see something other than the real text. */
const INVISIBLE_RE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function scrub(text: string): string {
  return scrubGitOutput(text, knownSecrets());
}

/** To be done on the raw text, before any escaping or serialisation: a transformed token is no longer recognised. */
function scrubDeep<T>(value: T): T;
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrubDeep(v)]));
  }
  return value;
}

/**
 * Renders untrusted text on a single line, with no Markdown effect: no heading, column, link or HTML.
 * Bare URLs are broken too: GFM would turn them into links.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(CONTROL_RE, " ")
    .replace(INVISIBLE_RE, "")
    .trim()
    .replace(/[\\`*_[\]<>|~&@]/g, "\\$&")
    .replace(/:\/\//g, "\\://")
    .replace(/(www)\./gi, "$1\\.")
    .replace(/^[#+=-]/, "\\$&")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Keeps the lines of a long text. Each is escaped: none can get out of the quotation. */
function quoted(text: string): string {
  return text
    .split(LINE_BREAK_RE)
    .map((line) => `> ${escapeMarkdown(line)}`.trimEnd())
    .join("\n");
}

function cell(text: string | undefined): string {
  return text === undefined || text.trim() === "" ? NOT_SET : escapeMarkdown(text);
}

function bullets(items: string[], empty: string = NOTHING): string {
  return items.length === 0 ? empty : items.map((item) => `- ${escapeMarkdown(item)}`).join("\n");
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function statementOf(e: Evidence): string | undefined {
  const data = e.data as { statement?: unknown } | null;
  return typeof data?.statement === "string" ? data.statement : undefined;
}

/**
 * Resolves a sha to a commit. Refuses what is not hexadecimal (`HEAD`, `main`) and what git does not resolve
 * to this prefix: the repository is untrusted, a tag can carry the name of a sha.
 */
async function resolveCommit(repo: string, sha: string): Promise<string | null> {
  const wanted = sha.trim().toLowerCase();
  if (!SHA_INPUT_RE.test(wanted)) return null;
  const spec = `${wanted}^{commit}`;
  if ((await git(repo, ["cat-file", "-e", spec])).code !== 0) return null;
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", spec]);
  const full = r.stdout.trim();
  return r.code === 0 && full.startsWith(wanted) ? full : null;
}

async function parentsOf(repo: string, sha: string): Promise<string[] | null> {
  const r = await git(repo, ["rev-list", "--parents", "-n", "1", sha]);
  return r.code === 0 ? r.stdout.trim().split(/\s+/).slice(1) : null;
}

/** A "bad" evidence only counts if all the parents are good: on a merge, the bug may come from the other one. */
function isParentProof(inv: Investigation, parents: string[], good: string): boolean {
  return parents.includes(good) && parents.every((p) => inv.evidence.some((e) => isTestOn(e, p, ["good"])));
}

/** The good state is older, or on another branch. It can neither contain the culprit nor be unrelated to it. */
async function isUnrelatedGoodState(repo: string, good: string, culprit: string): Promise<boolean> {
  if ((await isAncestor(repo, culprit, good)) !== false) return true;
  return (await git(repo, ["merge-base", good, culprit])).code !== 0;
}

/** A bisect culprit is the first bad one: none of its ancestors, above the good state, is. */
async function hasBrokenAncestor(inv: Investigation, repo: string, parents: string[], good: string | null, scenario: string | undefined): Promise<boolean> {
  if (parents.length === 0) return false;
  const r = await git(repo, ["rev-list", ...parents, ...(good ? [`^${good}`] : [])]);
  if (r.code !== 0) return true;
  return r.stdout.split("\n").some((sha) => sha !== "" && hasTestOn(inv, sha, ["bad", "culprit"], scenario));
}

async function regressionErrors(
  inv: Investigation,
  repo: string,
  v: Verdict,
  resolved: Map<string, string | null>,
): Promise<string[]> {
  if (v.origin !== "PROVEN_REGRESSION" && v.origin !== "PROBABLE_REGRESSION") return [];
  const goodSubject = inv.evidence.find((e) => e.id === v.goodStateEvidenceId)?.subject?.sha;
  const good = goodSubject === undefined ? null : (resolved.get(goodSubject) ?? null);

  const scenario = verdictScenario(inv, v);
  const errors: string[] = [];
  if (good && hasTestOn(inv, good, ["bad", "culprit"], scenario)) errors.push("CONTRADICTORY_EVIDENCE");
  for (const c of v.candidates) {
    const culprit = resolved.get(c.sha);
    if (!culprit) continue;
    if (good && (await isUnrelatedGoodState(repo, good, culprit))) errors.push("GOOD_STATE_NOT_ANCESTOR");
    if (v.origin !== "PROVEN_REGRESSION") continue;
    const parents = (await parentsOf(repo, culprit)) ?? [];
    if (parents.some((p) => hasTestOn(inv, p, ["bad", "culprit"], scenario))) errors.push("CONTRADICTORY_EVIDENCE");
    if (bisectProofs(inv, c).length > 0) {
      if (await hasBrokenAncestor(inv, repo, parents, good, scenario)) errors.push("CONTRADICTORY_EVIDENCE");
    } else if (good && !isParentProof(inv, parents, good)) {
      errors.push("GOOD_STATE_NOT_PARENT");
    } else if (good && !parents.every((p) => inv.evidence.some((e) => isTestOn(e, p, ["good"]) && scenarioOf(e) === scenario))) {
      // On a merge, each parent must be good in the scenario of the bad test.
      errors.push("TEST_REQUIRED");
    }
  }
  return errors;
}

/**
 * A test says nothing about a target unless it is on a commit of that target, later than the culprit.
 * "Still broken" is read at the tip: an older commit does not say the bug is still there.
 */
async function isOnTarget(repo: string, line: FixLine, tested: string, tip: string, culprits: string[]): Promise<boolean> {
  if (line.status === "NOT_FIXED") return tested === tip;
  if (!(await isAncestor(repo, tested, tip))) return false;
  for (const culprit of culprits) {
    if ((await isAncestor(repo, tested, culprit)) !== false) return false;
  }
  return true;
}

async function containsAll(repo: string, sha: string, culprits: string[]): Promise<boolean> {
  for (const culprit of culprits) {
    if ((await isAncestor(repo, culprit, sha)) !== true) return false;
  }
  return true;
}

/**
 * True if a non-replaced test saw the bug before `tested`, on a commit that contains a candidate. One is enough:
 * the bug was seen, and the tested commit already contains all the candidates. The tested commit itself does not count: the
 * case that still fails there, in a partial fix, does not say the other case failed before.
 */
async function isBugShownBefore(inv: Investigation, repo: string, tested: string, culprits: string[], scenario: string | undefined): Promise<boolean> {
  for (const culprit of culprits) {
    const r = await git(repo, ["rev-list", "--ancestry-path", `${culprit}..${tested}`]);
    if (r.code !== 0) continue;
    const shown = [culprit, ...r.stdout.split("\n")].filter((sha) => sha !== "" && sha !== tested);
    if (shown.some((sha) => inv.evidence.some((e) => !e.superseded && isTestOn(e, sha, ["bad", "culprit"]) && isComparable(e, scenario)))) return true;
  }
  return false;
}

/**
 * The tested commits of a line, with the expected result. `onTarget`: those that count for the target. `contained`:
 * those that contain the culprit, because what never had it fixed nothing; with several candidates all of them
 * are required, since we do not know which is the right one. `proofs`: those that prove the line, where a fix presupposes the bug was seen before.
 */
async function testsOnTarget(
  inv: Investigation,
  repo: string,
  v: Verdict,
  line: FixLine,
  tip: string,
  resolved: Map<string, string | null>,
): Promise<{ tested: string[]; onTarget: string[]; contained: string[]; proofs: string[] }> {
  const outcome = REQUIRED_OUTCOME[line.status] ?? "";
  const culprits = v.candidates.flatMap((c) => resolved.get(c.sha) ?? []);
  const scenario = verdictScenario(inv, v);
  const citedTests = inv.evidence.filter((e) => line.evidenceIds.includes(e.id) && isTestWithOutcome(e, [outcome]));
  const shasOf = (tests: Evidence[]) => tests.flatMap((e) => resolved.get(e.subject?.sha ?? "") ?? []);
  const tested = shasOf(citedTests);
  // A test of another scenario did not look at this bug: it proves nothing about it.
  const sameBug = shasOf(citedTests.filter((e) => isComparable(e, scenario)));
  const onTarget: string[] = [];
  const contained: string[] = [];
  const proofs: string[] = [];
  for (const sha of tested) {
    if (!(await isOnTarget(repo, line, sha, tip, culprits))) continue;
    onTarget.push(sha);
    if (line.status === "NOT_FIXED") {
      contained.push(sha);
      if (sameBug.includes(sha)) proofs.push(sha);
    } else if (await containsAll(repo, sha, culprits)) {
      contained.push(sha);
      if (sameBug.includes(sha) && (await isBugShownBefore(inv, repo, sha, culprits, scenario))) proofs.push(sha);
    }
  }
  return { tested, onTarget, contained, proofs };
}

/**
 * A bad test on a commit that descends from the fix contradicts it. `--ancestry-path` rules out a branch
 * merged later, which never had the fix: seeing the bug there says nothing about it.
 */
async function isBrokenAfter(inv: Investigation, repo: string, tested: string, tip: string, scenario: string | undefined): Promise<boolean> {
  const r = await git(repo, ["rev-list", "--ancestry-path", `${tested}..${tip}`]);
  if (r.code !== 0) return true;
  return r.stdout.split("\n").some((sha) => sha !== "" && hasTestOn(inv, sha, ["bad", "culprit"], scenario));
}

/** Two lines for one reference, or two different verdicts for the same commit. */
async function duplicateTargetErrors(repo: string, v: Verdict): Promise<string[]> {
  const rows: { sha: string; ref: string; status: FixStatus }[] = [];
  for (const line of v.fixes) {
    // The bare reference: `HEAD`, refused as a target, must not nonetheless hide a duplicate of its branch.
    const target = await resolveFullRef(repo, line.target);
    if ("sha" in target) rows.push({ ...target, status: line.status });
  }
  const clash = rows.some((a, i) =>
    rows.slice(i + 1).some((b) => a.sha === b.sha && (a.ref === b.ref || a.status !== b.status)),
  );
  return clash ? ["DUPLICATE_TARGET"] : [];
}

async function targetErrors(
  inv: Investigation,
  repo: string,
  v: Verdict,
  resolved: Map<string, string | null>,
): Promise<string[]> {
  const errors = await duplicateTargetErrors(repo, v);
  const scenario = verdictScenario(inv, v);
  for (const line of v.fixes) {
    const outcome = REQUIRED_OUTCOME[line.status];
    if (outcome === undefined) continue;
    // Without a candidate, nothing says a good test follows a bug.
    if (outcome === "good" && v.candidates.length === 0) {
      errors.push("EVIDENCE_REQUIRED");
      continue;
    }
    const target = await resolveNamedTarget(repo, line.target);
    if (!("sha" in target)) {
      errors.push("TARGET_UNKNOWN");
      continue;
    }
    const { tested, onTarget, contained, proofs } = await testsOnTarget(inv, repo, v, line, target.sha, resolved);
    if (tested.length === 0) continue;
    if (onTarget.length === 0) errors.push("TEST_NOT_ON_TARGET");
    else if (contained.length === 0) errors.push("TEST_WITHOUT_CULPRIT");
    else if (proofs.length === 0) errors.push("BUG_NOT_SHOWN");
    if (line.status === "PARTIALLY_FIXED") continue;
    const opposite = outcome === "good" ? ["bad", "culprit"] : ["good"];
    if (contained.some((sha) => hasTestOn(inv, sha, opposite, scenario))) errors.push("CONTRADICTORY_EVIDENCE");
    if (line.status === "FULLY_FIXED" && proofs.length > 0) {
      const broken: boolean[] = [];
      for (const sha of proofs) broken.push(await isBrokenAfter(inv, repo, sha, target.sha, scenario));
      if (broken.every(Boolean)) errors.push("CONTRADICTORY_EVIDENCE");
    }
  }
  return errors;
}

async function explainErrors(repo: string, codes: string[]): Promise<string[]> {
  const shallow =
    codes.some((c) => HISTORY_CODES.includes(c)) &&
    (await git(repo, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
  return codes.map((code) => {
    const notes = [ERROR_NOTES[code], shallow && HISTORY_CODES.includes(code) ? SHALLOW_NOTE : undefined].filter(Boolean);
    return notes.length > 0 ? `${code}: ${notes.join("; ")}` : code;
  });
}

/** Resolves all the shas that the verdict names or cites. */
async function resolveVerdictShas(inv: Investigation, repo: string, v: Verdict): Promise<Map<string, string | null>> {
  const subjects = citedIds(v).flatMap((id) => {
    const sha = inv.evidence.find((e) => e.id === id)?.subject?.sha;
    return sha === undefined ? [] : [sha];
  });
  const named = v.firstFeatureCommit === undefined ? [] : [v.firstFeatureCommit];
  const resolved = new Map<string, string | null>();
  for (const sha of new Set([...v.candidates.map((c) => c.sha), ...named, ...subjects])) {
    resolved.set(sha, await resolveCommit(repo, sha));
  }
  return resolved;
}

/** Checks in the repository what `validateVerdict` cannot see. What git does not confirm is refused. */
export async function gitVerdictErrors(inv: Investigation, repo: string, v: Verdict): Promise<string[]> {
  const resolved = await resolveVerdictShas(inv, repo, v);
  const errors = [
    ...([...resolved.values()].includes(null) ? ["SHA_UNKNOWN"] : []),
    ...(await regressionErrors(inv, repo, v, resolved)),
    ...(await targetErrors(inv, repo, v, resolved)),
  ];
  return explainErrors(repo, [...new Set(errors)]);
}

/** A cited reading gives way to the most recent one of the same question: the code may have moved since. */
function currentReadings(inv: Investigation, repoId: string, line: FixLine): FixReading[] {
  const all = inv.evidence.flatMap((e) => {
    const reading = readFixReading(e);
    return reading?.repoId === repoId ? [{ id: e.id, reading }] : [];
  });
  const latest = (r: FixReading) =>
    all.filter(({ reading: o }) => o.target === r.target && o.file === r.file && o.snippet === r.snippet).at(-1)!.reading;
  return all
    .filter(({ id, reading }) => line.evidenceIds.includes(id) && reading.target === line.target)
    .map(({ reading }) => latest(reading));
}

/** Code absent from a target without the culprit was never there: nothing was fixed. */
function lacksCulprit(v: Verdict, r: FixReading): boolean {
  if (r.faultyCodePresent !== false) return false;
  if (r.containsCulprit === false) return true;
  const regression = v.origin === "PROVEN_REGRESSION" || v.origin === "PROBABLE_REGRESSION";
  if (r.containsCulprit === undefined && regression) return true;
  const { culprit } = r;
  return culprit !== undefined && v.candidates.length > 0 && !v.candidates.some((c) => sameCommit(c.sha, culprit));
}

/** Confronts each fix line with what `check_fix` actually read. */
function fixReadingErrors(inv: Investigation, repoId: string, v: Verdict): string[] {
  const examined = examinedTargets(inv, repoId);
  return v.fixes.flatMap((line) => {
    if (line.status === "NO_FIX_FOUND") {
      return examined.includes(line.target) ? [] : ["COVERAGE_TARGET_MISSING"];
    }
    const expected = EXPECTED_READING[line.status];
    if (expected === undefined) return [];
    const readings = currentReadings(inv, repoId, line);
    const present = readings.map((r) => r.faultyCodePresent);
    if (!present.includes(expected) || present.includes(!expected)) return ["TEST_REQUIRED"];
    return line.status === "FIX_PRESENT_UNTESTED" && readings.some((r) => lacksCulprit(v, r)) ? ["TARGET_WITHOUT_CULPRIT"] : [];
  });
}

function bisectRepoOf(e: Evidence): unknown {
  return (e.data as { repoId?: unknown } | null)?.repoId;
}

/** The bisect that proves must have run on the verdict's repository. */
function bisectRepoErrors(inv: Investigation, repoId: string, v: Verdict): string[] {
  if (v.origin !== "PROVEN_REGRESSION") return [];
  const elsewhere = v.candidates.some((c) => {
    const proofs = bisectProofs(inv, c);
    return proofs.length > 0 && proofs.every((e) => typeof bisectRepoOf(e) === "string" && bisectRepoOf(e) !== repoId);
  });
  return elsewhere ? ["BISECT_OTHER_REPO"] : [];
}

function buildGoodState(inv: Investigation, v: Verdict): GoodState | null {
  const e = inv.evidence.find((x) => x.id === v.goodStateEvidenceId);
  if (!e) return null;
  const statement = statementOf(e);
  return {
    evidenceId: e.id,
    kind: e.kind,
    ...(e.subject ? { sha: e.subject.sha } : {}),
    unverified: e.kind !== "execution",
    ...(statement === undefined ? {} : { statement }),
    summary: e.summary,
  };
}

/** The evidence that the bisect actually reused, as it noted it. */
function reusedAttestationIds(inv: Investigation, v: Verdict): string[] {
  return reliedReusedAnswers(inv, v).map((a) => a.evidenceId);
}

/**
 * Uncited attestations the proof depends on: the answers reused by the bisect, and the culprit's parents
 * without an executed test. Only one per parent, the most recent: an answer given again to a redone bisect replaces that
 * of the earlier bisect.
 */
async function reliedAttestationIds(inv: Investigation, repo: string, v: Verdict): Promise<string[]> {
  const ids = reusedAttestationIds(inv, v);
  if (v.origin !== "PROVEN_REGRESSION") return ids;
  for (const c of v.candidates) {
    const sha = await resolveCommit(repo, c.sha);
    for (const parent of (sha && (await parentsOf(repo, sha))) || []) {
      const tests = inv.evidence.filter((e) => !e.superseded && isTestOn(e, parent, ["good"]));
      const latest = tests.at(-1);
      if (latest && !tests.some((e) => e.kind === "execution")) ids.push(latest.id);
    }
  }
  return ids;
}

function buildAttestations(inv: Investigation, v: Verdict, relied: string[]): Attestation[] {
  const used = new Set([...citedIds(v), ...relied].filter((id) => id !== v.goodStateEvidenceId));
  const reused = reusedAttestationIds(inv, v);
  return inv.evidence
    .filter((e) => used.has(e.id) && e.kind === "attestation" && !e.superseded)
    .map((e) => ({ evidenceId: e.id, statement: statementOf(e) ?? e.summary, ...(reused.includes(e.id) ? { reused: true } : {}) }));
}

function buildIntermittency(inv: Investigation): Intermittency | null {
  const e = inv.evidence.filter((x) => typeof (x.data as { intermittent?: unknown } | null)?.intermittent === "boolean").at(-1);
  if (!e) return null;
  return { evidenceId: e.id, intermittent: (e.data as { intermittent: boolean }).intermittent, statement: statementOf(e) ?? e.summary };
}

/** Caveats about what the culprit depends on, whatever the origin: nobody retested it. */
function reuseFlags(inv: Investigation, v: Verdict): string[] {
  const reused = reliedReusedAnswers(inv, v);
  const flags = reused.length === 0 ? [] : [`Answers reused from a previous bisect, without a new test: ${reused.map((a) => a.sha).join(", ")}`];
  for (const proof of standingCulprits(inv, v)) {
    const data = proof.data as { badBound?: unknown; parentsTested?: unknown; command?: unknown };
    // An assisted bisect finished on its bad bound: no tested commit showed the bug.
    if (data.command === null && typeof data.badBound === "string" && sameCommit(proof.subject?.sha ?? "", data.badBound)) {
      flags.push("all tested commits good: check that the scenario really reproduces the bug");
    }
    if (data.parentsTested === false && reusedAnswersOf(proof).length > 0) {
      flags.push("Culprit closed on reused answers without a test of its parents: retest before concluding");
    }
  }
  return [...new Set(flags)];
}

/** Tests ruled out because they carry another scenario: a failed reproduction stays visible. */
function otherScenarioFlags(inv: Investigation, v: Verdict): string[] {
  const scenario = verdictScenario(inv, v);
  if (scenario === undefined) return [];
  const groups = new Map<string, { text: string; tests: string[] }>();
  for (const e of inv.evidence) {
    const own = scenarioOf(e);
    if (own === undefined || own === scenario || !isTestWithOutcome(e, ["good", "bad"])) continue;
    const group = groups.get(own) ?? { text: (e.data as { scenario: string }).scenario, tests: [] };
    group.tests.push(`${e.subject?.sha} ${e.subject?.outcome}`);
    groups.set(own, group);
  }
  return [...groups.values()].map((g) => `Tests from another scenario, ignored ("${g.text}"): ${g.tests.join(", ")}`);
}

/** Caveats about a culprit designated by bisect: what the bisect actually verified. */
function buildFlags(inv: Investigation, v: Verdict): string[] {
  return [...proofFlags(inv, v), ...reuseFlags(inv, v), ...otherScenarioFlags(inv, v)];
}

function proofFlags(inv: Investigation, v: Verdict): string[] {
  if (v.origin !== "PROVEN_REGRESSION") return [];
  const good = inv.evidence.find((e) => e.id === v.goodStateEvidenceId)?.subject?.sha;
  return v.candidates.flatMap((c) => {
    const proof = bisectProofs(inv, c)[0];
    if (!proof) return [];
    const data = proof.data as { goodBound?: unknown; parentsTested?: unknown } | null;
    const bound = data?.goodBound;
    const flags: string[] = [];
    if (typeof bound !== "string" || good === undefined || !sameCommit(good, bound)) {
      const shown = typeof bound === "string" ? bound : "unknown";
      flags.push(`Bisect good bound not verified: the cited good state is not the bound ${shown}`);
    }
    if (data?.parentsTested === false) flags.push("Bisect: parents of the culprit never tested");
    return flags;
  });
}

function rejectionReason(inv: Investigation, e: Evidence): string | undefined {
  if (e.subject?.outcome === "cosmetic") return isStandingCosmetic(inv, e) ? "classified cosmetic" : undefined;
  // A withdrawn answer was never a candidate, only a replaced culprit is one.
  return e.subject?.outcome === "culprit" && e.superseded ? "bisect replaced by a more recent bisect" : undefined;
}

/** Candidates abandoned during the investigation. Neither the good state nor the good steps of a bisect are among them. */
function buildRejected(inv: Investigation, v: Verdict): Rejected[] {
  const goodState = inv.evidence.find((e) => e.id === v.goodStateEvidenceId)?.subject?.sha ?? "";
  const found = new Map<string, Rejected>();
  for (const e of inv.evidence) {
    const reason = rejectionReason(inv, e);
    const sha = e.subject?.sha;
    if (reason === undefined || sha === undefined) continue;
    if (maybeSameCommit(goodState, sha) || v.candidates.some((c) => maybeSameCommit(c.sha, sha))) continue;
    found.set(`${sha} ${reason}`, { sha, reason });
  }
  return [...found.values()];
}

/** The most recent by history: `--topo-order` never outputs a parent before its children. */
async function newestCommit(repo: string, shas: string[]): Promise<string | undefined> {
  if (shas.length === 0) return undefined;
  const r = await git(repo, ["rev-list", "--topo-order", "--max-count=1", ...shas]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Adds to each line what it actually tested: a commit of the target is not its tip. */
async function buildFixes(inv: Investigation, repo: string, v: Verdict): Promise<ReportFix[]> {
  const resolved = await resolveVerdictShas(inv, repo, v);
  const fixes: ReportFix[] = [];
  for (const line of v.fixes) {
    if (line.status === "FIX_PRESENT_UNTESTED") {
      fixes.push({ ...line, caveat: CODE_FIXED_CAVEAT });
      continue;
    }
    const target = REQUIRED_OUTCOME[line.status] === undefined ? null : await resolveNamedTarget(repo, line.target);
    if (!target || !("sha" in target)) {
      fixes.push(line);
      continue;
    }
    const { proofs } = await testsOnTarget(inv, repo, v, line, target.sha, resolved);
    const testedCommit = await newestCommit(repo, proofs);
    fixes.push({
      ...line,
      ...(testedCommit === undefined ? {} : { testedCommit }),
      ...(testedCommit === target.sha ? {} : { caveat: LATER_COMMITS_CAVEAT }),
    });
  }
  return fixes;
}

function buildReport(
  inv: Investigation,
  repoId: string,
  v: Verdict,
  date: string,
  relied: string[],
  fixes: ReportFix[],
  feedback: Feedback[],
): ReportData {
  return scrubDeep<ReportData>({
    investigationId: inv.id,
    repoId,
    date,
    origin: v.origin,
    ...(v.firstFeatureCommit === undefined ? {} : { firstFeatureCommit: v.firstFeatureCommit }),
    candidates: v.candidates,
    goodState: buildGoodState(inv, v),
    attestations: buildAttestations(inv, v, relied),
    intermittency: buildIntermittency(inv),
    flags: buildFlags(inv, v),
    scores: scoreVerdict(inv, v),
    fixes,
    ...(v.proposedFix ? { proposedFix: v.proposedFix } : { noProposedFixReason: v.noProposedFixReason }),
    observed: v.observed,
    inferred: v.inferred,
    unknown: v.unknown,
    rejected: buildRejected(inv, v),
    coverage: {
      examined: inv.coverage.examined,
      notExamined: [...inv.coverage.notExamined, ...inv.repos.flatMap((r) => r.misses)],
    },
    feedback,
  });
}

function renderFeedback(f: Feedback): string {
  const note = f.note === undefined ? "" : `: ${escapeMarkdown(f.note)}`;
  return `- ${escapeMarkdown(f.date)}, ${escapeMarkdown(f.outcome)}${note}`;
}

function renderCandidates(r: ReportData): string {
  const title = r.origin === "PROVEN_REGRESSION" ? "Proven commit" : "Candidates";
  if (r.candidates.length === 0) return `**${title}:** none`;
  const rows = r.candidates.map((c) => [c.sha, c.mr, c.ticket, c.branch, c.date, c.evidenceIds.join(", ")].map(cell));
  return `**${title}**\n\n${table(["Commit", "MR", "Ticket", "Branch", "Date", "Evidence"], rows)}`;
}

function renderGoodState(r: ReportData): string {
  const g = r.goodState;
  if (!g) return "**Good state:** none identified";
  const sha = g.sha === undefined ? "" : `, commit ${escapeMarkdown(g.sha)}`;
  if (!g.unverified) return `**Good state:** ${g.evidenceId}${sha}, tested by execution`;
  const said =
    g.statement === undefined
      ? `summary: "${escapeMarkdown(g.summary)}"`
      : `user's statement: "${escapeMarkdown(g.statement)}"`;
  return `**Good state: unverified assertion** (${g.evidenceId}${sha}), ${said}`;
}

function renderAttestation(a: Attestation): string {
  const title = a.reused ? "User attestation, not executed, answer reused without a new test" : "User attestation, not executed";
  return `**${title}** (${a.evidenceId}): "${escapeMarkdown(a.statement)}"`;
}

function renderIntermittency(i: Intermittency | null): string {
  if (!i) return "**Intermittency:** the user did not answer";
  const answer = i.intermittent ? "intermittent" : "not intermittent";
  return `**Intermittency, user's word** (${i.evidenceId}, ${answer}): "${escapeMarkdown(i.statement)}"`;
}

function renderScore(title: string, score: Score | null): string {
  if (!score) return `**${title}: not applicable**, no fix proposed`;
  const lines = score.breakdown.map((b) => `- ${escapeMarkdown(b.label)}: ${b.points >= 0 ? "+" : ""}${b.points}`);
  return [`**${title}: ${score.value}/100**`, "", ...lines].join("\n");
}

function renderFixes(r: ReportData): string {
  if (r.fixes.length === 0) return "**Fixes by target:** no target evaluated";
  const rows = r.fixes.map((f) => {
    const [target, ...rest] = [f.target, f.testedCommit, f.mr, f.ticket, f.branch, f.failingCase, f.evidenceIds.join(", "), f.caveat].map(cell);
    return [target!, f.status, ...rest];
  });
  return `**Fixes by target**\n\n${table(["Target", "Status", "Tested commit", "MR", "Ticket", "Branch", "Failing case", "Evidence", "Caveat"], rows)}`;
}

function renderProposedFix(r: ReportData): string {
  const fix = r.proposedFix;
  if (!fix) return `No fix proposed. Reason:\n\n${quoted(r.noProposedFixReason ?? "")}`;
  const test = fix.regressionTestEvidenceId;
  return [
    `Files:\n\n${bullets(fix.files)}`,
    `Change:\n\n${quoted(fix.change)}`,
    `Explanation:\n\n${quoted(fix.explanation)}`,
    ...(test === undefined ? [] : [`Non-regression test: ${cell(test)}`]),
    `Evidence: ${cell(fix.evidenceIds.join(", "))}`,
  ].join("\n\n");
}

function renderMarkdown(r: ReportData): string {
  const first = r.firstFeatureCommit;
  return `${[
    `# Origin verdict: ${r.origin}`,
    `Investigation ${r.investigationId}, repository ${escapeMarkdown(r.repoId)}, ${r.date}`,
    ...(first === undefined ? [] : [`**First commit of the feature:** ${escapeMarkdown(first)}`]),
    renderCandidates(r),
    renderGoodState(r),
    ...r.flags.map((flag) => `**Caveat:** ${escapeMarkdown(flag)}`),
    renderIntermittency(r.intermittency),
    ...r.attestations.map(renderAttestation),
    renderScore("Confidence in the cause", r.scores.cause),
    renderScore("Confidence in the proposed fix", r.scores.fix),
    renderFixes(r),
    `## Proposed fix\n\n${renderProposedFix(r)}`,
    `## Observed\n\n${bullets(r.observed)}`,
    `## Inferred\n\n${bullets(r.inferred)}`,
    `## Unknown\n\n${bullets(r.unknown)}`,
    `## Rejected candidates\n\n${bullets(r.rejected.map((c) => `${c.sha}: ${c.reason}`))}`,
    `## Coverage\n\n**Examined**\n\n${bullets(r.coverage.examined)}\n\n**Not examined**\n\n${bullets(r.coverage.notExamined)}`,
    ...(r.feedback.length > 0 ? [`${FEEDBACK_HEADING}\n\n${r.feedback.map(renderFeedback).join("\n")}`] : []),
  ].join("\n\n")}\n`;
}

/** True as long as nothing in `.proofbench/reports` is a link or anything other than a folder. Nothing is created here. */
function isSafeReportsDir(repo: string): boolean {
  let current = repo;
  for (const part of [".proofbench", "reports"]) {
    current = join(current, part);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) return true;
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/** Adds the entry only once, by simple appending: no other line is rewritten. */
async function excludeProofbench(repo: string): Promise<void> {
  const r = await git(repo, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) throw new Error(`Exclude file not found: ${r.stderr.trim()}`);
  const file = resolve(repo, r.stdout.trim());
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${EXCLUDE_ENTRY}\n`, "utf8");
}

/** The rename replaces any link placed at that spot instead of following it. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  renameSync(tmp, file);
}

function reportsDir(repo: string): string {
  return join(repo, ".proofbench", "reports");
}

/** `<date>-<id>.md`, or `<date>-<id>-2.md` when an unreadable JSON keeps the first name. */
function isReportOf(name: string, id: string): boolean {
  const rest = name.slice(REPORT_DATE_LENGTH);
  return REPORT_DATE_RE.test(name) && rest.startsWith(id) && REPORT_TAIL_RE.test(rest.slice(id.length));
}

/** The report files of this investigation, whatever their day. */
function reportFilesOf(dir: string, id: string): string[] {
  if (!lstatSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).filter((name) => isReportOf(name, id));
}

function isFeedback(value: unknown): value is Feedback {
  const f = value as Partial<Feedback> | null;
  return (
    typeof f === "object" &&
    f !== null &&
    typeof f.date === "string" &&
    FEEDBACK_OUTCOMES.includes(f.outcome as FeedbackOutcome) &&
    (f.note === undefined || typeof f.note === "string")
  );
}

/** `null` except for a report whose feedback entries can all be re-read: the rest must not be replaced. */
function readFeedback(file: string): Feedback[] | null {
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as { feedback?: unknown } | null;
    return Array.isArray(report?.feedback) && report.feedback.every(isFeedback) ? report.feedback : null;
  } catch {
    return null;
  }
}

/** Takes over the feedback of previous reports. An unreadable file does not block the verdict: it is flagged. */
function priorFeedback(dir: string, names: string[]): { feedback: Feedback[]; unreadable: string[] } {
  const feedback: Feedback[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = join(dir, name);
    if (!lstatSync(file).isFile()) continue;
    const read = readFeedback(file);
    if (read) feedback.push(...read);
    else unreadable.push(name);
  }
  return { feedback, unreadable };
}

/** The first free name: an unreadable JSON keeps its own, a readable report replaces itself. */
function reportStem(base: string, unreadable: string[]): string {
  let stem = base;
  for (let n = 2; unreadable.includes(`${stem}.json`); n++) stem = `${base}-${n}`;
  return stem;
}

function writeReport(dir: string, name: string, r: ReportData): { markdownPath: string; jsonPath: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${name}.json`);
  const markdownPath = join(dir, `${name}.md`);
  writeAtomic(jsonPath, `${JSON.stringify(r, null, 2)}\n`);
  writeAtomic(markdownPath, renderMarkdown(r));
  return { markdownPath, jsonPath };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function messageOf(e: unknown): string {
  return scrub(e instanceof Error ? e.message : String(e));
}

/**
 * Last filter before the verdict reaches the user. A refusal leaves the repository, the working copies and
 * the investigation as they are. Once the report is written, nothing undoes it: a failure becomes a warning.
 */
export async function submitVerdict(
  inv: Investigation,
  repoId: string,
  v: Verdict,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const valid = validateVerdict(inv, v);
  if (!valid.ok) {
    if (!hasPairWithoutScenario(inv, v)) return valid;
    return { ok: false, errors: valid.errors.map((e) => (e === "TEST_REQUIRED" ? `TEST_REQUIRED: ${PAIR_SCENARIO_NOTE}` : e)) };
  }
  const repo = inv.repos.find((r) => r.repoId === repoId);
  if (!repo) return { ok: false, errors: ["REPO_UNKNOWN"] };

  const errors = [
    ...(await gitVerdictErrors(inv, repo.path, v)),
    ...fixReadingErrors(inv, repoId, v),
    ...bisectRepoErrors(inv, repoId, v),
  ];
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  if (!isInvestigationId(inv.id)) return { ok: false, errors: ["INVESTIGATION_ID_INVALID"] };
  if (!isSafeReportsDir(repo.path)) return { ok: false, errors: ["PROOFBENCH_UNSAFE"] };

  const relied = await reliedAttestationIds(inv, repo.path, v);
  const fixes = await buildFixes(inv, repo.path, v);
  const dir = reportsDir(repo.path);
  const warnings: string[] = [];
  const date = today();
  let replaced: string[];
  let paths: { markdownPath: string; jsonPath: string };
  try {
    await excludeProofbench(repo.path);
    const earlier = reportFilesOf(dir, inv.id);
    const { feedback, unreadable } = priorFeedback(dir, earlier);
    // Unreadable does not mean empty: this JSON may hold feedback, and its .md may be the only readable copy.
    const kept = unreadable.flatMap((name) => [name, name.replace(/\.json$/, ".md")]).filter((name) => earlier.includes(name));
    replaced = earlier.filter((name) => !kept.includes(name));
    paths = writeReport(dir, reportStem(`${date}-${inv.id}`, unreadable), buildReport(inv, repoId, v, date, relied, fixes, feedback));
    if (kept.length > 0) {
      const written = `${basename(paths.markdownPath)}, ${basename(paths.jsonPath)}`;
      warnings.push(`Previous feedback unreadable, not carried into this report. Kept as is: ${kept.join(", ")}. New report: ${written}`);
    }
  } catch (e) {
    return { ok: false, errors: [`REPORT_WRITE_FAILED: ${messageOf(e)}`] };
  }

  // One investigation, one report: that of another day goes only once the new one is written.
  const current = [basename(paths.markdownPath), basename(paths.jsonPath)];
  for (const name of replaced.filter((n) => !current.includes(n))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch (e) {
      warnings.push(`Old report not deleted: ${messageOf(e)}`);
    }
  }

  try {
    await closeSnapshots(inv, opts.worktreesDir);
  } catch (e) {
    warnings.push(messageOf(e));
  }
  try {
    saveInvestigation(inv, opts.root);
  } catch (e) {
    warnings.push(`Investigation not saved: ${messageOf(e)}`);
  }
  return { ok: true, ...paths, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** The report of this investigation, in the `.proofbench/reports` of one of its repositories, or nothing. */
function locateReport(inv: Investigation, reportPath: string): string | null {
  const file = resolve(reportPath);
  const name = basename(file);
  if (!name.endsWith(".md") || !isReportOf(name, inv.id)) return null;
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  for (const repo of inv.repos) {
    const dir = reportsDir(repo.path);
    if (!isSafeReportsDir(repo.path) || !lstatSync(dir, { throwIfNoEntry: false })) continue;
    if (relative(realpathSync(dir), realpathSync(file)) === name) return file;
  }
  return null;
}

/** Adds the user's feedback to the report and its JSON. The report body is not rewritten. */
export async function recordFeedback(
  inv: Investigation,
  reportPath: string,
  outcome: FeedbackOutcome,
  note?: string,
): Promise<void> {
  if (!FEEDBACK_OUTCOMES.includes(outcome)) throw new Error(`Unknown feedback: ${JSON.stringify(outcome)}`);
  const file = locateReport(inv, reportPath);
  if (!file) throw new Error(`Report refused (outside .proofbench/reports of the investigation): ${JSON.stringify(scrub(String(reportPath)))}`);

  const feedback = scrubDeep<Feedback>({ date: today(), outcome, ...(note === undefined ? {} : { note }) });
  const jsonPath = file.replace(/\.md$/, ".json");
  const json = lstatSync(jsonPath, { throwIfNoEntry: false });
  if (json && !json.isFile()) throw new Error(`Report refused (linked or invalid JSON): ${JSON.stringify(scrub(jsonPath))}`);
  if (json) {
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as ReportData;
    report.feedback = [...report.feedback, feedback];
    writeAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const heading = lines.includes(FEEDBACK_HEADING) ? "" : `\n${FEEDBACK_HEADING}\n\n`;
  appendFileSync(file, `${heading}${renderFeedback(feedback)}\n`, "utf8");
}
