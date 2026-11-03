import type { Evidence, EvidenceKind, Investigation, ReusedAnswer } from "./investigation.js";

export const ORIGINS = [
  "PROVEN_REGRESSION",
  "PROBABLE_REGRESSION",
  "ORIGINAL_DEFECT",
  "INDETERMINATE",
] as const;
export type Origin = (typeof ORIGINS)[number];

export const FIX_STATUSES = [
  "FULLY_FIXED",
  "PARTIALLY_FIXED",
  "FIX_PRESENT_UNTESTED",
  "FIX_ANNOUNCED",
  "NOT_FIXED",
  "NOT_FIXED_ON_READING",
  "NO_FIX_FOUND",
] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

export interface Candidate {
  sha: string;
  mr?: string;
  ticket?: string;
  branch?: string;
  date?: string;
  evidenceIds: string[];
}

export interface FixLine {
  target: string;
  status: FixStatus;
  mr?: string;
  ticket?: string;
  branch?: string;
  failingCase?: string;
  evidenceIds: string[];
}

export interface ProposedFix {
  files: string[];
  change: string;
  explanation: string;
  evidenceIds: string[];
  regressionTestEvidenceId?: string;
}

export interface Verdict {
  origin: Origin;
  goodStateEvidenceId?: string;
  firstFeatureCommit?: string;
  candidates: Candidate[];
  fixes: FixLine[];
  proposedFix?: ProposedFix;
  noProposedFixReason?: string;
  observed: string[];
  inferred: string[];
  unknown: string[];
}

export interface Score {
  value: number;
  breakdown: { label: string; points: number }[];
}

/** Exact mention, placed in `coverage.notExamined` when the clone is shallow. */
export const HISTORY_TRUNCATED_NOTE = "history truncated";

const KINDS_BY_STRENGTH: EvidenceKind[] = ["execution", "attestation", "code_reading", "claim"];

const CAUSE_BASE: Record<EvidenceKind, { label: string; points: number }> = {
  execution: { label: "Automatic execution", points: 90 },
  attestation: { label: "User attestation", points: 80 },
  code_reading: { label: "Code reading", points: 50 },
  claim: { label: "Mere assertion", points: 20 },
};

/** Length from which a sha prefix designates a commit for proving. */
const MIN_PROOF_PREFIX = 7;
/** Length from which a prefix raises doubt, and doubt refuses. */
const MIN_DOUBT_PREFIX = 4;

function evidenceOf(inv: Investigation, id: string): Evidence | undefined {
  return inv.evidence.find((e) => e.id === id);
}

function kindOf(inv: Investigation, id: string): EvidenceKind | undefined {
  return evidenceOf(inv, id)?.kind;
}

function strongestKind(kinds: (EvidenceKind | undefined)[]): EvidenceKind | undefined {
  return KINDS_BY_STRENGTH.find((kind) => kinds.includes(kind));
}

/** Only what was executed or attested counts as a test; reading and assertion do not. */
function isTest(kind: EvidenceKind | undefined): boolean {
  return kind === "execution" || kind === "attestation";
}

/** A test that has not been withdrawn and whose result is one of those expected. The type alone proves nothing. */
export function isTestWithOutcome(evidence: Evidence | undefined, outcomes: string[]): boolean {
  return (
    evidence !== undefined &&
    !evidence.superseded &&
    isTest(evidence.kind) &&
    evidence.subject !== undefined &&
    outcomes.includes(evidence.subject.outcome)
  );
}

/** The same text, ignoring case and whitespace: two different wordings remain two scenarios. */
export function normalizeScenario(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function scenarioOf(evidence: Evidence | undefined): string | undefined {
  const raw = (evidence?.data as { scenario?: unknown } | null | undefined)?.scenario;
  const scenario = typeof raw === "string" ? normalizeScenario(raw) : "";
  return scenario === "" ? undefined : scenario;
}

/** Two explicit, different scenarios do not answer each other. Without a scenario, we cannot tell: the test counts. */
export function isComparable(evidence: Evidence | undefined, scenario: string | undefined): boolean {
  const own = scenarioOf(evidence);
  return scenario === undefined || own === undefined || own === scenario;
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/** Too short to designate a commit, even to doubt one. */
function isUnusableSha(sha: string): boolean {
  return normalizeSha(sha).length < MIN_DOUBT_PREFIX;
}

/** To prove: same commit, full sha or prefix, in either direction. */
export function sameCommit(a: string, b: string): boolean {
  const [x, y] = [normalizeSha(a), normalizeSha(b)];
  if (x.length < MIN_PROOF_PREFIX || y.length < MIN_PROOF_PREFIX) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** To refuse: a short prefix is enough, but two shas that diverge are two commits. */
export function maybeSameCommit(a: string, b: string): boolean {
  const [x, y] = [normalizeSha(a), normalizeSha(b)];
  if (x.length < MIN_DOUBT_PREFIX || y.length < MIN_DOUBT_PREFIX) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Anything that is not a "no" from the user, including an old file without the field. */
function mayBeIntermittent(inv: Investigation): boolean {
  return inv.intermittent !== false;
}

function isHistoryTruncated(inv: Investigation): boolean {
  return inv.coverage.notExamined.includes(HISTORY_TRUNCATED_NOTE);
}

function isBlank(text: string | undefined): boolean {
  return text === undefined || text.trim() === "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isCandidateShape(value: unknown): boolean {
  return isRecord(value) && typeof value.sha === "string" && isStringArray(value.evidenceIds);
}

function isFixLineShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.target === "string" &&
    !isBlank(value.target) &&
    isStringArray(value.evidenceIds) &&
    isOptionalString(value.failingCase)
  );
}

function isProposedFixShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringArray(value.files) &&
    typeof value.change === "string" &&
    typeof value.explanation === "string" &&
    isStringArray(value.evidenceIds) &&
    isOptionalString(value.regressionTestEvidenceId)
  );
}

/** The verdict comes from an MCP client: the types guarantee nothing at runtime. */
function isVerdictShape(v: unknown): v is Verdict {
  return (
    isRecord(v) &&
    Array.isArray(v.candidates) &&
    v.candidates.every(isCandidateShape) &&
    Array.isArray(v.fixes) &&
    v.fixes.every(isFixLineShape) &&
    (v.proposedFix === undefined || isProposedFixShape(v.proposedFix)) &&
    isOptionalString(v.goodStateEvidenceId) &&
    isOptionalString(v.firstFeatureCommit) &&
    isOptionalString(v.noProposedFixReason) &&
    isStringArray(v.observed) &&
    isStringArray(v.inferred) &&
    isStringArray(v.unknown)
  );
}

function declaresScore(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, child]) => key === "score" || key === "confidence" || declaresScore(child, seen),
  );
}

/** All the evidence cited, wherever it is cited: none may be unknown. */
export function citedIds(v: Verdict): string[] {
  const ids = [
    ...v.candidates.flatMap((c) => c.evidenceIds),
    ...v.fixes.flatMap((f) => f.evidenceIds),
    ...(v.proposedFix?.evidenceIds ?? []),
  ];
  if (v.goodStateEvidenceId !== undefined) ids.push(v.goodStateEvidenceId);
  if (v.proposedFix?.regressionTestEvidenceId !== undefined) {
    ids.push(v.proposedFix.regressionTestEvidenceId);
  }
  return ids;
}

export function isTestOn(evidence: Evidence | undefined, sha: string, outcomes: string[]): boolean {
  return isTestWithOutcome(evidence, outcomes) && sameCommit(evidence?.subject?.sha ?? "", sha);
}

/** The cited evidence by which a finished, non-replaced bisect designated this commit. */
export function bisectProofs(inv: Investigation, c: Candidate): Evidence[] {
  return c.evidenceIds
    .map((id) => evidenceOf(inv, id))
    .filter((e): e is Evidence => e !== undefined && !e.superseded && isTestOn(e, c.sha, ["culprit"]));
}

/** The answers reused without a new test by this bisect. The investigation file is not trusted: the rest is ignored. */
export function reusedAnswersOf(proof: Evidence): ReusedAnswer[] {
  const listed = (proof.data as { reusedAnswers?: unknown } | null)?.reusedAnswers;
  if (!Array.isArray(listed)) return [];
  return listed.filter((a): a is ReusedAnswer => isRecord(a) && typeof a.sha === "string" && typeof a.evidenceId === "string");
}

/** The whole investigation, cited or not: the agent chooses what to cite. */
export function hasTestOn(inv: Investigation, sha: string, outcomes: string[], scenario?: string): boolean {
  return inv.evidence.some(
    (e) => !e.superseded && isTestWithOutcome(e, outcomes) && isComparable(e, scenario) && maybeSameCommit(e.subject?.sha ?? "", sha),
  );
}

/** The bisect culprits still standing on a candidate, cited or not: the verdict rests on them anyway. */
export function standingCulprits(inv: Investigation, v: Verdict): Evidence[] {
  return inv.evidence.filter(
    (e) => !e.superseded && isTestWithOutcome(e, ["culprit"]) && v.candidates.some((c) => sameCommit(e.subject?.sha ?? "", c.sha)),
  );
}

/** The reused answers the verdict depends on: those of a culprit on a candidate, and those it cites elsewhere. */
export function reliedReusedAnswers(inv: Investigation, v: Verdict): ReusedAnswer[] {
  const onCandidate = standingCulprits(inv, v);
  const cited = new Set(citedIds(v));
  const relied = inv.evidence
    .filter((e) => !e.superseded && e.subject?.outcome === "culprit")
    .flatMap((e) => reusedAnswersOf(e).filter((a) => onCandidate.includes(e) || cited.has(a.evidenceId)));
  return [...new Map(relied.map((a) => [a.evidenceId, a])).values()];
}

function candidateScenario(inv: Investigation, c: Candidate): string | undefined {
  const proof = bisectProofs(inv, c)[0];
  if (proof) return scenarioOf(proof);
  const bad = c.evidenceIds.map((id) => evidenceOf(inv, id)).find((e) => isTestOn(e, c.sha, ["bad"]));
  return scenarioOf(bad);
}

/** The culprit's scenario. None if it has none, or if the candidates diverge: all the tests then count. */
export function verdictScenario(inv: Investigation, v: Verdict): string | undefined {
  const scenarios = new Set(v.candidates.map((c) => candidateScenario(inv, c)));
  return scenarios.size === 1 ? [...scenarios][0] : undefined;
}

export const PAIR_SCENARIO_NOTE =
  "a bad test and a good test only prove together if they carry the same scenario, written on both";

function isPairProof(inv: Investigation, goodState: Evidence | undefined, cited: (Evidence | undefined)[], sha: string): boolean {
  const scenario = scenarioOf(goodState);
  return (
    isTestWithOutcome(goodState, ["good"]) &&
    scenario !== undefined &&
    cited.some((e) => isTestOn(e, sha, ["bad"]) && scenarioOf(e) === scenario)
  );
}

/** True if the verdict holds a bad-and-good pair that is worth nothing for lack of a common scenario. */
export function hasPairWithoutScenario(inv: Investigation, v: Verdict): boolean {
  if (v.origin !== "PROVEN_REGRESSION") return false;
  const goodState = v.goodStateEvidenceId ? evidenceOf(inv, v.goodStateEvidenceId) : undefined;
  if (!isTestWithOutcome(goodState, ["good"])) return false;
  return v.candidates.some((c) => {
    const cited = c.evidenceIds.map((id) => evidenceOf(inv, id));
    return !isProvenCulprit(inv, v, c) && cited.some((e) => isTestOn(e, c.sha, ["bad"]));
  });
}

/**
 * Either a finished bisect designated this commit, or it is bad and the good state was tested.
 * That this good state is the direct parent of the commit is checked with git, at submission.
 */
function isProvenCulprit(inv: Investigation, v: Verdict, c: Candidate): boolean {
  if (bisectProofs(inv, c).length > 0) return true;
  const cited = c.evidenceIds.map((id) => evidenceOf(inv, id));
  const goodState = v.goodStateEvidenceId ? evidenceOf(inv, v.goodStateEvidenceId) : undefined;
  return isPairProof(inv, goodState, cited, c.sha);
}

/** A single "good" test of this scenario on this commit is enough, cited or not: the proof no longer holds. */
function isContradicted(inv: Investigation, c: Candidate, scenario: string | undefined): boolean {
  return inv.evidence.some(
    (e) => isTestWithOutcome(e, ["good"]) && isComparable(e, scenario) && maybeSameCommit(e.subject?.sha ?? "", c.sha),
  );
}

function isBehaviorClassificationOf(e: Evidence, sha: string): boolean {
  const data = e.data as { kind?: unknown; sha?: unknown } | null;
  return e.source === "classification" && data?.kind === "behavior" && typeof data.sha === "string" && maybeSameCommit(data.sha, sha);
}

/** The most recent judgement on a commit wins: "behavior" cancels an earlier "cosmetic". */
export function isStandingCosmetic(inv: Investigation, e: Evidence): boolean {
  if (e.subject?.outcome !== "cosmetic" || e.superseded) return false;
  const { sha } = e.subject;
  return !inv.evidence.slice(inv.evidence.indexOf(e) + 1).some((later) => isBehaviorClassificationOf(later, sha));
}

function isCosmetic(inv: Investigation, c: Candidate): boolean {
  return inv.evidence.some((e) => isStandingCosmetic(inv, e) && maybeSameCommit(e.subject?.sha ?? "", c.sha));
}

function hasUnusableSubject(inv: Investigation, id: string): boolean {
  const sha = evidenceOf(inv, id)?.subject?.sha;
  return sha !== undefined && isUnusableSha(sha);
}

function goodStateErrors(inv: Investigation, v: Verdict): string[] {
  const id = v.goodStateEvidenceId;
  if (!id) {
    const regression = v.origin === "PROVEN_REGRESSION" || v.origin === "PROBABLE_REGRESSION";
    return regression ? ["GOOD_STATE_REQUIRED"] : [];
  }
  const errors: string[] = [];
  const evidence = evidenceOf(inv, id);
  const outcome = evidence?.subject?.outcome;
  const notGood = outcome === "bad" || outcome === "culprit" || outcome === "cosmetic" || evidence?.superseded === true;
  if (notGood || (isTest(evidence?.kind) && outcome !== "good")) {
    errors.push("GOOD_STATE_REQUIRED");
  }
  const sha = evidence?.subject?.sha ?? "";
  if (v.candidates.some((c) => c.evidenceIds.includes(id) || maybeSameCommit(sha, c.sha))) {
    errors.push("GOOD_STATE_IS_CULPRIT_EVIDENCE");
  }
  const fix = v.proposedFix;
  if (fix && (fix.evidenceIds.includes(id) || fix.regressionTestEvidenceId === id)) {
    errors.push("GOOD_STATE_IS_FIX_EVIDENCE");
  }
  return errors;
}

function originErrors(inv: Investigation, v: Verdict): string[] {
  const errors: string[] = [];

  if (v.origin === "PROVEN_REGRESSION") {
    if (v.candidates.length !== 1) errors.push("SINGLE_CULPRIT_REQUIRED");
    if (!v.candidates.some((c) => isProvenCulprit(inv, v, c))) errors.push("TEST_REQUIRED");
    if (v.candidates.some((c) => isCosmetic(inv, c))) errors.push("CANDIDATE_COSMETIC");
    const scenario = verdictScenario(inv, v);
    if (v.candidates.some((c) => isContradicted(inv, c, scenario))) errors.push("CONTRADICTORY_EVIDENCE");
    if (mayBeIntermittent(inv)) errors.push("INTERMITTENT_CAPPED");
  }
  if (v.origin === "ORIGINAL_DEFECT") {
    // The commit has no evidence field of its own: it is cited by the candidate that carries its sha.
    const first = v.firstFeatureCommit ?? "";
    if (!v.candidates.some((c) => sameCommit(c.sha, first))) {
      errors.push("FIRST_COMMIT_REQUIRED");
    }
    if (isHistoryTruncated(inv)) errors.push("HISTORY_TRUNCATED");
  }
  return errors;
}

/** The test result required by each status that asserts a tested fact. */
export const REQUIRED_OUTCOME: Partial<Record<FixStatus, string>> = {
  FULLY_FIXED: "good",
  PARTIALLY_FIXED: "good",
  NOT_FIXED: "bad",
};

/** A good test and a bad test on different commits do not contradict each other. */
function citesBothOnSameCommit(inv: Investigation, v: Verdict, line: FixLine): boolean {
  const scenario = verdictScenario(inv, v);
  const cited = line.evidenceIds.map((id) => evidenceOf(inv, id)).filter((e) => isComparable(e, scenario));
  const shasWith = (outcomes: string[]) =>
    cited.filter((e) => isTestWithOutcome(e, outcomes)).map((e) => e?.subject?.sha ?? "");
  const broken = shasWith(["bad", "culprit"]);
  return shasWith(["good"]).some((good) => broken.some((bad) => maybeSameCommit(good, bad)));
}

function fixLineErrors(inv: Investigation, v: Verdict, line: FixLine): string[] {
  const errors: string[] = [];
  if (!FIX_STATUSES.includes(line.status)) errors.push("UNKNOWN_VERDICT_VALUE");
  // An old commit tested good says nothing about the fix.
  if (v.goodStateEvidenceId && line.evidenceIds.includes(v.goodStateEvidenceId)) {
    errors.push("GOOD_STATE_IS_FIX_EVIDENCE");
  }
  // "Nothing found" cites no evidence: that absence rests on the displayed coverage.
  if (line.evidenceIds.length === 0 && line.status !== "NO_FIX_FOUND") {
    errors.push("EVIDENCE_REQUIRED");
  }
  const outcome = REQUIRED_OUTCOME[line.status];
  if (
    outcome !== undefined &&
    !line.evidenceIds.some((id) => isTestWithOutcome(evidenceOf(inv, id), [outcome]))
  ) {
    errors.push("TEST_REQUIRED");
  }
  // A partial fix has, by definition, a good case and a bad case on the same commit.
  if (outcome !== undefined && line.status !== "PARTIALLY_FIXED" && citesBothOnSameCommit(inv, v, line)) {
    errors.push("CONTRADICTORY_EVIDENCE");
  }
  if (line.status === "PARTIALLY_FIXED" && isBlank(line.failingCase)) {
    errors.push("FAILING_CASE_REQUIRED");
  }
  return errors;
}

function isIncomplete(fix: ProposedFix): boolean {
  return (
    fix.files.length === 0 ||
    fix.files.some((file) => isBlank(file)) ||
    isBlank(fix.change) ||
    isBlank(fix.explanation)
  );
}

export function validateVerdict(
  inv: Investigation,
  v: Verdict,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (declaresScore(v)) errors.push("SCORE_IS_COMPUTED");
  if (!isVerdictShape(v)) return { ok: false, errors: [...errors, "MALFORMED_VERDICT"] };

  if (!ORIGINS.includes(v.origin)) errors.push("UNKNOWN_VERDICT_VALUE");
  if (inv.coverage.examined.length === 0) errors.push("COVERAGE_REQUIRED");
  if (v.proposedFix ? isIncomplete(v.proposedFix) : isBlank(v.noProposedFixReason)) {
    errors.push("PROPOSED_FIX_REQUIRED");
  }

  const cited = citedIds(v);
  if (cited.some((id) => kindOf(inv, id) === undefined)) errors.push("EVIDENCE_NOT_FOUND");
  if (cited.some((id) => hasUnusableSubject(inv, id))) errors.push("MALFORMED_VERDICT");

  const noCandidate = v.candidates.length === 0 && v.origin !== "INDETERMINATE";
  if (
    noCandidate ||
    v.candidates.some((c) => isUnusableSha(c.sha) || c.evidenceIds.length === 0) ||
    v.proposedFix?.evidenceIds.length === 0
  ) {
    errors.push("EVIDENCE_REQUIRED");
  }

  const targets = v.fixes.map((line) => line.target.trim());
  if (new Set(targets).size < targets.length) errors.push("DUPLICATE_TARGET");

  errors.push(
    ...goodStateErrors(inv, v),
    ...originErrors(inv, v),
    ...v.fixes.flatMap((line) => fixLineErrors(inv, v, line)),
  );

  return errors.length === 0 ? { ok: true } : { ok: false, errors: [...new Set(errors)] };
}

type Lines = Score["breakdown"];

function total(lines: Lines): number {
  return lines.reduce((sum, line) => sum + line.points, 0);
}

/** A cap that lowers nothing does not appear: the breakdown stays an exact sum. */
function applyCap(lines: Lines, cap: number, label: string): void {
  const value = total(lines);
  if (value > cap) lines.push({ label, points: cap - value });
}

/** A test that does not show a broken candidate says no more than a reading. */
function causeKind(inv: Investigation, v: Verdict, id: string): EvidenceKind | undefined {
  const evidence = evidenceOf(inv, id);
  if (!evidence || !isTest(evidence.kind)) return evidence?.kind;
  const showsBroken =
    !evidence.superseded && v.candidates.some((c) => isTestOn(evidence, c.sha, ["bad", "culprit"]));
  return showsBroken ? evidence.kind : "code_reading";
}

function scoreCause(inv: Investigation, v: Verdict): Score {
  const lines: Lines = [];

  const kind = strongestKind(
    v.candidates.flatMap((c) => c.evidenceIds).map((id) => causeKind(inv, v, id)),
  );
  lines.push(kind ? { ...CAUSE_BASE[kind] } : { label: "No evidence on a candidate", points: 0 });

  const goodState = v.goodStateEvidenceId ? evidenceOf(inv, v.goodStateEvidenceId) : undefined;
  if (isTestWithOutcome(goodState, ["good"])) {
    lines.push({ label: "Good state tested or executed", points: 5 });
  }
  if (goodState?.kind === "claim") {
    lines.push({ label: "Good state merely asserted", points: -10 });
  }

  if (v.candidates.length === 1) lines.push({ label: "Single candidate", points: 5 });
  if (v.candidates.length > 1) {
    const extra = v.candidates.length - 1;
    lines.push({ label: `Additional candidates: ${extra}`, points: -10 * extra });
  }
  if (inv.startMode === "from_logs") {
    lines.push({ label: "Investigation without an exact version", points: -5 });
  }

  applyCap(lines, 95, "Cap 95");
  if (reliedReusedAnswers(inv, v).length > 0) applyCap(lines, 80, "Cap 80: answers reused without a new test");
  if (mayBeIntermittent(inv)) applyCap(lines, 70, "Cap 70: intermittency not ruled out");
  if (isHistoryTruncated(inv)) applyCap(lines, 60, "Cap 60: history truncated");
  if (v.origin === "INDETERMINATE") applyCap(lines, 30, "Cap 30: verdict indeterminate");

  const value = total(lines);
  if (value < 0) lines.push({ label: "Floor 0", points: -value });
  return { value: total(lines), breakdown: lines };
}

function scoreFix(inv: Investigation, fix: ProposedFix, causeValue: number): Score {
  const lines: Lines = [];

  // A fix is proven only by a test that passes after it is applied.
  const proofs = fix.evidenceIds.filter((id) => isTestWithOutcome(evidenceOf(inv, id), ["good"]));
  const kind = strongestKind(proofs.map((id) => kindOf(inv, id)));
  if (kind === "execution") lines.push({ label: "Automatic execution", points: 90 });
  else if (kind === "attestation") {
    lines.push({ label: "User attestation after application", points: 80 });
  } else lines.push({ label: "Reading only", points: 40 });

  const testId = fix.regressionTestEvidenceId;
  if (testId !== undefined && isTestWithOutcome(evidenceOf(inv, testId), ["good"])) {
    lines.push({ label: "Non-regression test", points: 5 });
  }

  applyCap(lines, causeValue, "Cap: confidence in the cause");
  return { value: total(lines), breakdown: lines };
}

export function scoreVerdict(
  inv: Investigation,
  v: Verdict,
): { cause: Score; fix: Score | null } {
  const cause = scoreCause(inv, v);
  return { cause, fix: v.proposedFix ? scoreFix(inv, v.proposedFix, cause.value) : null };
}
