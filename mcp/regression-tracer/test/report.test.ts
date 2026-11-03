import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bisectAnswer, bisectStart, recordAttestation } from "../src/bisect.js";
import { checkFix, examinedTargets, readFixReading } from "../src/fix.js";
import { addEvidence, loadInvestigation, type Evidence, type Investigation } from "../src/investigation.js";
import { recordFeedback, submitVerdict } from "../src/report.js";
import { openSnapshot } from "../src/snapshot.js";
import type { FixLine, Verdict } from "../src/verdict.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

const run = promisify(execFile);
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-report-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupRepos();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Outcome = NonNullable<Evidence["subject"]>["outcome"];

interface Fixture {
  inv: Investigation;
  path: string;
  shas: string[];
  opts: { root: string; worktreesDir: string };
  ev: (kind: Evidence["kind"], outcome?: Outcome, sha?: string, over?: Partial<Evidence>) => string;
}

/** Real repository: A, B, C, D on main, and S on a branch starting from A. */
async function fixture(): Promise<Fixture> {
  const { path, shas } = await makeRepo({
    commits: [
      { files: { "a.txt": "1" }, message: "A" },
      { files: { "a.txt": "2" }, message: "B" },
      { files: { "a.txt": "3" }, message: "C" },
      { files: { "a.txt": "4" }, message: "D" },
    ],
  });
  await run("git", ["checkout", "-q", "-b", "side", shas[0]!], { cwd: path });
  await run("git", ["commit", "-q", "--allow-empty", "-m", "S"], { cwd: path });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path });
  await run("git", ["checkout", "-q", "main"], { cwd: path });
  shas.push(stdout.trim());

  const inv: Investigation = {
    id: randomUUID(),
    repos: [{ repoId: "app", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] }],
    evidence: [],
    startMode: "exact_version",
    intermittent: false,
    snapshots: [],
    coverage: { examined: ["src/a.txt"], notExamined: ["module b"] },
  };
  const ev: Fixture["ev"] = (kind, outcome, sha, over = {}) =>
    addEvidence(inv, {
      kind,
      summary: `evidence ${kind}`,
      source: "test",
      data: outcome && sha ? { scenario: "test scenario" } : null,
      untrusted: false,
      ...(outcome && sha ? { subject: { sha, outcome } } : {}),
      ...over,
    }).id;
  const root = tmp();
  return { inv, path, shas, ev, opts: { root: join(root, "inv"), worktreesDir: join(root, "wt") } };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    origin: "INDETERMINATE",
    candidates: [],
    fixes: [],
    noProposedFixReason: "bug already fixed on the target",
    observed: ["the crash appears in 3.3"],
    inferred: ["the null check was skipped"],
    unknown: ["effect on the tablet"],
    ...over,
  };
}

/** `PROVEN_REGRESSION` by bisect on C, good state B. */
function proven(f: Fixture, over: Partial<Verdict> = {}): Verdict {
  const culprit = f.ev("execution", "culprit", f.shas[2]);
  const good = f.ev("execution", "good", f.shas[1]);
  return verdict({
    origin: "PROVEN_REGRESSION",
    goodStateEvidenceId: good,
    candidates: [{ sha: f.shas[2]!, mr: "!42", ticket: "PROJ-7", branch: "feature/nul", date: "2026-10-01", evidenceIds: [culprit] }],
    ...over,
  });
}

/** Target reading as `check_fix` records it. */
function reading(f: Fixture, target: string, present: boolean | undefined, repoId = "app", file = "a.txt", extra: object = {}): string {
  return f.ev("code_reading", undefined, undefined, {
    source: "git cat-file blob abc:a.txt + git log",
    data: {
      repoId,
      target,
      kind: "branch",
      sha: f.shas[3],
      file,
      path: file,
      snippet: "bad()",
      ...(present === undefined ? {} : { faultyCodePresent: present }),
      candidateFixes: [],
      claimedBy: [],
      ...extra,
    },
    untrusted: true,
  });
}

const fixLine = (over: Partial<FixLine>): FixLine => ({ target: "main", status: "FIX_ANNOUNCED", evidenceIds: [], ...over });

async function submitOk(f: Fixture, v: Verdict) {
  const r = await submitVerdict(f.inv, "app", v, f.opts);
  if (!r.ok) throw new Error(r.errors.join(", "));
  return { ...r, md: readFileSync(r.markdownPath, "utf8"), json: JSON.parse(readFileSync(r.jsonPath, "utf8")) };
}

async function errorsOf(f: Fixture, v: Verdict): Promise<string[]> {
  const r = await submitVerdict(f.inv, "app", v, f.opts);
  return r.ok ? [] : r.errors.map((e) => e.split(":")[0]!);
}

/** Reading of a target that contains the culprit C of the test repository. */
const withCulprit = (f: Fixture) => ({ containsCulprit: true, culprit: f.shas[2] });

const GIT_ID = ["-c", "user.name=T", "-c", "user.email=t@e.c"];

async function head(path: string): Promise<string> {
  return (await run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
}

/** Merges `branch` into main and returns the merge sha. */
async function mergeIntoMain(path: string, branch: string): Promise<string> {
  await run("git", [...GIT_ID, "merge", "-q", "--no-ff", "-m", `M ${branch}`, branch], { cwd: path });
  return head(path);
}

/** Adds an empty commit on main, or on a new branch starting from `from`, then returns to main. */
async function commitOn(path: string, branch: string, from?: string): Promise<string> {
  await run("git", from ? ["checkout", "-q", "-b", branch, from] : ["checkout", "-q", branch], { cwd: path });
  await run("git", [...GIT_ID, "commit", "-q", "--allow-empty", "-m", branch], { cwd: path });
  const sha = await head(path);
  await run("git", ["checkout", "-q", "main"], { cwd: path });
  return sha;
}

/** Culprit `sha` designated by bisect, good state on `goodSha`. */
function bisected(f: Fixture, sha: string, goodSha: string, over: Partial<Verdict> = {}): Verdict {
  return verdict({
    origin: "PROVEN_REGRESSION",
    goodStateEvidenceId: f.ev("execution", "good", goodSha),
    candidates: [{ sha, evidenceIds: [f.ev("execution", "culprit", sha)] }],
    ...over,
  });
}

function orphanCommit(path: string): Promise<string> {
  return (async () => {
    await run("git", ["checkout", "-q", "--orphan", "orphan"], { cwd: path });
    await run("git", ["-c", "user.name=T", "-c", "user.email=t@e.c", "commit", "-q", "--allow-empty", "-m", "O"], { cwd: path });
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path });
    await run("git", ["checkout", "-q", "-f", "main"], { cwd: path });
    return stdout.trim();
  })();
}

/** What precedes the first section heading: the report header. */
const headerOf = (md: string) => md.slice(0, md.indexOf("\n## "));

describe("refusals", () => {
  it("refused_verdict_writes_nothing_and_keeps_snapshots", async () => {
    const f = await fixture();
    const snap = await openSnapshot(f.inv, "app", "HEAD", [], f.opts.worktreesDir);
    const exclude = join(f.path, ".git", "info", "exclude");
    const before = readFileSync(exclude, "utf8");

    const r = await submitVerdict(f.inv, "app", verdict({ origin: "PROVEN_REGRESSION" }), f.opts);

    expect(r.ok).toBe(false);
    expect(existsSync(join(f.path, ".proofbench"))).toBe(false);
    expect(readFileSync(exclude, "utf8")).toBe(before);
    expect(existsSync(snap.path)).toBe(true);
    expect(f.inv.snapshots).toHaveLength(1);
    expect(existsSync(f.opts.root)).toBe(false);
  });

  it("refuses_unknown_repo", async () => {
    const f = await fixture();
    const r = await submitVerdict(f.inv, "absent", verdict(), f.opts);
    expect(r).toEqual({ ok: false, errors: ["REPO_UNKNOWN"] });
  });

  it("refuses_unknown_sha", async () => {
    const f = await fixture();
    const v = proven(f);
    const missing = "f".repeat(40);
    v.candidates[0]!.sha = missing;
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", missing)];
    expect(await errorsOf(f, v)).toEqual(["SHA_UNKNOWN"]);
    expect(existsSync(join(f.path, ".proofbench"))).toBe(false);
  });

  it("refuses_unknown_first_feature_commit", async () => {
    const f = await fixture();
    const missing = "e".repeat(40);
    const v = verdict({
      origin: "INDETERMINATE",
      firstFeatureCommit: missing,
    });
    expect(await errorsOf(f, v)).toEqual(["SHA_UNKNOWN"]);
  });

  it("refuses_unknown_subject_sha", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds.push(f.ev("execution", "bad", "d".repeat(40)));
    expect(await errorsOf(f, v)).toEqual(["SHA_UNKNOWN"]);
  });

  it("an_uncited_subject_does_not_count", async () => {
    const f = await fixture();
    const v = proven(f);
    f.ev("execution", "bad", "d".repeat(40));
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_ref_name_is_not_a_sha", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.sha = "HEAD";
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", "HEAD")];
    expect(await errorsOf(f, v)).toContain("TEST_REQUIRED");

    const g = await fixture();
    const w = verdict({ firstFeatureCommit: "main" });
    expect(await errorsOf(g, w)).toEqual(["SHA_UNKNOWN"]);
  });

  it("a_tag_named_like_a_sha_does_not_pass_for_that_sha", async () => {
    const f = await fixture();
    await run("git", ["tag", "deadbeef", f.shas[0]!], { cwd: f.path });
    expect(await errorsOf(f, verdict({ firstFeatureCommit: "deadbeef" }))).toEqual(["SHA_UNKNOWN"]);
  });

  it("accepts_a_short_and_uppercase_sha", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.sha = f.shas[2]!.slice(0, 10).toUpperCase();
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("refuses_good_state_not_ancestor", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("execution", "good", f.shas[3]);
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_ANCESTOR"]);
  });

  it("accepts_good_state_on_another_branch_for_probable", async () => {
    const f = await fixture();
    const code = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[4]),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [code] }],
    });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("accepts_a_culprit_from_a_branch_older_than_the_good_state", async () => {
    const f = await fixture();
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[3]),
      candidates: [{ sha: f.shas[4]!, evidenceIds: [f.ev("execution", "culprit", f.shas[4])] }],
    });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("probable_checks_every_candidate", async () => {
    const f = await fixture();
    const code = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[3]),
      candidates: [
        { sha: f.shas[4]!, evidenceIds: [code] },
        { sha: f.shas[2]!, evidenceIds: [code] },
      ],
    });
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_ANCESTOR"]);
  });

  it("refuses_good_state_without_common_history", async () => {
    const f = await fixture();
    const orphan = await orphanCommit(f.path);
    const code = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", orphan),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [code] }],
    });
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_ANCESTOR"]);
  });

  it("the_error_says_what_the_relation_is", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("execution", "good", f.shas[3]);
    const r = await submitVerdict(f.inv, "app", v, f.opts);
    expect(r.ok ? "" : r.errors[0]).toMatch(/^GOOD_STATE_NOT_ANCESTOR: .*contains the culprit.*common history/);
  });

  it("a_shallow_clone_refusal_says_why", async () => {
    const f = await fixture();
    const clone = join(tmp(), "clone");
    await run("git", ["clone", "-q", "--depth", "2", "--branch", "main", `file://${f.path.replace(/\\/g, "/")}`, clone]);
    f.inv.repos[0]!.path = clone;
    const r = await submitVerdict(f.inv, "app", proven(f), f.opts);
    expect(r.ok ? "" : r.errors.join()).toMatch(/^SHA_UNKNOWN: .*shallow clone/);
  });

  it("refuses_a_contradicted_good_state", async () => {
    const f = await fixture();
    const v = proven(f);
    f.ev("execution", "bad", f.shas[1]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("refuses_a_parent_shown_broken_without_being_cited", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("execution", "good", f.shas[0]);
    f.ev("attestation", "culprit", f.shas[1]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("a_superseded_culprit_on_a_parent_contradicts_nothing", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("execution", "good", f.shas[0]);
    f.ev("execution", "culprit", f.shas[1], { superseded: true });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("refuses_bisect_proof_from_another_repo", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", f.shas[2], { data: { repoId: "other" } })];
    expect(await errorsOf(f, v)).toEqual(["BISECT_OTHER_REPO"]);
  });

  it("a_claimed_good_state_without_subject_has_nothing_to_check", async () => {
    const f = await fixture();
    const reading = f.ev("code_reading");
    const claim = f.ev("claim");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: claim,
      candidates: [{ sha: f.shas[2]!, evidenceIds: [reading] }],
    });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("does_not_check_ancestry_outside_regressions", async () => {
    const f = await fixture();
    const reading = f.ev("code_reading");
    const v = verdict({
      goodStateEvidenceId: f.ev("execution", "good", f.shas[3]),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [reading] }],
    });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("refuses_bad_without_good_parent", async () => {
    const f = await fixture();
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [f.ev("execution", "bad", f.shas[2])] }],
    });
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_PARENT"]);
  });

  it("accepts_bad_with_good_direct_parent", async () => {
    const f = await fixture();
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[1]),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [f.ev("execution", "bad", f.shas[2])] }],
    });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_finished_bisect_needs_no_direct_parent", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("execution", "good", f.shas[0]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_superseded_culprit_no_longer_replaces_the_parent_rule", async () => {
    const f = await fixture();
    const old = f.ev("execution", "culprit", f.shas[2], { superseded: true });
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [{ sha: f.shas[2]!, evidenceIds: [old, f.ev("execution", "bad", f.shas[2])] }],
    });
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_PARENT"]);
  });

  it("a_merge_needs_every_parent_tested_good", async () => {
    const f = await fixture();
    await run("git", ["-c", "user.name=T", "-c", "user.email=t@e.c", "merge", "-q", "--no-ff", "-m", "M", "side"], { cwd: f.path });
    const merge = (await run("git", ["rev-parse", "HEAD"], { cwd: f.path })).stdout.trim();
    const bad = f.ev("execution", "bad", merge);
    const good = f.ev("execution", "good", f.shas[3]);
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: good,
      candidates: [{ sha: merge, evidenceIds: [bad] }],
    });
    expect(await errorsOf(f, v)).toEqual(["GOOD_STATE_NOT_PARENT"]);

    f.ev("execution", "good", f.shas[4]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });
});

describe("fixes tested on the target", () => {
  const line = (over: Partial<FixLine>) => fixLine({ failingCase: "tablet", ...over });

  it.each(["FULLY_FIXED", "PARTIALLY_FIXED"] as const)("%s_accepts_a_test_after_the_culprit", async (status) => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status, evidenceIds: [f.ev("execution", "good", f.shas[3])] })];
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it.each(["FULLY_FIXED", "PARTIALLY_FIXED"] as const)("%s_refuses_a_test_before_the_culprit", async (status) => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status, evidenceIds: [f.ev("execution", "good", f.shas[0])] })];
    expect(await errorsOf(f, v)).toEqual(["TEST_NOT_ON_TARGET"]);
  });

  it("refuses_a_test_outside_the_target", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[4])] })];
    expect(await errorsOf(f, v)).toEqual(["TEST_NOT_ON_TARGET"]);
  });

  it("refuses_an_unknown_target", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ target: "missing", status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[3])] })];
    expect(await errorsOf(f, v)).toEqual(["TARGET_UNKNOWN"]);
  });

  it("a_mere_claim_keeps_an_open_mr_as_target", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ target: "!7", status: "FIX_ANNOUNCED", evidenceIds: [f.ev("claim")] })];
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("not_fixed_accepts_a_bad_test_on_the_tip", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "NOT_FIXED", evidenceIds: [f.ev("execution", "bad", f.shas[3])] })];
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("not_fixed_refuses_a_bad_test_on_an_older_commit", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "NOT_FIXED", evidenceIds: [f.ev("execution", "bad", f.shas[2])] })];
    const r = await submitVerdict(f.inv, "app", v, f.opts);
    expect(r.ok ? "" : r.errors.join()).toMatch(/^TEST_NOT_ON_TARGET: .*tip of the target/);
  });

  it("not_fixed_refuses_a_commit_outside_the_target", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "NOT_FIXED", evidenceIds: [f.ev("execution", "bad", f.shas[4])] })];
    expect(await errorsOf(f, v)).toEqual(["TEST_NOT_ON_TARGET"]);
  });

  it("total_fix_on_the_tip_shows_the_commit_without_caveat", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[3])] })];
    const { md, json } = await submitOk(f, v);
    const row = md.split("\n").find((l) => l.startsWith("| main |"))!;
    expect(row).toContain(f.shas[3]);
    expect(row).not.toContain("not tested");
    expect(json.fixes[0].testedCommit).toBe(f.shas[3]);
    expect(json.fixes[0].caveat).toBeUndefined();
  });

  it("total_fix_before_the_tip_stays_valid_with_a_caveat", async () => {
    const f = await fixture();
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [{ sha: f.shas[1]!, evidenceIds: [f.ev("execution", "culprit", f.shas[1])] }],
      fixes: [line({ status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[2])] })],
    });
    const { md, json } = await submitOk(f, v);
    const row = md.split("\n").find((l) => l.startsWith("| main |"))!;
    expect(row).toContain(f.shas[2]);
    expect(row).toContain("later commits of the target not tested");
    expect(json.fixes[0].testedCommit).toBe(f.shas[2]);
    expect(json.fixes[0].caveat).toBe("later commits of the target not tested");
  });

  it("an_uncited_bad_test_contradicts_a_total_fix", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[3])] })];
    f.ev("attestation", "bad", f.shas[3]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("an_uncited_good_test_contradicts_not_fixed", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "NOT_FIXED", evidenceIds: [f.ev("execution", "bad", f.shas[3])] })];
    f.ev("attestation", "good", f.shas[3]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("a_partial_fix_may_have_a_failing_case_on_the_same_commit", async () => {
    const f = await fixture();
    const v = proven(f);
    v.fixes = [line({ status: "PARTIALLY_FIXED", evidenceIds: [f.ev("execution", "good", f.shas[3]), f.ev("execution", "bad", f.shas[3])] })];
    expect((await submitOk(f, v)).ok).toBe(true);
  });
});

describe("a fix presupposes the culprit", () => {
  const total = (f: Fixture, sha: string, target = "main") =>
    fixLine({ target, status: "FULLY_FIXED", evidenceIds: [f.ev("execution", "good", sha)] });

  it("refuses_a_target_that_never_had_the_culprit", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[4]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[3]!)];
    expect(await errorsOf(f, v)).toEqual(["TEST_WITHOUT_CULPRIT"]);
  });

  it("refuses_a_partial_fix_without_the_culprit", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[4]!, f.shas[0]!);
    v.fixes = [fixLine({ status: "PARTIALLY_FIXED", failingCase: "x", evidenceIds: [f.ev("execution", "good", f.shas[3])] })];
    expect(await errorsOf(f, v)).toEqual(["TEST_WITHOUT_CULPRIT"]);
  });

  it("refuses_a_test_before_the_merge_that_brought_the_culprit", async () => {
    const f = await fixture();
    const merge = await mergeIntoMain(f.path, "side");
    const v = bisected(f, f.shas[4]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[3]!)];
    expect(await errorsOf(f, v)).toEqual(["TEST_WITHOUT_CULPRIT"]);

    v.fixes = [total(f, merge)];
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("every_candidate_must_be_contained", async () => {
    const f = await fixture();
    const code = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [
        { sha: f.shas[2]!, evidenceIds: [code] },
        { sha: f.shas[4]!, evidenceIds: [code] },
      ],
    });
    v.fixes = [total(f, f.shas[3]!)];
    expect(await errorsOf(f, v)).toEqual(["TEST_WITHOUT_CULPRIT"]);
  });

  it("refuses_a_fix_without_any_candidate", async () => {
    const f = await fixture();
    const v = verdict({ fixes: [total(f, f.shas[3]!)] });
    expect(await errorsOf(f, v)).toEqual(["EVIDENCE_REQUIRED"]);

    const partial = fixLine({ status: "PARTIALLY_FIXED", failingCase: "x", evidenceIds: [f.ev("execution", "good", f.shas[3])] });
    expect(await errorsOf(f, verdict({ fixes: [partial] }))).toEqual(["EVIDENCE_REQUIRED"]);
  });
});

describe("a fix must not be contradicted further on", () => {
  const total = (f: Fixture, ...shas: string[]) =>
    fixLine({ status: "FULLY_FIXED", evidenceIds: shas.map((sha) => f.ev("execution", "good", sha)) });

  it("refuses_a_bad_test_after_the_fix", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[2]!)];
    f.ev("attestation", "bad", f.shas[3]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("a_superseded_culprit_after_the_fix_leaves_only_the_caveat", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[2]!)];
    f.ev("execution", "culprit", f.shas[3], { superseded: true });
    const { json } = await submitOk(f, v);
    expect(json.fixes[0].caveat).toBe("later commits of the target not tested");
  });

  it("a_later_good_test_clears_an_intermediate_bad_one", async () => {
    const f = await fixture();
    const tip = await commitOn(f.path, "main");
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[2]!, tip)];
    f.ev("execution", "bad", f.shas[3]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_bad_test_on_a_branch_without_the_fix_merged_later_contradicts_nothing", async () => {
    const f = await fixture();
    const late = await commitOn(f.path, "late", f.shas[1]!);
    await mergeIntoMain(f.path, "late");
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[2]!)];
    f.ev("execution", "bad", late);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_bad_test_on_the_merge_after_the_fix_contradicts", async () => {
    const f = await fixture();
    await commitOn(f.path, "late", f.shas[1]!);
    const merge = await mergeIntoMain(f.path, "late");
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [total(f, f.shas[2]!)];
    f.ev("execution", "bad", merge);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("a_partial_fix_may_have_a_later_bad_test", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[1]!, f.shas[0]!);
    v.fixes = [fixLine({ status: "PARTIALLY_FIXED", failingCase: "x", evidenceIds: [f.ev("execution", "good", f.shas[2])] })];
    f.ev("execution", "bad", f.shas[3]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });
});

describe("a bug shown before anything fixed", () => {
  const STATUSES = ["FULLY_FIXED", "PARTIALLY_FIXED"] as const;
  const line = (f: Fixture, status: (typeof STATUSES)[number], ...shas: string[]) =>
    fixLine({ status, failingCase: "tablet", evidenceIds: shas.map((sha) => f.ev("execution", "good", sha)) });

  /** Candidate B kept on reading only, good state A: nothing shows the bug. */
  const probableB = (f: Fixture, fixes: FixLine[]) =>
    verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [{ sha: f.shas[1]!, evidenceIds: [f.ev("code_reading")] }],
      fixes,
    });

  it.each(STATUSES)("%s_refuses_indeterminate_root_candidate_read_only", async (status) => {
    const f = await fixture();
    const v = verdict({
      candidates: [{ sha: f.shas[0]!, evidenceIds: [f.ev("code_reading")] }],
      fixes: [line(f, status, f.shas[3]!)],
    });
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it.each(STATUSES)("%s_refuses_probable_candidate_read_only", async (status) => {
    const f = await fixture();
    expect(await errorsOf(f, probableB(f, [line(f, status, f.shas[2]!)]))).toEqual(["BUG_NOT_SHOWN"]);
  });

  it.each(STATUSES)("%s_refuses_original_defect_without_a_bad_test_then_accepts_one", async (status) => {
    const f = await fixture();
    const v = verdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: f.shas[0]!,
      candidates: [{ sha: f.shas[0]!, evidenceIds: [f.ev("code_reading")] }],
      fixes: [line(f, status, f.shas[3]!)],
    });
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
    f.ev("execution", "bad", f.shas[1]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("explains_the_refusal", async () => {
    const f = await fixture();
    const r = await submitVerdict(f.inv, "app", probableB(f, [line(f, "FULLY_FIXED", f.shas[2]!)]), f.opts);
    expect(r.ok ? "" : r.errors.join()).toMatch(/^BUG_NOT_SHOWN: .*bad test/);
  });

  it("accepts_an_uncited_bad_test_on_the_candidate", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[2]!)]);
    f.ev("execution", "bad", f.shas[1]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("accepts_an_attested_bad_test_between_candidate_and_tested_commit", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[3]!)]);
    f.ev("attestation", "bad", f.shas[2]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_superseded_bad_test_shows_nothing", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[2]!)]);
    f.ev("execution", "culprit", f.shas[1], { superseded: true });
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("a_reading_that_says_bad_shows_nothing", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[2]!)]);
    f.ev("code_reading", "bad", f.shas[1]);
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("a_bad_test_before_the_candidate_shows_nothing", async () => {
    const f = await fixture();
    const v = verdict({
      candidates: [{ sha: f.shas[1]!, evidenceIds: [f.ev("code_reading")] }],
      fixes: [line(f, "FULLY_FIXED", f.shas[2]!)],
    });
    f.ev("execution", "bad", f.shas[0]);
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("a_bad_test_outside_the_tested_history_shows_nothing", async () => {
    const f = await fixture();
    const v = verdict({
      candidates: [{ sha: f.shas[0]!, evidenceIds: [f.ev("code_reading")] }],
      fixes: [line(f, "FULLY_FIXED", f.shas[3]!)],
    });
    f.ev("execution", "bad", f.shas[4]);
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("a_bad_test_after_the_tested_commit_shows_nothing", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "PARTIALLY_FIXED", f.shas[2]!)]);
    f.ev("execution", "bad", f.shas[3]);
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("the_failing_case_of_a_partial_fix_does_not_show_the_bug_before_it", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "PARTIALLY_FIXED", f.shas[2]!)]);
    f.ev("execution", "bad", f.shas[2]);
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
  });

  it("one_candidate_shown_broken_is_enough_when_the_tested_commit_contains_them_all", async () => {
    const f = await fixture();
    const code = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [
        { sha: f.shas[1]!, evidenceIds: [code] },
        { sha: f.shas[2]!, evidenceIds: [code] },
      ],
      fixes: [line(f, "FULLY_FIXED", f.shas[3]!)],
    });
    expect(await errorsOf(f, v)).toEqual(["BUG_NOT_SHOWN"]);
    f.ev("execution", "bad", f.shas[1]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_proof_without_the_bug_before_it_is_not_shown_nor_trusted", async () => {
    const f = await fixture();
    const late = await commitOn(f.path, "late", f.shas[1]!);
    const after = await commitOn(f.path, "main");
    await mergeIntoMain(f.path, "late");
    const fixes = [line(f, "FULLY_FIXED", f.shas[3]!, late)];
    const v = probableB(f, fixes);
    f.ev("execution", "bad", f.shas[2]);
    const row = (await submitOk(f, v)).json.fixes[0];
    expect(row.testedCommit).toBe(f.shas[3]);

    // `late` never showed the bug: it cannot save a fix contradicted on E.
    f.ev("execution", "bad", after);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("tested_commit_is_the_newest_by_history_not_the_last_cited", async () => {
    const f = await fixture();
    await commitOn(f.path, "main");
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[3]!, f.shas[2]!)]);
    f.ev("execution", "bad", f.shas[1]);
    const { md, json } = await submitOk(f, v);
    expect(json.fixes[0].testedCommit).toBe(f.shas[3]);
    expect(json.fixes[0].caveat).toBe("later commits of the target not tested");
    expect(md.split("\n").find((l) => l.startsWith("| main |"))).toContain(f.shas[3]);
  });

  it("the_tip_stays_the_tested_commit_whatever_the_citation_order", async () => {
    const f = await fixture();
    const v = probableB(f, [line(f, "FULLY_FIXED", f.shas[3]!, f.shas[2]!)]);
    f.ev("execution", "bad", f.shas[1]);
    const { json } = await submitOk(f, v);
    expect(json.fixes[0].testedCommit).toBe(f.shas[3]);
    expect(json.fixes[0].caveat).toBeUndefined();
  });
});

describe("a bisect culprit with no bad commit before it", () => {
  it("refuses_a_bad_test_between_good_and_culprit", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[3]!, f.shas[0]!);
    f.ev("execution", "bad", f.shas[1]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("looks_through_every_parent_of_a_merge", async () => {
    const f = await fixture();
    const merge = await mergeIntoMain(f.path, "side");
    const v = bisected(f, merge, f.shas[0]!);
    f.ev("execution", "bad", f.shas[1]);
    expect(await errorsOf(f, v)).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("a_bad_test_after_the_culprit_or_on_another_branch_is_fine", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[2]!, f.shas[1]!);
    f.ev("execution", "bad", f.shas[3]);
    f.ev("execution", "bad", f.shas[4]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("a_bad_test_below_the_good_state_is_outside_the_range", async () => {
    const f = await fixture();
    const v = bisected(f, f.shas[3]!, f.shas[1]!);
    f.ev("execution", "bad", f.shas[0]);
    expect((await submitOk(f, v)).ok).toBe(true);
  });
});

describe("a bisect redone after an attested bound", () => {
  const STALE = /was never tested bad/;

  /** A good, B and C good, D never tested: a first bisect ends without a culprit, the second, asked again in full, finds it. */
  async function redone() {
    const f = await fixture();
    const [good, , , bad] = f.shas as [string, string, string, string];
    const dir = f.opts.worktreesDir;
    const snap = await openSnapshot(f.inv, "app", "main", [], dir);
    const asked: string[] = [];
    const answerAllGood = async () => {
      let step = await bisectStart(f.inv, snap, good, bad, { scenario: "s", reuseAnswers: false }, dir);
      while (!step.done) {
        asked.push(step.testSha!);
        step = await bisectAnswer(f.inv, snap, "good", step.testSha!, dir);
      }
      return step;
    };
    const goodState = await recordAttestation(f.inv, { statement: "A worked", version: "1", kind: "tested", sha: good, outcome: "good" }, "app");
    const first = await answerAllGood();
    expect(first.instruction).toBeDefined();
    expect(f.inv.coverage.notExamined.join("\n")).toMatch(STALE);
    const firstRun = asked.splice(0);
    await recordAttestation(f.inv, { statement: "D crashes", version: "2", kind: "tested", sha: bad, outcome: "bad" }, "app");
    const second = await answerAllGood();
    expect(second.culprit).toBe(bad);
    // The same commits, in the same order; the attested bound is not asked again.
    expect(asked).toEqual(firstRun);
    expect(asked).not.toContain(bad);
    const culprit = f.inv.evidence.find((e) => e.subject?.outcome === "culprit" && !e.superseded)!;
    return { f, bad, snap, answerAllGood, goodState, culprit };
  }

  const attested = (jsonPath: string) =>
    (JSON.parse(readFileSync(jsonPath, "utf8")).attestations as { evidenceId: string }[]).map((a) => a.evidenceId);

  it("the_stale_note_leaves_the_coverage", async () => {
    const { f, bad, goodState, culprit } = await redone();
    const r = await submitOk(f, verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: goodState.id,
      candidates: [{ sha: bad, evidenceIds: [culprit.id] }],
    }));
    const json = JSON.parse(readFileSync(r.jsonPath, "utf8"));
    expect(json.coverage.notExamined.join("\n")).not.toMatch(STALE);
    expect(json.coverage.notExamined).toContain("module b");
    expect(r.md).not.toMatch(STALE);
  });

  it("only_the_latest_answer_on_the_parent_is_relied_upon", async () => {
    const { f, bad, goodState, culprit } = await redone();
    const r = await submitOk(f, verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: goodState.id,
      candidates: [{ sha: bad, evidenceIds: [culprit.id] }],
    }));
    const answers = f.inv.evidence.filter((e) => e.subject?.sha === f.shas[2] && e.subject.outcome === "good");
    expect(answers).toHaveLength(2);
    expect(attested(r.jsonPath)).toContain(answers[1]!.id);
    expect(attested(r.jsonPath)).not.toContain(answers[0]!.id);
  });

  it("a_superseded_culprit_is_not_listed_even_if_cited", async () => {
    const { f, bad, answerAllGood, goodState, culprit } = await redone();
    await answerAllGood();
    const latest = f.inv.evidence.filter((e) => e.subject?.outcome === "culprit").at(-1)!;
    expect(culprit.superseded).toBe(true);
    const r = await submitOk(f, verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: goodState.id,
      candidates: [{ sha: bad, evidenceIds: [latest.id, culprit.id] }],
    }));
    expect(attested(r.jsonPath)).toContain(latest.id);
    expect(attested(r.jsonPath)).not.toContain(culprit.id);
  });
});

describe("a target is a branch or tag name", () => {
  const notFixed = (f: Fixture, target: string) =>
    fixLine({ target, status: "NOT_FIXED", evidenceIds: [f.ev("execution", "bad", f.shas[3])] });

  it("refuses_a_raw_sha_or_an_expression", async () => {
    const f = await fixture();
    for (const target of [f.shas[3]!, f.shas[3]!.slice(0, 10), "main~0", "main^0", "main@{0}"]) {
      expect(await errorsOf(f, proven(f, { fixes: [notFixed(f, target)] }))).toContain("TARGET_UNKNOWN");
    }
  });

  it("accepts_a_tag", async () => {
    const f = await fixture();
    await run("git", ["tag", "v4", f.shas[3]!], { cwd: f.path });
    expect((await submitOk(f, proven(f, { fixes: [notFixed(f, "v4")] }))).ok).toBe(true);
  });

  it("accepts_a_remote_branch_and_a_full_spelling", async () => {
    const f = await fixture();
    await run("git", ["update-ref", "refs/remotes/origin/main", f.shas[3]!], { cwd: f.path });
    for (const target of ["origin/main", "refs/remotes/origin/main", "heads/main", "refs/heads/main"]) {
      expect((await submitOk(f, proven(f, { fixes: [notFixed(f, target)] }))).ok).toBe(true);
    }
  });

  it("refuses_refs_that_are_neither_branch_nor_tag", async () => {
    const f = await fixture();
    for (const ref of ["refs/stash", "refs/bisect/bad", "refs/notes/commits"]) {
      await run("git", ["update-ref", ref, f.shas[3]!], { cwd: f.path });
    }
    for (const target of ["stash", "refs/stash", "bisect/bad", "refs/bisect/bad", "notes/commits", "refs/notes/commits"]) {
      expect(await errorsOf(f, proven(f, { fixes: [notFixed(f, target)] }))).toEqual(["TARGET_UNKNOWN"]);
    }
  });

  it("refuses_head_in_every_spelling", async () => {
    const f = await fixture();
    for (const target of ["HEAD", "@", "head", "main-worktree/HEAD"]) {
      expect(await errorsOf(f, proven(f, { fixes: [notFixed(f, target)] }))).toEqual(["TARGET_UNKNOWN"]);
    }
  });

  it("head_cannot_hide_a_duplicate_of_its_branch", async () => {
    const f = await fixture();
    const claim = fixLine({ target: "HEAD", status: "FIX_ANNOUNCED", evidenceIds: [f.ev("claim")] });
    expect(await errorsOf(f, proven(f, { fixes: [notFixed(f, "main"), claim] }))).toEqual(["DUPLICATE_TARGET"]);
  });

  it("check_fix_still_reads_head", async () => {
    const f = await fixture();
    const { targets } = await checkFix(f.inv, "app", { file: "a.txt", faultySnippet: "4", targets: ["HEAD"] });
    expect(targets[0]).toMatchObject({ target: "HEAD", faultyCodePresent: true });
  });

  it("two_spellings_of_one_ref_are_one_target", async () => {
    const f = await fixture();
    const v = proven(f, { fixes: [notFixed(f, "main"), notFixed(f, "refs/heads/main")] });
    expect(await errorsOf(f, v)).toContain("DUPLICATE_TARGET");
    const claims = [fixLine({ target: "main" , evidenceIds: [f.ev("claim")] }), fixLine({ target: "refs/heads/main", evidenceIds: [f.ev("claim")] })];
    expect(await errorsOf(f, proven(f, { fixes: claims }))).toContain("DUPLICATE_TARGET");
  });

  it("two_refs_on_one_commit_must_agree", async () => {
    const f = await fixture();
    await run("git", ["tag", "v4", f.shas[3]!], { cwd: f.path });
    const same = proven(f, { fixes: [notFixed(f, "main"), notFixed(f, "v4")] });
    expect((await submitOk(f, same)).ok).toBe(true);

    const g = await fixture();
    await run("git", ["tag", "v4", g.shas[3]!], { cwd: g.path });
    const claim = fixLine({ target: "v4", status: "FIX_ANNOUNCED", evidenceIds: [g.ev("claim")] });
    expect(await errorsOf(g, proven(g, { fixes: [notFixed(g, "main"), claim] }))).toEqual(["DUPLICATE_TARGET"]);
  });
});

describe("fixes and readings", () => {
  it("code_fixed_needs_the_culprit_on_the_target", async () => {
    const f = await fixture();
    const ok = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: [reading(f, "main", false, "app", "a.txt", withCulprit(f))] });
    expect((await submitOk(f, proven(f, { fixes: [ok] }))).ok).toBe(true);

    const cases: object[] = [
      { containsCulprit: false, culprit: f.shas[2] },
      {},
      { containsCulprit: true, culprit: f.shas[1] },
    ];
    for (const extra of cases) {
      const g = await fixture();
      const line = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: [reading(g, "main", false, "app", "a.txt", extra)] });
      expect(await errorsOf(g, proven(g, { fixes: [line] }))).toEqual(["TARGET_WITHOUT_CULPRIT"]);
    }
  });

  it("without_regression_an_unknown_culprit_passes", async () => {
    const f = await fixture();
    const line = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: [reading(f, "main", false)] });
    expect((await submitOk(f, verdict({ fixes: [line] }))).ok).toBe(true);

    const g = await fixture();
    const absent = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: [reading(g, "main", false, "app", "a.txt", { containsCulprit: false })] });
    expect(await errorsOf(g, verdict({ fixes: [absent] }))).toEqual(["TARGET_WITHOUT_CULPRIT"]);
  });

  it("real_check_fix_stores_the_culprit", async () => {
    const f = await fixture();
    const main = await checkFix(f.inv, "app", { culprit: f.shas[2]!, file: "a.txt", faultySnippet: "bad()", targets: ["main"] });
    const side = await checkFix(f.inv, "app", { culprit: f.shas[2]!, file: "a.txt", faultySnippet: "bad()", targets: ["side"] });
    const v = proven(f);
    v.fixes = [fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: main.evidenceIds })];
    expect((await submitOk(f, v)).ok).toBe(true);
    const onSide = fixLine({ target: "side", status: "FIX_PRESENT_UNTESTED", evidenceIds: side.evidenceIds });
    expect(await errorsOf(f, { ...v, fixes: [onSide] })).toEqual(["TARGET_WITHOUT_CULPRIT"]);
  });

  it("refuses_none_found_without_examined_target", async () => {
    const f = await fixture();
    f.inv.fixQuery = JSON.stringify(["app", "a.txt", "bad()"]);
    f.inv.coverage.notExamined.push("target:main: file not found");
    const v = verdict({ fixes: [fixLine({ status: "NO_FIX_FOUND" })] });
    expect(await errorsOf(f, v)).toEqual(["COVERAGE_TARGET_MISSING"]);
  });

  it("a_longer_target_name_does_not_cover", async () => {
    const f = await fixture();
    f.inv.fixQuery = JSON.stringify(["app", "a.txt", "bad()"]);
    f.inv.coverage.examined.push("target:main2");
    const v = verdict({ fixes: [fixLine({ status: "NO_FIX_FOUND" })] });
    expect(await errorsOf(f, v)).toEqual(["COVERAGE_TARGET_MISSING"]);
  });

  it("accepts_none_found_with_examined_target", async () => {
    const f = await fixture();
    f.inv.fixQuery = JSON.stringify(["app", "a.txt", "bad()"]);
    f.inv.coverage.examined.push("target:main");
    const v = verdict({ fixes: [fixLine({ status: "NO_FIX_FOUND" })] });
    expect((await submitOk(f, v)).ok).toBe(true);
  });

  it("coverage_of_another_repo_does_not_count", async () => {
    const f = await fixture();
    f.inv.fixQuery = JSON.stringify(["other", "a.txt", "bad()"]);
    f.inv.coverage.examined.push("target:main");
    expect(examinedTargets(f.inv, "app")).toEqual([]);
    const v = verdict({ fixes: [fixLine({ status: "NO_FIX_FOUND" })] });
    expect(await errorsOf(f, v)).toEqual(["COVERAGE_TARGET_MISSING"]);
  });

  it.each([
    ["FIX_PRESENT_UNTESTED", false, true],
    ["NOT_FIXED_ON_READING", true, false],
  ] as const)("%s_requires_the_matching_reading", async (status, good, opposite) => {
    const ok = await fixture();
    const accepted = verdict({ fixes: [fixLine({ status, evidenceIds: [reading(ok, "main", good)] })] });
    expect((await submitOk(ok, accepted)).ok).toBe(true);

    const f = await fixture();
    // Created along the loop: a more recent reading of the same question replaces the others.
    const cases: (() => string[])[] = [
      () => [reading(f, "main", opposite)],
      () => [reading(f, "main", undefined)],
      () => [reading(f, "release", good)],
      () => [reading(f, "main", good, "other")],
      () => [f.ev("code_reading")],
      () => [reading(f, "main", good, "app", "a.txt"), reading(f, "main", opposite, "app", "b.txt")],
    ];
    for (const evidenceIds of cases) {
      const line = fixLine({ status, evidenceIds: evidenceIds() });
      expect(await errorsOf(f, verdict({ fixes: [line] }))).toEqual(["TEST_REQUIRED"]);
    }
  });

  it("real_check_fix_evidence_satisfies_the_gate", async () => {
    const f = await fixture();
    const absent = await checkFix(f.inv, "app", { file: "a.txt", faultySnippet: "bad()", targets: ["main"] });
    const line = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: absent.evidenceIds });
    const none = fixLine({ target: "main", status: "NO_FIX_FOUND" });
    expect((await submitOk(f, verdict({ fixes: [line] }))).ok).toBe(true);
    expect((await submitOk(f, verdict({ fixes: [none] }))).ok).toBe(true);

    const present = await checkFix(f.inv, "app", { file: "a.txt", faultySnippet: "4", targets: ["main"] });
    const unchanged = fixLine({ status: "NOT_FIXED_ON_READING", evidenceIds: present.evidenceIds });
    expect((await submitOk(f, verdict({ fixes: [unchanged] }))).ok).toBe(true);
    const contradicted = fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: present.evidenceIds });
    expect(await errorsOf(f, verdict({ fixes: [contradicted] }))).toEqual(["TEST_REQUIRED"]);
  });

  it("a_stale_reading_gives_way_to_a_newer_one", async () => {
    const f = await fixture();
    const old = reading(f, "main", false);
    reading(f, "main", true);
    const v = verdict({ fixes: [fixLine({ status: "FIX_PRESENT_UNTESTED", evidenceIds: [old] })] });
    expect(await errorsOf(f, v)).toEqual(["TEST_REQUIRED"]);
  });

  it("read_fix_reading_only_accepts_check_fix_evidence", async () => {
    const f = await fixture();
    const get = (id: string) => readFixReading(f.inv.evidence.find((e) => e.id === id)!);
    expect(get(reading(f, "main", false))).toEqual({ repoId: "app", target: "main", file: "a.txt", snippet: "bad()", faultyCodePresent: false });
    expect(get(reading(f, "main", false, "app", "a.txt", { containsCulprit: true, culprit: "abc" }))).toMatchObject({ containsCulprit: true, culprit: "abc" });
    expect(get(reading(f, "main", false, "app", "a.txt", { containsCulprit: "oui" }))).toBeNull();
    expect(get(f.ev("code_reading"))).toBeNull();
    expect(get(f.ev("execution", undefined, undefined, { source: "git cat-file blob x", data: { target: "main" } }))).toBeNull();
    expect(get(f.ev("code_reading", undefined, undefined, { source: "git cat-file blob x", data: { mr: {} } }))).toBeNull();
  });
});

describe("report writing", () => {
  it("accepted_verdict_closes_snapshots", async () => {
    const f = await fixture();
    const snap = await openSnapshot(f.inv, "app", "HEAD", [], f.opts.worktreesDir);
    const r = await submitOk(f, proven(f));
    expect(r.warnings).toBeUndefined();
    expect(existsSync(snap.path)).toBe(false);
    expect(f.inv.snapshots).toEqual([]);
    expect(loadInvestigation(f.inv.id, f.opts.root).snapshots).toEqual([]);
  });

  it("failed_close_keeps_report_and_warns", async () => {
    const f = await fixture();
    f.inv.snapshots.push({ path: join(tmp(), "x"), repoId: "gone", ref: "HEAD" });
    const r = await submitOk(f, proven(f));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings![0]).toContain("gone");
    expect(r.md).toContain("PROVEN_REGRESSION");
    expect(loadInvestigation(f.inv.id, f.opts.root).snapshots).toHaveLength(1);
  });

  it("filename_is_date_and_id_under_the_repo", async () => {
    const f = await fixture();
    const r = await submitOk(f, proven(f));
    expect(r.markdownPath).toBe(join(f.path, ".proofbench", "reports", basename(r.markdownPath)));
    expect(basename(r.markdownPath)).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${f.inv.id}\\.md$`));
    expect(basename(r.jsonPath)).toBe(basename(r.markdownPath).replace(/\.md$/, ".json"));
  });

  it("report_goes_to_the_repo_named_in_the_call", async () => {
    const f = await fixture();
    const other = await fixture();
    f.inv.repos.push({ ...other.inv.repos[0]!, repoId: "lib" });
    const r = await submitVerdict(f.inv, "lib", verdict(), f.opts);
    expect(r.ok).toBe(true);
    expect(existsSync(join(other.path, ".proofbench", "reports"))).toBe(true);
    expect(existsSync(join(f.path, ".proofbench"))).toBe(false);
  });

  it("report_invisible_to_git_status", async () => {
    const f = await fixture();
    await submitOk(f, proven(f));
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: f.path });
    expect(stdout).toBe("");
  });

  it("exclude_keeps_every_line_and_gets_one_entry", async () => {
    const f = await fixture();
    const exclude = join(f.path, ".git", "info", "exclude");
    writeFileSync(exclude, "# personal\r\n*.log\r\nno-end-of-line");
    await submitOk(f, proven(f));
    await submitOk(f, verdict());
    expect(readFileSync(exclude, "utf8")).toBe("# personal\r\n*.log\r\nno-end-of-line\n.proofbench/\n");
  });

  it("exclude_is_found_from_a_linked_worktree", async () => {
    const f = await fixture();
    const linked = join(tmp(), "linked");
    await run("git", ["worktree", "add", "-q", "--detach", linked, "HEAD"], { cwd: f.path });
    f.inv.repos[0]!.path = linked;
    await submitOk(f, verdict());
    expect(readFileSync(join(f.path, ".git", "info", "exclude"), "utf8")).toContain(".proofbench/");
    expect((await run("git", ["status", "--porcelain"], { cwd: linked })).stdout).toBe("");
    await run("git", ["worktree", "remove", "--force", linked], { cwd: f.path });
  });

  it.each([".proofbench", join(".proofbench", "reports")])("refuses_symlink_at_%s", async (rel) => {
    const f = await fixture();
    const outside = tmp();
    mkdirSync(join(f.path, ".proofbench"), { recursive: true });
    if (rel !== ".proofbench") writeFileSync(join(f.path, ".proofbench", "keep"), "");
    else rmSync(join(f.path, ".proofbench"), { recursive: true });
    symlinkSync(outside, join(f.path, rel), "junction");
    const exclude = join(f.path, ".git", "info", "exclude");
    const before = readFileSync(exclude, "utf8");

    const r = await submitVerdict(f.inv, "app", verdict(), f.opts);

    expect(r).toEqual({ ok: false, errors: ["PROOFBENCH_UNSAFE"] });
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(exclude, "utf8")).toBe(before);
  });

  it("a_report_file_that_is_a_link_is_replaced_not_followed", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    const outside = join(tmp(), "victim.md");
    writeFileSync(outside, "intact");
    rmSync(first.markdownPath);
    symlinkSync(outside, first.markdownPath, "file");
    await submitOk(f, verdict());
    expect(readFileSync(outside, "utf8")).toBe("intact");
  });
});

describe("content", () => {
  it("header_shows_commit_mr_ticket_branch_date", async () => {
    const f = await fixture();
    const v = proven(f);
    const header = headerOf((await submitOk(f, v)).md);
    expect(header).toContain("PROVEN_REGRESSION");
    expect(header).toContain("Proven commit");
    for (const text of [f.shas[2]!, "!42", "PROJ-7", "feature/nul", "2026-10-01"]) expect(header).toContain(text);
  });

  it("header_shows_both_scores_with_breakdown", async () => {
    const f = await fixture();
    const v = proven(f, {
      noProposedFixReason: undefined,
      proposedFix: { files: ["a.txt"], change: "add the test", explanation: "the null gets through", evidenceIds: [] },
    });
    v.proposedFix!.evidenceIds = [f.ev("code_reading")];
    const { md, json } = await submitOk(f, v);
    const header = headerOf(md);
    expect(header).toContain("Confidence in the cause: 95/100");
    expect(header).toContain("Automatic execution: +90");
    expect(header).toContain("Good state tested or executed: +5");
    expect(header).toContain("Confidence in the proposed fix: 40/100");
    expect(header).toContain("Reading only: +40");
    expect(json.scores.cause.value).toBe(95);
    expect(json.scores.fix.value).toBe(40);
  });

  it("no_fix_score_without_proposed_fix", async () => {
    const f = await fixture();
    const { md, json } = await submitOk(f, proven(f));
    expect(headerOf(md)).toContain("Confidence in the proposed fix: not applicable");
    expect(json.scores.fix).toBeNull();
  });

  it("proposed_fix_section_present", async () => {
    const f = await fixture();
    const v = proven(f, {
      noProposedFixReason: undefined,
      proposedFix: { files: ["src/a.kt:12"], change: "if (x != null)\n# not a heading", explanation: "the null gets through", evidenceIds: [] },
    });
    v.proposedFix!.evidenceIds = [f.ev("code_reading")];
    const { md, json } = await submitOk(f, v);
    expect(md).toContain("## Proposed fix");
    expect(md).toContain("src/a.kt:12");
    expect(md).toContain("the null gets through");
    expect(md).toContain("> \\# not a heading");
    expect(json.proposedFix.change).toContain("# not a heading");
  });

  it("no_proposed_fix_reason_shown", async () => {
    const f = await fixture();
    const { md } = await submitOk(f, proven(f));
    expect(md.slice(md.indexOf("## Proposed fix"))).toContain("bug already fixed on the target");
  });

  it("probable_header_lists_candidates", async () => {
    const f = await fixture();
    const reading = f.ev("code_reading");
    const v = verdict({
      origin: "PROBABLE_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[0]),
      candidates: [
        { sha: f.shas[1]!, mr: "!1", evidenceIds: [reading] },
        { sha: f.shas[2]!, ticket: "PROJ-2", evidenceIds: [reading] },
      ],
    });
    const header = headerOf((await submitOk(f, v)).md);
    expect(header).toContain("Candidates");
    expect(header).not.toContain("Proven commit");
    expect(header).toContain(f.shas[1]);
    expect(header).toContain(f.shas[2]);
    expect(header).toContain("PROJ-2");
  });

  it("attested_good_state_flagged_in_header", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("attestation", "good", f.shas[1], { data: { statement: "it worked in 3.2" } });
    const { md, json } = await submitOk(f, v);
    expect(headerOf(md)).toContain("unverified assertion");
    expect(json.goodState.unverified).toBe(true);
  });

  it("claimed_good_state_flagged_in_header", async () => {
    const f = await fixture();
    const v = proven(f);
    v.goodStateEvidenceId = f.ev("claim", undefined, undefined, { data: { statement: "I think it worked" } });
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", f.shas[2])];
    const header = headerOf((await submitOk(f, v)).md);
    expect(header).toContain("unverified assertion");
    expect(header).toContain("I think it worked");
  });

  it("executed_good_state_is_not_flagged", async () => {
    const f = await fixture();
    const { md, json } = await submitOk(f, proven(f));
    expect(md).not.toContain("unverified assertion");
    expect(json.goodState.unverified).toBe(false);
  });

  it("attestation_statement_shown_in_header", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [
      f.ev("attestation", "culprit", f.shas[2], { summary: "bisect", data: { statement: "tested on my Pixel" } }),
    ];
    v.goodStateEvidenceId = f.ev("attestation", "good", f.shas[1], { data: { statement: "it worked in 3.2" } });
    const { md, json } = await submitOk(f, v);
    const header = headerOf(md);
    expect(header).toContain("it worked in 3.2");
    expect(header).toContain("tested on my Pixel");
    expect(json.attestations[0].statement).toBe("tested on my Pixel");
  });

  it("an_attestation_without_statement_shows_its_summary", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [f.ev("attestation", "culprit", f.shas[2], { summary: "Bisect finished: first bad commit" })];
    expect(headerOf((await submitOk(f, v)).md)).toContain("Bisect finished: first bad commit");
  });

  it("fix_table_has_one_row_per_target", async () => {
    const f = await fixture();
    f.inv.fixQuery = JSON.stringify(["app", "a.txt", "bad()"]);
    f.inv.coverage.examined.push("target:release/3.3");
    const v = proven(f, {
      fixes: [
        fixLine({ target: "main", status: "FIX_PRESENT_UNTESTED", mr: "!9", evidenceIds: [reading(f, "main", false, "app", "a.txt", withCulprit(f))] }),
        fixLine({ target: "v3.2", status: "NOT_FIXED_ON_READING", evidenceIds: [reading(f, "v3.2", true)] }),
        fixLine({ target: "release/3.3", status: "NO_FIX_FOUND" }),
      ],
    });
    const { md, json } = await submitOk(f, v);
    const header = headerOf(md);
    const rows = header.split("\n").filter((l) => /^\| (main|v3\.2|release\/3\.3) \|/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("FIX_PRESENT_UNTESTED");
    expect(rows[0]).toContain("!9");
    expect(rows[0]).toContain("code literally absent, not tested");
    expect(rows[1]).not.toContain("literally");
    expect(json.fixes).toHaveLength(3);
    expect(json.fixes[0].caveat).toBe("code literally absent, not tested");
  });

  it("sections_observed_inferred_unknown_rejected_coverage", async () => {
    const f = await fixture();
    f.ev("execution", "good", f.shas[0]);
    f.ev("code_reading", "cosmetic", f.shas[3]);
    f.ev("execution", "culprit", f.shas[1], { superseded: true });
    f.ev("execution", "culprit", f.shas[4], { superseded: true });
    f.inv.repos[0]!.misses.push("GitLab absent");
    const { md, json } = await submitOk(f, proven(f));
    const order = ["## Proposed fix", "## Observed", "## Inferred", "## Unknown", "## Rejected candidates", "## Coverage"];
    const at = order.map((h) => md.indexOf(`\n${h}\n`));
    expect(at.every((n) => n > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(md).toContain("the crash appears in 3.3");
    expect(md).toContain("the null check was skipped");
    expect(md).toContain("effect on the tablet");

    const rejected = md.slice(md.indexOf("## Rejected candidates"), md.indexOf("## Coverage"));
    expect(rejected).toContain(`${f.shas[3]}: classified cosmetic`);
    expect(rejected).not.toContain(f.shas[0]);
    expect(rejected).not.toContain(f.shas[1]);
    expect(rejected).not.toContain(f.shas[2]);

    const coverage = md.slice(md.indexOf("## Coverage"));
    for (const text of ["src/a.txt", "module b", "GitLab absent"]) expect(coverage).toContain(text);
    expect(json.coverage.notExamined).toContain("GitLab absent");
    expect(rejected).toContain(`${f.shas[4]}: bisect replaced`);
    expect(json.rejected).toHaveLength(2);
  });

  it("a_cancelled_cosmetic_classification_is_not_a_rejected_candidate", async () => {
    const f = await fixture();
    f.ev("execution", "good", f.shas[0]);
    f.ev("code_reading", "cosmetic", f.shas[3]);
    f.inv.evidence.push({
      id: `E${f.inv.evidence.length + 1}`, kind: "code_reading", summary: "behavior", source: "classification",
      data: { sha: f.shas[3], kind: "behavior", reason: "sign" }, untrusted: true,
    });
    const { json } = await submitOk(f, proven(f));
    expect(json.rejected).toEqual([]);
  });

  it("bisect_with_another_good_bound_is_flagged", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", f.shas[2], { data: { goodBound: f.shas[0], parentsTested: true } })];
    const { md, json } = await submitOk(f, v);
    expect(headerOf(md)).toContain("Bisect good bound not verified");
    expect(headerOf(md)).toContain(f.shas[0]);
    expect(json.flags).toHaveLength(1);
  });

  it("bisect_with_the_same_good_bound_is_not_flagged", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", f.shas[2], { data: { goodBound: f.shas[1], parentsTested: true } })];
    const { md, json } = await submitOk(f, v);
    expect(md).not.toContain("unverified");
    expect(json.flags).toEqual([]);
  });

  it("untested_parents_appear_in_the_header", async () => {
    const f = await fixture();
    const v = proven(f);
    v.candidates[0]!.evidenceIds = [f.ev("execution", "culprit", f.shas[2], { data: { goodBound: f.shas[1], parentsTested: false } })];
    expect(headerOf((await submitOk(f, v)).md)).toContain("parents of the culprit never tested");
  });

  it("uncited_attestation_relied_on_is_listed", async () => {
    const f = await fixture();
    await run("git", ["-c", "user.name=T", "-c", "user.email=t@e.c", "merge", "-q", "--no-ff", "-m", "M", "side"], { cwd: f.path });
    const merge = (await run("git", ["rev-parse", "HEAD"], { cwd: f.path })).stdout.trim();
    const v = verdict({
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: f.ev("execution", "good", f.shas[3]),
      candidates: [{ sha: merge, evidenceIds: [f.ev("execution", "bad", merge)] }],
    });
    f.ev("attestation", "good", f.shas[4], { data: { statement: "the side branch worked", scenario: "test scenario" } });
    const { md, json } = await submitOk(f, v);
    expect(headerOf(md)).toContain("the side branch worked");
    expect(json.attestations.map((a: { statement: string }) => a.statement)).toEqual(["the side branch worked"]);
  });

  it("escapes_addresses_and_strips_invisible_marks", async () => {
    const f = await fixture();
    const { md } = await submitOk(f, proven(f, { observed: ["mail a@b.example", "so\u00adft a\u061cb"] }));
    expect(md).toContain("mail a\\@b.example");
    expect(md).toContain("soft ab");
  });

  it("json_holds_the_same_data", async () => {
    const f = await fixture();
    const { json } = await submitOk(f, proven(f));
    expect(json).toMatchObject({
      investigationId: f.inv.id,
      repoId: "app",
      origin: "PROVEN_REGRESSION",
      observed: ["the crash appears in 3.3"],
      inferred: ["the null check was skipped"],
      unknown: ["effect on the tablet"],
      noProposedFixReason: "bug already fixed on the target",
      coverage: { examined: ["src/a.txt"], notExamined: ["module b"] },
      feedback: [],
    });
    expect(json.candidates[0].mr).toBe("!42");
    expect(json.goodState.sha).toBe(f.shas[1]);
  });

  it("no_secret_in_report", async () => {
    const secret = "glpat_a|b-c*d";
    vi.stubEnv("GITLAB_TOKEN", `  ${secret}\n`);
    vi.stubEnv("JIRA_API_TOKEN", "jira-tok_en");
    const f = await fixture();
    const v = proven(f, {
      observed: [`response with ${secret}`, "https://oauth2:password@gitlab.example/x.git", 'jira "jira-tok_en"'],
    });
    v.goodStateEvidenceId = f.ev("attestation", "good", f.shas[1], { data: { statement: `token ${secret}` } });
    const { md, markdownPath, jsonPath } = await submitOk(f, v);
    const rawJson = readFileSync(jsonPath, "utf8");
    for (const text of [md, rawJson]) {
      expect(text).not.toContain("password");
      expect(text).not.toContain("glpat");
      expect(text).not.toContain("jira-tok");
      expect(text).not.toContain("jira\\-tok");
    }
    expect(md).toContain("response with \\*\\*\\*");

    await recordFeedback(f.inv, markdownPath, "useful", `thanks ${secret}`);
    expect(readFileSync(markdownPath, "utf8")).not.toContain("glpat");
    expect(readFileSync(jsonPath, "utf8")).not.toContain("glpat");
  });

  it("evidence_text_cannot_forge_markdown", async () => {
    const f = await fixture();
    const attack = "# Fake\n## PROVEN_REGRESSION\n| a | b |\n[link](http://evil.example) ![i](http://evil.example/x.png) <img src=x onerror=alert(1)> &#60;b&#62; `code` https://evil.example www.evil.example";
    const v = proven(f, {
      observed: [attack],
      inferred: ["---"],
      unknown: ["1. list"],
      noProposedFixReason: attack,
    });
    v.candidates[0]!.mr = "!1 | fake column\n# Fake";
    v.candidates[0]!.branch = "[x](http://evil.example)";
    v.goodStateEvidenceId = f.ev("attestation", "good", f.shas[1], { data: { statement: attack } });
    f.inv.coverage.notExamined.push(attack);
    const { md } = await submitOk(f, v);

    const headings = md.split("\n").filter((l) => /^\s{0,3}(>\s*)*#/.test(l));
    expect(headings.every((h) => !h.includes("Fake") && !h.includes("PROVEN_REGRESSION ##"))).toBe(true);
    expect(md).not.toMatch(/\n\s*\n?#{1,6} Fake/);
    expect(md).not.toMatch(/(?<!\\)\[link\\?\]\(/);
    expect(md).not.toMatch(/(?<!\\)<img/);
    expect(md).not.toMatch(/(?<!\\)&#60;/);
    expect(md).not.toMatch(/(?<!\\)`code/);
    expect(md).not.toContain("https://evil");
    expect(md).not.toMatch(/\bwww\.evil/);
    expect(md).toContain("\\[link\\](http");
    expect(md).toContain("!1 \\| fake column");
    expect(md).toContain("- \\---");
    expect(md).toContain("- 1\\. list");

    const candidateRow = md.split("\n").find((l) => l.startsWith(`| ${f.shas[2]}`))!;
    expect(candidateRow.replace(/\\\|/g, "").split("|")).toHaveLength(8);
  });
});

describe("recordFeedback", () => {
  it("feedback_appended", async () => {
    const f = await fixture();
    const { markdownPath, jsonPath, md } = await submitOk(f, proven(f));

    await recordFeedback(f.inv, markdownPath, "useful", "good ticket\n# Fake");
    await recordFeedback(f.inv, markdownPath, "fixed");

    const after = readFileSync(markdownPath, "utf8");
    expect(after.startsWith(md)).toBe(true);
    expect(after.match(/^## User feedback$/gm)).toHaveLength(1);
    expect(after).toContain("useful: good ticket # Fake");
    expect(after).not.toMatch(/^# Fake/m);
    expect(after).toContain("fixed");
    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.feedback.map((x: { outcome: string }) => x.outcome)).toEqual(["useful", "fixed"]);
    expect(json.feedback[0].note).toBe("good ticket\n# Fake");
  });

  it("feedback_survives_resubmission", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    await recordFeedback(f.inv, first.markdownPath, "dead_end", "dead lead");

    const second = await submitOk(f, verdict());
    expect(second.json.feedback.map((x: { note: string }) => x.note)).toEqual(["dead lead"]);
    expect(second.md).toContain("## User feedback");
    expect(second.md).toContain("dead\\_end: dead lead");

    await recordFeedback(f.inv, second.markdownPath, "useful");
    expect(readFileSync(second.markdownPath, "utf8").match(/^## User feedback$/gm)).toHaveLength(1);
  });

  it("a_report_from_another_day_is_replaced", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    await recordFeedback(f.inv, first.markdownPath, "fixed", "done");
    const dir = join(f.path, ".proofbench", "reports");
    const old = (p: string) => join(dir, basename(p).replace(/^\d{4}-\d{2}-\d{2}/, "2020-01-01"));
    renameSync(first.markdownPath, old(first.markdownPath));
    renameSync(first.jsonPath, old(first.jsonPath));
    const other = `2020-01-01-${randomUUID()}.md`;
    writeFileSync(join(dir, other), "other investigation");

    const second = await submitOk(f, verdict());

    expect(readdirSync(dir).sort()).toEqual([basename(second.jsonPath), basename(second.markdownPath), other].sort());
    expect(second.json.feedback.map((x: { note: string }) => x.note)).toEqual(["done"]);
  });

  it("unreadable_json_of_the_same_day_is_never_overwritten", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    await recordFeedback(f.inv, first.markdownPath, "dead_end", "last copy");
    writeFileSync(first.jsonPath, "not json");
    const md = readFileSync(first.markdownPath, "utf8");

    const second = await submitOk(f, verdict());

    expect(readFileSync(first.jsonPath, "utf8")).toBe("not json");
    expect(readFileSync(first.markdownPath, "utf8")).toBe(md);
    expect(basename(second.jsonPath)).toBe(basename(first.jsonPath).replace(".json", "-2.json"));
    expect(basename(second.markdownPath)).toBe(basename(first.markdownPath).replace(".md", "-2.md"));
    expect(second.json.feedback).toEqual([]);
  });

  it("the_warning_says_what_happened", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, "not json");

    const second = await submitOk(f, verdict());

    expect(second.warnings).toHaveLength(1);
    const warning = second.warnings![0]!;
    expect(warning).toContain("unreadable");
    expect(warning).toContain("not carried");
    for (const path of [first.jsonPath, first.markdownPath, second.jsonPath, second.markdownPath]) {
      expect(warning).toContain(basename(path));
    }
  });

  it("the_warning_does_not_name_a_markdown_that_does_not_exist", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, "not json");
    rmSync(first.markdownPath);
    const second = await submitOk(f, verdict());
    expect(second.warnings![0]).not.toContain(basename(first.markdownPath));
  });

  it("a_suffixed_report_replaces_itself_and_keeps_its_feedback", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, "not json");
    const second = await submitOk(f, verdict());
    await recordFeedback(f.inv, second.markdownPath, "useful", "on the suffixed report");

    const third = await submitOk(f, verdict());

    expect(third.jsonPath).toBe(second.jsonPath);
    expect(third.json.feedback.map((x: { note: string }) => x.note)).toEqual(["on the suffixed report"]);
    expect(readdirSync(join(f.path, ".proofbench", "reports"))).toHaveLength(4);
  });

  it("the_suffix_skips_every_unreadable_json", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, "not json");
    const second = await submitOk(f, verdict());
    writeFileSync(second.jsonPath, "still not");

    const third = await submitOk(f, verdict());

    expect(basename(third.jsonPath)).toBe(basename(first.jsonPath).replace(".json", "-3.json"));
    expect(readFileSync(second.jsonPath, "utf8")).toBe("still not");
  });

  it.each([
    ["null", "null"],
    ["no feedback", "{}"],
    ["malformed feedback", '{"feedback":[{"date":1}]}'],
  ])("json_valid_but_without_usable_feedback_is_kept: %s", async (_label, content) => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, content);
    const second = await submitOk(f, verdict());
    expect(readFileSync(first.jsonPath, "utf8")).toBe(content);
    expect(second.jsonPath).not.toBe(first.jsonPath);
  });

  it("an_unreadable_report_of_another_day_keeps_its_json_and_its_markdown", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    await recordFeedback(f.inv, first.markdownPath, "fixed", "only readable copy");
    const dir = join(f.path, ".proofbench", "reports");
    const old = (p: string) => join(dir, basename(p).replace(/^\d{4}-\d{2}-\d{2}/, "2020-01-01"));
    renameSync(first.jsonPath, old(first.jsonPath));
    renameSync(first.markdownPath, old(first.markdownPath));
    writeFileSync(old(first.jsonPath), "not json");

    const second = await submitOk(f, verdict());

    expect(readFileSync(old(first.jsonPath), "utf8")).toBe("not json");
    expect(readFileSync(old(first.markdownPath), "utf8")).toContain("only readable copy");
    expect(second.jsonPath).toBe(first.jsonPath);
    expect(second.warnings![0]).toContain(basename(old(first.jsonPath)));
    expect(second.warnings![0]).toContain(basename(old(first.markdownPath)));
  });

  it("an_old_suffixed_report_is_replaced_but_its_unreadable_sibling_stays", async () => {
    const f = await fixture();
    const first = await submitOk(f, verdict());
    writeFileSync(first.jsonPath, "not json");
    const second = await submitOk(f, verdict());
    await recordFeedback(f.inv, second.markdownPath, "useful", "to carry over");
    const dir = join(f.path, ".proofbench", "reports");
    const old = (p: string) => join(dir, basename(p).replace(/^\d{4}-\d{2}-\d{2}/, "2020-01-01"));
    for (const p of [first.jsonPath, first.markdownPath, second.jsonPath, second.markdownPath]) renameSync(p, old(p));

    const third = await submitOk(f, verdict());

    expect(third.json.feedback.map((x: { note: string }) => x.note)).toEqual(["to carry over"]);
    expect(readdirSync(dir).sort()).toEqual(
      [first.jsonPath, first.markdownPath].flatMap((p) => [basename(p), basename(old(p))]).sort(),
    );
  });

  it("refuses_a_linked_json", async () => {
    const f = await fixture();
    const { markdownPath, jsonPath } = await submitOk(f, verdict());
    const before = readFileSync(markdownPath, "utf8");
    const outside = join(tmp(), "victim.json");
    writeFileSync(outside, "{}");
    rmSync(jsonPath);
    symlinkSync(outside, jsonPath, "file");

    await expect(recordFeedback(f.inv, markdownPath, "useful")).rejects.toThrow(/Report refused/);
    expect(readFileSync(outside, "utf8")).toBe("{}");
    expect(readFileSync(markdownPath, "utf8")).toBe(before);
  });

  it("refuses_paths_outside_reports", async () => {
    const f = await fixture();
    const { markdownPath, jsonPath } = await submitOk(f, proven(f));
    const outside = join(tmp(), basename(markdownPath));
    writeFileSync(outside, "intact");
    const inRepo = join(f.path, "README.md");
    writeFileSync(inRepo, "intact");

    const escape = join(f.path, ".proofbench", "reports", "..", "..", "README.md");
    const missing = join(f.path, ".proofbench", "reports", `2026-01-01-${randomUUID()}.md`);
    for (const path of [outside, inRepo, escape, jsonPath, missing]) {
      await expect(recordFeedback(f.inv, path, "useful")).rejects.toThrow(/Report refused/);
    }
    expect(readFileSync(outside, "utf8")).toBe("intact");
    expect(readFileSync(inRepo, "utf8")).toBe("intact");
  });

  it("refuses_a_report_of_another_investigation", async () => {
    const f = await fixture();
    const { markdownPath } = await submitOk(f, proven(f));
    const other = join(f.path, ".proofbench", "reports", `2026-01-01-${randomUUID()}.md`);
    writeFileSync(other, readFileSync(markdownPath));
    await expect(recordFeedback(f.inv, other, "useful")).rejects.toThrow(/Report refused/);
  });

  it("refuses_a_proofbench_turned_into_a_link", async () => {
    const f = await fixture();
    const { markdownPath } = await submitOk(f, proven(f));
    const outside = tmp();
    mkdirSync(join(outside, "reports"));
    const copy = join(outside, "reports", basename(markdownPath));
    writeFileSync(copy, "intact");
    rmSync(join(f.path, ".proofbench"), { recursive: true });
    symlinkSync(outside, join(f.path, ".proofbench"), "junction");

    await expect(recordFeedback(f.inv, join(f.path, ".proofbench", "reports", basename(markdownPath)), "useful")).rejects.toThrow(/Report refused/);
    expect(readFileSync(copy, "utf8")).toBe("intact");
  });

  it("refuses_an_unknown_outcome", async () => {
    const f = await fixture();
    const { markdownPath } = await submitOk(f, proven(f));
    await expect(recordFeedback(f.inv, markdownPath, "super" as "useful")).rejects.toThrow(/Unknown feedback/);
  });
});
