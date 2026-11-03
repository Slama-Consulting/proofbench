import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bisectAbort as rawAbort,
  bisectAnswer as rawAnswer,
  bisectConfirm as rawConfirm,
  bisectStart as rawStart,
  recordAttestation,
  type BisectAnswer,
  type BisectStep,
} from "../src/bisect.js";
import { git } from "../src/git.js";
import {
  addEvidence,
  createInvestigation,
  loadInvestigation,
  saveInvestigation,
  type Evidence,
  type Investigation,
  type Snapshot,
} from "../src/investigation.js";
import { submitVerdict } from "../src/report.js";
import { closeSnapshots, openSnapshot } from "../src/snapshot.js";
import type { Verdict } from "../src/verdict.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

// The real git, with a call log: to count the cleanups.
vi.mock("../src/git.js", async (original) => {
  const real = await original<typeof import("../src/git.js")>();
  return { ...real, git: vi.fn(real.git) };
});

vi.setConfig({ testTimeout: 60_000 });

const SCENARIO = "Open the cart, validate twice";
const dirs: string[] = [];
const open: { inv: Investigation; base: string }[] = [];

const baseOf = (inv: Investigation) => open.find((o) => o.inv === inv)!.base;
const bisectStart = (inv: Investigation, s: Snapshot, good: string, bad: string, reuseAnswers = true, scenario = SCENARIO) =>
  rawStart(inv, s, good, bad, { scenario, reuseAnswers }, baseOf(inv));
const bisectAnswer = (inv: Investigation, s: Snapshot, answer: BisectAnswer, sha: string) => rawAnswer(inv, s, answer, sha, baseOf(inv));
const bisectAbort = (inv: Investigation, s: Snapshot, keepAnswers?: boolean) => rawAbort(inv, s, baseOf(inv), keepAnswers);
const bisectConfirm = (inv: Investigation, s: Snapshot, sha: string) => rawConfirm(inv, s, sha, baseOf(inv));

afterEach(async () => {
  for (const { inv, base } of open.splice(0)) await closeSnapshots(inv, base);
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-reuse-"));
  dirs.push(d);
  return d;
}

interface Setup {
  inv: Investigation;
  root: string;
  path: string;
  shas: string[];
  snapshot: Snapshot;
  noIntermittency: Evidence;
}

/** Eight commits; `state.txt` is `ok` up to `firstBad` excluded, `broken` afterwards. The user said "not intermittent". */
async function setup(firstBad = 5): Promise<Setup> {
  const commits = Array.from({ length: 8 }, (_, i) => ({
    files: { "state.txt": i < firstBad ? "ok\n" : "broken\n", "n.txt": `${i}\n` },
    message: `commit ${i}`,
  }));
  const { path, shas } = await makeRepo({ commits });
  const root = await tmp();
  const inv = createInvestigation(root);
  inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
  const base = await tmp();
  open.push({ inv, base });
  const snapshot = await openSnapshot(inv, "r1", shas[7]!, [], base);
  const noIntermittency = await recordAttestation(inv, { statement: "the bug happens every time", version: "1", kind: "asserted", intermittent: false });
  return { inv, root, path, shas, snapshot, noIntermittency };
}

async function oracle(step: BisectStep): Promise<"good" | "bad"> {
  const state = await readFile(join(step.worktree, "state.txt"), "utf8");
  return state.startsWith("ok") ? "good" : "bad";
}

const head = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
const culprits = (inv: Investigation) => inv.evidence.filter((e) => e.subject?.outcome === "culprit");
const attest = (inv: Investigation, sha: string, outcome: "good" | "bad", repoId = "r1", scenario: string | undefined = SCENARIO) =>
  recordAttestation(inv, { statement: `tested ${outcome}`, version: "1", sha, outcome, kind: "tested", ...(scenario === undefined ? {} : { scenario }) }, repoId);
const answerOf = (inv: Investigation, sha: string) => inv.evidence.find((e) => e.subject?.sha === sha && e.source === "bisect_answer")!;
const gitCalls = (match: (args: string[]) => boolean) => vi.mocked(git).mock.calls.filter(([, args]) => match(args)).length;
const shasOf = (step: BisectStep) => step.reusedAnswers!.map((a) => a.sha);

/** A complete bisect. Returns the sequence of commits shown. */
async function fullRun(inv: Investigation, snapshot: Snapshot, good: string, bad: string, answer?: "good"): Promise<string[]> {
  const seen: string[] = [];
  let step = await bisectStart(inv, snapshot, good, bad);
  while (!step.done) {
    seen.push(step.testSha!);
    step = await bisectAnswer(inv, snapshot, answer ?? (await oracle(step)), step.testSha!);
  }
  return seen;
}

/** The first commit the bisect would show, without leaving a bisect in progress. */
async function firstShown(inv: Investigation, snapshot: Snapshot, good: string, bad: string): Promise<string> {
  const step = await bisectStart(inv, snapshot, good, bad, false);
  await bisectAbort(inv, snapshot);
  return step.testSha!;
}

function verdictOn(sha: string, goodId: string, proofId: string): Verdict {
  return {
    origin: "PROVEN_REGRESSION",
    goodStateEvidenceId: goodId,
    candidates: [{ sha, evidenceIds: [proofId] }],
    fixes: [],
    noProposedFixReason: "test",
    observed: [],
    inferred: [],
    unknown: [],
  };
}

describe("reuse of answers, culprit confirmation", () => {
  it("a_reuse_never_concludes_without_bisect_confirm", async () => {
    const { inv, shas, snapshot } = await setup(7);
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    expect(culprits(inv)).toEqual([]);
    await attest(inv, shas[7]!, "bad");
    const start = await head(snapshot.path);
    const before = inv.evidence.length;

    const pending = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);

    expect(pending).toMatchObject({ done: false, pendingCulprit: shas[7], remainingEstimate: 0 });
    expect(pending.testSha).toBeUndefined();
    expect(pending.culprit).toBeUndefined();
    expect(pending.reusedAnswers).toEqual(seen.map((sha) => ({ sha, outcome: "good", evidenceId: answerOf(inv, sha).id })));
    expect(inv.evidence).toHaveLength(before);
    await expect(bisectAnswer(inv, snapshot, "bad", shas[7]!)).rejects.toThrow(/bisect_confirm/);
    await expect(bisectConfirm(inv, snapshot, shas[6]!)).rejects.toThrow(/expectedCulprit/);
    expect(culprits(inv)).toEqual([]);

    vi.mocked(git).mockClear();
    const step = await bisectConfirm(inv, snapshot, shas[7]!);

    expect(step).toMatchObject({ done: true, culprit: shas[7], remainingEstimate: 0 });
    expect(inv.evidence).toHaveLength(before + 1);
    expect(culprits(inv)[0]!.data).toMatchObject({
      culprit: shas[7],
      parentsTested: true,
      goodBound: shas[0],
      badBound: shas[7],
      reusedAnswers: pending.reusedAnswers,
    });
    expect(await head(snapshot.path)).toBe(start);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
    await expect(bisectConfirm(inv, snapshot, shas[7]!)).rejects.toThrow(/awaiting|pending/);
  });

  it("a_user_answer_after_a_reuse_also_awaits_confirmation", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    answerOf(inv, seen[0]!).superseded = true;
    const first = culprits(inv)[0]!;

    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step.testSha).toBe(seen[0]);
    const pending = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);

    expect(pending).toMatchObject({ done: false, pendingCulprit: shas[5] });
    expect(shasOf(pending)).toEqual(seen.slice(1));
    expect(first.superseded).toBe(true);
    expect(culprits(inv).filter((e) => !e.superseded)).toEqual([]);

    const done = await bisectConfirm(inv, snapshot, shas[5]!);
    expect(done).toMatchObject({ done: true, culprit: shas[5] });
    expect(culprits(inv).filter((e) => !e.superseded)).toHaveLength(1);
  });

  it("a_conclusion_without_reuse_stays_immediate", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(step).toMatchObject({ culprit: shas[5], reusedAnswers: [] });
    expect(step.pendingCulprit).toBeUndefined();
    expect(culprits(inv)).toHaveLength(1);
  });

  it("without_the_attested_bound_the_reuse_says_to_attest_it_again", async () => {
    const { inv, shas, snapshot } = await setup(7);
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step).toMatchObject({ done: true, possibleCommits: [shas[7]] });
    expect(step.pendingCulprit).toBeUndefined();
    expect(step.instruction).toMatch(/[Aa]ttest/);
    expect(culprits(inv)).toEqual([]);
  });

  it("confirm_refuses_a_reuse_that_has_become_obsolete", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);

    await recordAttestation(inv, { statement: "actually no", version: "1", kind: "asserted", intermittent: true });
    await expect(bisectConfirm(inv, snapshot, shas[5]!)).rejects.toThrow(/bisect_abort/);
    await recordAttestation(inv, { statement: "yes", version: "1", kind: "asserted", intermittent: false });
    await expect(bisectConfirm(inv, snapshot, shas[5]!)).rejects.toThrow(/bisect_abort/);
    expect(seen.length).toBeGreaterThan(0);
    expect(culprits(inv).filter((e) => !e.superseded)).toEqual([]);
    await bisectAbort(inv, snapshot);
    await expect(bisectConfirm(inv, snapshot, shas[5]!)).rejects.toThrow(/awaiting|pending/);
    expect(culprits(inv).filter((e) => !e.superseded)).toEqual([]);
  });

  it("shows_only_the_commit_without_an_answer_and_expected_sha_guards_it", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answered = step.testSha!;
    await bisectAnswer(inv, snapshot, await oracle(step), answered);
    await bisectAbort(inv, snapshot, true);

    step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step.done).toBe(false);
    expect(step.testSha).not.toBe(answered);
    expect(shasOf(step)).toEqual([answered]);
    expect(await head(snapshot.path)).toBe(step.testSha);
    await expect(bisectAnswer(inv, snapshot, "good", answered)).rejects.toThrow(/expectedSha/);

    while (!step.done && !step.pendingCulprit) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(step.pendingCulprit).toBe(shas[5]);
    expect(inv.evidence.filter((e) => e.subject?.sha === answered && e.source === "bisect_answer")).toHaveLength(1);
  });

  it("a_reused_answer_does_not_clean_but_redoes_the_worktree_check", async () => {
    const { inv, path, shas } = await setup();
    await writeFile(join(path, "local.env"), "secret=1\n");
    const snapshot = await openSnapshot(inv, "r1", shas[7]!, ["local.env"], open[0]!.base);
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    expect(seen).toHaveLength(3);
    answerOf(inv, seen[2]!).superseded = true;

    vi.mocked(git).mockClear();
    const refused = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    const guards = gitCalls((a) => a.includes("--git-common-dir"));
    expect(refused.testSha).toBe(seen[0]);
    await bisectAbort(inv, snapshot);

    vi.mocked(git).mockClear();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);

    expect(step.testSha).toBe(seen[2]);
    expect(shasOf(step)).toEqual(seen.slice(0, 2));
    // Before the start and before handing control back: nothing for each reused answer.
    expect(gitCalls((a) => a[0] === "clean")).toBe(2);
    expect(gitCalls((a) => a[0] === "bisect" && (a[1] === "good" || a[1] === "bad"))).toBe(2);
    expect(gitCalls((a) => a.includes("--git-common-dir"))).toBe(guards + 2);
    expect(await readFile(join(snapshot.path, "local.env"), "utf8")).toBe("secret=1\n");
  });

  it("the_reuse_in_bisect_answer_keeps_the_lock", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    answerOf(inv, seen[0]!).superseded = true;
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answer = await oracle(step);
    const both = await Promise.allSettled([
      bisectAnswer(inv, snapshot, answer, step.testSha!),
      bisectAnswer(inv, snapshot, answer, step.testSha!),
    ]);
    expect(both.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((both.find((a) => a.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/busy/);
  });
});

describe("scenario of the answers", () => {
  it("bisect_start_rejects_an_empty_scenario_or_a_missing_choice", async () => {
    const { inv, shas, snapshot } = await setup();
    const start = (input: unknown) => rawStart(inv, snapshot, shas[0]!, shas[7]!, input as never, baseOf(inv));
    await expect(start({ scenario: "  \n ", reuseAnswers: true })).rejects.toThrow(/[Ss]cenario/);
    await expect(start({ reuseAnswers: true })).rejects.toThrow(/[Ss]cenario/);
    await expect(start({ scenario: "x" })).rejects.toThrow(/reuseAnswers/);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
  });

  it("the_answer_and_the_attestation_keep_their_scenario", async () => {
    const { inv, shas, snapshot } = await setup();
    expect((await attest(inv, shas[1]!, "good")).data).toMatchObject({ repoId: "r1", scenario: SCENARIO });
    await expect(attest(inv, shas[1]!, "good", "r1", "   ")).rejects.toThrow(/[Ss]cenario/);
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    await bisectAnswer(inv, snapshot, "bad", step.testSha!);
    expect(inv.evidence.at(-1)!.data).toMatchObject({ repoId: "r1", scenario: SCENARIO });
    await bisectAbort(inv, snapshot);
  });

  it("the_same_scenario_is_recognised_ignoring_case_and_whitespace", async () => {
    const { inv, shas, snapshot } = await setup();
    const sha = await firstShown(inv, snapshot, shas[0]!, shas[7]!);
    await attest(inv, sha, "good");
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, true, "  open the CART,\n  validate   twice ");
    expect(shasOf(step)).toEqual([sha]);
    await bisectAbort(inv, snapshot);
  });

  it("another_scenario_asks_everything_again", async () => {
    const { inv, shas, snapshot } = await setup(7);
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    await attest(inv, shas[7]!, "bad");
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, true, "Open the cart on a new account");
    expect(step).toMatchObject({ done: false, testSha: seen[0], reusedAnswers: [] });
    await bisectAbort(inv, snapshot);
  });
});

describe("exclusions from the reuse", () => {
  const exclusions: [string, (s: Setup, sha: string) => Promise<unknown> | void][] = [
    ["intermittency_without_answer", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      inv.intermittent = null;
    }],
    ["intermittent", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      inv.intermittent = true;
    }],
    ["good_and_bad_on_the_commit", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      await attest(inv, sha, "bad");
    }],
    ["good_attestation_against_bad_execution", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      addEvidence(inv, { kind: "execution", summary: "x", source: "s", data: { sha }, untrusted: true, subject: { sha, outcome: "bad" } });
    }],
    ["execution_evidence", ({ inv }, sha) => {
      addEvidence(inv, { kind: "execution", summary: "x", source: "s", data: { sha, repoId: "r1", scenario: SCENARIO }, untrusted: true, subject: { sha, outcome: "good" } });
    }],
    ["claim_evidence", ({ inv }, sha) => {
      addEvidence(inv, { kind: "claim", summary: "x", source: "s", data: { sha, repoId: "r1", scenario: SCENARIO }, untrusted: true, subject: { sha, outcome: "good" } });
    }],
    ["code_reading_evidence", ({ inv }, sha) => {
      addEvidence(inv, { kind: "code_reading", summary: "x", source: "s", data: { sha, repoId: "r1", scenario: SCENARIO }, untrusted: true, subject: { sha, outcome: "good" } });
    }],
    ["replaced_attestation", async ({ inv }, sha) => {
      (await attest(inv, sha, "good")).superseded = true;
    }],
    ["attestation_without_repository", ({ inv }, sha) => {
      addEvidence(inv, { kind: "attestation", summary: "x", source: "attestation", data: { sha, scenario: SCENARIO }, untrusted: true, subject: { sha, outcome: "good" } });
    }],
    ["attestation_without_scenario", async ({ inv }, sha) => {
      await recordAttestation(inv, { statement: "tested", version: "1", sha, outcome: "good", kind: "tested" }, "r1");
    }],
    ["attestation_from_another_repository", async ({ inv, path }, sha) => {
      const copy = join(await tmp(), "clone");
      await git(path, ["clone", "-q", path, copy]);
      inv.repos.push({ repoId: "r2", path: copy, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
      await attest(inv, sha, "good", "r2");
    }],
    ["attestation_from_before_the_user_last_no", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      await recordAttestation(inv, { statement: "still no", version: "1", kind: "asserted", intermittent: false });
    }],
    ["attestation_given_with_the_user_no", async ({ inv }, sha) => {
      await recordAttestation(inv, { statement: "tested", version: "1", sha, outcome: "good", kind: "tested", scenario: SCENARIO, intermittent: false }, "r1");
    }],
    ["no_without_evidence_from_the_user", async ({ inv }, sha) => {
      await attest(inv, sha, "good");
      inv.evidence.forEach((e) => {
        delete (e.data as { intermittent?: boolean }).intermittent;
      });
    }],
  ];

  it.each(exclusions)("does_not_reuse_%s", async (_, seed) => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const sha = await firstShown(inv, snapshot, shas[0]!, shas[7]!);
    await seed(s, sha);

    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);

    expect(step).toMatchObject({ done: false, testSha: sha, reusedAnswers: [] });
    expect(await head(snapshot.path)).toBe(sha);
    await bisectAbort(inv, snapshot);
  });

  it("a_commit_skipped_after_its_answer_is_asked_again", async () => {
    const { inv, shas, snapshot } = await setup();
    const sha = await firstShown(inv, snapshot, shas[0]!, shas[7]!);
    await attest(inv, sha, "good");
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    await bisectAnswer(inv, snapshot, "skip", step.testSha!);
    expect(inv.evidence.at(-1)!.data).toMatchObject({ sha, answer: "skip", repoId: "r1" });
    await bisectAbort(inv, snapshot, true);

    const redone = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(redone).toMatchObject({ testSha: sha, reusedAnswers: [] });
    await bisectAbort(inv, snapshot, true);

    await attest(inv, sha, "good");
    const after = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(shasOf(after)).toEqual([sha]);
    await bisectAbort(inv, snapshot);
  });

  it("an_attestation_outside_a_bisect_is_reused", async () => {
    const { inv, shas, snapshot } = await setup();
    const sha = await firstShown(inv, snapshot, shas[0]!, shas[7]!);
    const attested = await attest(inv, sha, "good");
    const before = inv.evidence.length;
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step.testSha).not.toBe(sha);
    expect(step.reusedAnswers).toEqual([{ sha, outcome: "good", evidenceId: attested.id, statement: "tested good" }]);
    expect(inv.evidence).toHaveLength(before);
    await bisectAbort(inv, snapshot);
    expect(attested.superseded).toBeUndefined();
  });

  it("reuse_answers_false_holds_for_the_whole_bisect", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const before = inv.evidence.length;

    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    const shown: string[] = [];
    while (!step.done) {
      shown.push(step.testSha!);
      expect(step.reusedAnswers).toEqual([]);
      step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    }
    expect(shown).toEqual(seen);
    expect(step.culprit).toBe(shas[5]);
    expect(inv.evidence).toHaveLength(before + seen.length + 1);
  });
});

describe("abort and reuse", () => {
  it("an_abort_removes_the_answers_of_this_bisect", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answered = step.testSha!;
    await bisectAnswer(inv, snapshot, await oracle(step), answered);
    await bisectAbort(inv, snapshot);

    expect(answerOf(inv, answered).superseded).toBe(true);
    const redone = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(redone).toMatchObject({ done: false, testSha: answered, reusedAnswers: [] });
    await bisectAbort(inv, snapshot);
  });

  it("keep_answers_keeps_the_answers", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answered = step.testSha!;
    await bisectAnswer(inv, snapshot, await oracle(step), answered);
    await bisectAbort(inv, snapshot, true);

    expect(answerOf(inv, answered).superseded).toBeUndefined();
    const redone = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(shasOf(redone)).toEqual([answered]);
    await bisectAbort(inv, snapshot);
  });

  it("an_abort_leaves_the_answers_reused_from_an_earlier_bisect", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectAbort(inv, snapshot);
    for (const sha of seen) expect(answerOf(inv, sha).superseded).toBeUndefined();
  });

  it("a_removed_answer_no_longer_counts_as_a_test_of_the_culprit", async () => {
    const { inv, shas, snapshot } = await setup(7);
    const bound = await attest(inv, shas[7]!, "bad");
    bound.superseded = true;
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    while (!step.done) step = await bisectAnswer(inv, snapshot, "good", step.testSha!);
    expect(step.culprit).toBeUndefined();
    expect(step.possibleCommits).toEqual([shas[7]]);
  });

  it("a_reload_keeps_the_reused_answers", async () => {
    const { inv, root, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    expect(seen).toHaveLength(3);
    answerOf(inv, seen[1]!).superseded = true;

    // Reuses the first, stops at the second, reuses the third after the reload.
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step.testSha).toBe(seen[1]);
    expect(shasOf(step)).toEqual([seen[0]]);
    saveInvestigation(inv, root);

    const reloaded = loadInvestigation(inv.id, root);
    open.splice(0, 1, { inv: reloaded, base: open[0]!.base });
    step = await bisectAnswer(reloaded, reloaded.snapshots[0]!, await oracle(step), step.testSha!);
    expect(step.pendingCulprit).toBe(shas[5]);
    expect(shasOf(step)).toEqual([seen[0], seen[2]]);
    saveInvestigation(reloaded, root);

    const again = loadInvestigation(inv.id, root);
    open.splice(0, 1, { inv: again, base: open[0]!.base });
    const done = await bisectConfirm(again, again.snapshots[0]!, shas[5]!);
    expect(done.culprit).toBe(shas[5]);
  });

  it("a_reload_keeps_reuse_answers_false_and_the_answers_to_remove", async () => {
    const { inv, root, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);

    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    expect(step.testSha).toBe(seen[0]);
    saveInvestigation(inv, root);
    const reloaded = loadInvestigation(inv.id, root);
    open.splice(0, 1, { inv: reloaded, base: open[0]!.base });

    step = await bisectAnswer(reloaded, reloaded.snapshots[0]!, await oracle(step), step.testSha!);
    expect(step).toMatchObject({ done: false, testSha: seen[1], reusedAnswers: [] });
    const fresh = reloaded.evidence.at(-1)!;
    await bisectAbort(reloaded, reloaded.snapshots[0]!);
    expect(fresh.superseded).toBe(true);
  });

  it("each_reused_answer_is_recorded_before_the_next", async () => {
    const { inv, root, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const saved: number[] = [];
    const persist = () => {
      saveInvestigation(inv, root);
      saved.push(loadInvestigation(inv.id, root).snapshots[0]!.assisted?.reused.length ?? -1);
    };
    await rawStart(inv, snapshot, shas[0]!, shas[7]!, { scenario: SCENARIO, reuseAnswers: true }, baseOf(inv), persist);
    expect(saved).toEqual(expect.arrayContaining(seen.map((_, i) => i + 1)));
  });

  it("a_bisect_without_an_assisted_trace_reuses_nothing", async () => {
    const { inv, shas, snapshot } = await setup();
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    delete inv.snapshots.find((s) => s.path === snapshot.path)!.assisted;
    step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(step).toMatchObject({ done: false, testSha: seen[1] });
    await bisectAbort(inv, snapshot);
  });

  it("a_finished_bisect_leaves_nothing_to_the_next", async () => {
    const { inv, shas, snapshot } = await setup();
    const entry = inv.snapshots.find((s) => s.path === snapshot.path)!;
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false);
    await bisectAbort(inv, snapshot);
    expect(entry.assisted).toBeUndefined();
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    expect(entry.assisted).toBeUndefined();
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[5]!);
    expect(entry.assisted).toBeUndefined();
  });

  it("an_undetermined_bisect_keeps_its_reused_answers", async () => {
    const { inv, shas, snapshot } = await setup(4);
    const sha = await firstShown(inv, snapshot, shas[0]!, shas[7]!);
    expect(sha).not.toBe(shas[4]);
    const attested = await attest(inv, sha, shas.indexOf(sha) < 4 ? "good" : "bad");
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) {
      const skip = step.testSha === shas[4];
      step = await bisectAnswer(inv, snapshot, skip ? "skip" : await oracle(step), step.testSha!);
    }
    expect(step.possibleCommits).toEqual(expect.arrayContaining([shas[4], shas[5]]));
    expect(inv.evidence.at(-1)!.data).toMatchObject({ reusedAnswers: [{ sha, evidenceId: attested.id }] });
  });
});

describe("report of a culprit coming from a reuse", () => {
  interface Report {
    flags: string[];
    scores: { cause: { value: number; breakdown: { label: string; points: number }[] } };
    attestations: { evidenceId: string; reused?: boolean }[];
    intermittency: { evidenceId: string; intermittent: boolean; statement: string } | null;
  }

  async function submitted(s: Setup, culprit: string, goodId: string): Promise<{ json: Report; markdown: string }> {
    s.inv.coverage.examined.push("bisect");
    const proof = culprits(s.inv).at(-1)!;
    const r = await submitVerdict(s.inv, "r1", verdictOn(culprit, goodId, proof.id), { root: s.root, worktreesDir: baseOf(s.inv) });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return { json: JSON.parse(await readFile(r.jsonPath, "utf8")) as Report, markdown: await readFile(r.markdownPath, "utf8") };
  }

  it("the_report_caps_and_flags_the_reuse", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const relied = seen.map((sha) => answerOf(inv, sha));
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[5]!);

    const { json, markdown } = await submitted(s, shas[5]!, good.id);

    for (const e of relied) expect(json.attestations.find((a) => a.evidenceId === e.id)).toMatchObject({ reused: true });
    for (const e of relied) expect(markdown).toContain(`answer reused without a new test** (${e.id})`);
    expect(json.scores.cause.value).toBe(80);
    expect(json.scores.cause.breakdown).toContainEqual({ label: "Cap 80: answers reused without a new test", points: -10 });
    expect(json.flags).toContain(`Answers reused from a previous bisect, without a new test: ${seen.join(", ")}`);
    expect(markdown).toContain(`**Caveat:** Answers reused from a previous bisect, without a new test: ${seen.join(", ")}`);
    expect(json.flags.join("\n")).not.toContain("all tested commits good");
  });

  it("the_false_culprit_of_a_failed_repro_is_flagged", async () => {
    const s = await setup(7);
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    await attest(inv, shas[7]!, "bad");
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[7]!);

    const { json, markdown } = await submitted(s, shas[7]!, good.id);

    expect(json.flags).toContain("all tested commits good: check that the scenario really reproduces the bug");
    expect(markdown).toContain("**Caveat:** all tested commits good");
    expect(json.scores.cause.value).toBe(80);
  });

  it("a_reuse_without_a_test_of_the_parents_is_flagged", async () => {
    const s = await setup(1);
    const { inv, shas, snapshot } = s;
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[1]!);
    expect(culprits(inv).at(-1)!.data).toMatchObject({ parentsTested: false });

    const { json } = await submitted(s, shas[1]!, s.noIntermittency.id);

    expect(json.flags).toContain("Culprit closed on reused answers without a test of its parents: retest before concluding");
  });

  it("the_report_without_reuse_flags_nothing_and_keeps_its_score", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const { json, markdown } = await submitted(s, shas[5]!, good.id);
    expect(markdown).not.toContain("reused");
    expect(json.scores.cause.value).toBe(90);
  });

  it("the_report_shows_the_user_word_on_intermittency", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    expect(s.noIntermittency.data).toMatchObject({ intermittent: false });
    const good = await attest(inv, shas[0]!, "good");
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const { json, markdown } = await submitted(s, shas[5]!, good.id);
    expect(json.intermittency).toEqual({ evidenceId: s.noIntermittency.id, intermittent: false, statement: "the bug happens every time" });
    expect(markdown).toContain(`**Intermittency, user's word** (${s.noIntermittency.id}, not intermittent): "the bug happens every time"`);
  });

  it("an_abort_does_not_make_a_commit_a_rejected_candidate", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answered = step.testSha!;
    await bisectAnswer(inv, snapshot, await oracle(step), answered);
    await bisectAbort(inv, snapshot);
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    const { markdown } = await submitted(s, shas[5]!, good.id);
    expect(markdown).not.toContain(`${answered}: bisect replaced`);
  });

  it("a_removed_answer_no_longer_proves_the_culprit", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[4]!, "good");
    const bad = await attest(inv, shas[5]!, "bad");
    bad.superseded = true;
    inv.coverage.examined.push("reading");
    const r = await submitVerdict(inv, "r1", verdictOn(shas[5]!, good.id, bad.id), { root: s.root, worktreesDir: baseOf(inv) });
    expect(r).toMatchObject({ ok: false });
    expect(snapshot.path).toBeTruthy();
  });

  it("a_removed_good_state_is_refused", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    good.superseded = true;
    inv.coverage.examined.push("bisect");
    const r = await submitVerdict(inv, "r1", verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id), { root: s.root, worktreesDir: baseOf(inv) });
    expect(r).toMatchObject({ ok: false, errors: expect.arrayContaining(["GOOD_STATE_REQUIRED"]) });
  });
});

describe("evidence tied to the scenario", () => {
  const OTHER = "Open the cart on a new account";
  const FAILED = "Open the cart with no item";
  const ALL_GOOD = "all tested commits good: check that the scenario really reproduces the bug";

  interface Submitted {
    flags: string[];
    scores: { cause: { value: number } };
    attestations: { evidenceId: string; reused?: boolean }[];
  }

  async function submit(s: Setup, v: Verdict) {
    s.inv.coverage.examined.push("bisect");
    return submitVerdict(s.inv, "r1", v, { root: s.root, worktreesDir: baseOf(s.inv) });
  }

  async function report(s: Setup, v: Verdict): Promise<Submitted> {
    const r = await submit(s, v);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return JSON.parse(await readFile(r.jsonPath, "utf8")) as Submitted;
  }

  /** A failed reproduction under FAILED: everything is declared good, then the bisect is aborted keeping the answers. */
  async function failedRepro(s: Setup): Promise<string[]> {
    const { inv, shas, snapshot } = s;
    const said: string[] = [];
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, true, FAILED);
    while (said.length < 2) {
      said.push(step.testSha!);
      step = await bisectAnswer(inv, snapshot, "good", step.testSha!);
    }
    await bisectAbort(inv, snapshot, true);
    return said;
  }

  async function run(s: Setup, scenario: string): Promise<BisectStep> {
    const { inv, shas, snapshot } = s;
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!, false, scenario);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    return step;
  }

  it("F1_a_pair_of_two_scenarios_proves_nothing", async () => {
    const s = await setup(7);
    const { inv, shas, snapshot } = s;
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    const bad = await attest(inv, shas[7]!, "bad", "r1", OTHER);
    const r = await submit(s, verdictOn(shas[7]!, answerOf(inv, shas[6]!).id, bad.id));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /^TEST_REQUIRED: .*scenario/.test(e))).toBe(true);
  });

  it("F1_evidence_without_a_scenario_is_not_half_a_pair", async () => {
    const s = await setup(7);
    const { inv, shas, snapshot } = s;
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    const bad = await recordAttestation(inv, { statement: "broken", version: "1", sha: shas[7]!, outcome: "bad", kind: "tested" }, "r1");
    const r = await submit(s, verdictOn(shas[7]!, answerOf(inv, shas[6]!).id, bad.id));
    expect(r).toMatchObject({ ok: false });
  });

  it("F1_a_pair_of_the_same_scenario_proves", async () => {
    const s = await setup(7);
    const { inv, shas, snapshot } = s;
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    const bad = await attest(inv, shas[7]!, "bad", "r1", "  open the cart,  VALIDATE twice");
    const json = await report(s, verdictOn(shas[7]!, answerOf(inv, shas[6]!).id, bad.id));
    expect(json.scores.cause.value).toBe(90);
  });

  it("F1_a_bad_bound_of_another_scenario_does_not_close_the_bisect", async () => {
    const { inv, shas, snapshot } = await setup(7);
    await attest(inv, shas[7]!, "bad", "r1", OTHER);
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    expect(seen.length).toBeGreaterThan(0);
    expect(culprits(inv)).toEqual([]);
  });

  it("the_cap_applies_even_if_the_verdict_does_not_cite_the_reused_culprit", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[5]!);
    const json = await report(s, verdictOn(shas[5]!, answerOf(inv, shas[4]!).id, answerOf(inv, shas[5]!).id));
    expect(json.scores.cause.value).toBe(80);
    expect(json.flags).toContain(`Answers reused from a previous bisect, without a new test: ${seen.join(", ")}`);
  });

  it("the_cap_applies_to_a_cited_evidence_that_was_reused_elsewhere", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[5]!);
    const proof = culprits(inv).at(-1)!;
    proof.subject = { sha: shas[6]!, outcome: "culprit" };
    const json = await report(s, verdictOn(shas[5]!, answerOf(inv, shas[4]!).id, answerOf(inv, shas[5]!).id));
    expect(json.scores.cause.value).toBe(80);
  });

  it("a_bound_attested_before_an_all_good_bisect_gets_the_caveat", async () => {
    const s = await setup(7);
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    await attest(inv, shas[7]!, "bad");
    await fullRun(inv, snapshot, shas[0]!, shas[7]!, "good");
    const json = await report(s, verdictOn(shas[7]!, good.id, culprits(inv).at(-1)!.id));
    expect(json.flags).toContain(ALL_GOOD);
    expect(json.scores.cause.value).toBe(90);
  });

  it("F2_the_fallback_path_proves_the_real_culprit", async () => {
    const s = await setup();
    const { inv, shas } = s;
    const said = await failedRepro(s);
    expect(said).toContain(shas[5]);
    await attest(inv, shas[3]!, "bad", "r1", FAILED);
    const good = await attest(inv, shas[0]!, "good", "r1", OTHER);
    const step = await run(s, OTHER);
    expect(step.culprit).toBe(shas[5]);
    expect(culprits(inv).at(-1)!.data).toMatchObject({ scenario: OTHER });

    const json = await report(s, verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id));

    const ignored = json.flags.find((f) => f.includes(FAILED))!;
    expect(ignored).toMatch(/another scenario/);
    for (const sha of said) expect(ignored).toContain(sha);
    expect(ignored).toContain(shas[3]);
  });

  it("F2_a_test_without_a_scenario_always_contradicts", async () => {
    const s = await setup();
    const { inv, shas } = s;
    await attest(inv, shas[5]!, "good", "r1", OTHER);
    await recordAttestation(inv, { statement: "good", version: "1", sha: shas[5]!, outcome: "good", kind: "tested" }, "r1");
    const good = await attest(inv, shas[0]!, "good", "r1", SCENARIO);
    await run(s, SCENARIO);
    const r = await submit(s, verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id));
    expect(r).toMatchObject({ ok: false, errors: expect.arrayContaining(["CONTRADICTORY_EVIDENCE"]) });
  });

  it("F2_a_test_of_the_same_scenario_always_contradicts", async () => {
    const s = await setup();
    const { inv, shas } = s;
    await attest(inv, shas[5]!, "good", "r1", SCENARIO);
    const good = await attest(inv, shas[0]!, "good", "r1", SCENARIO);
    await run(s, SCENARIO);
    const r = await submit(s, verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id));
    expect(r).toMatchObject({ ok: false, errors: expect.arrayContaining(["CONTRADICTORY_EVIDENCE"]) });
  });

  it("F2_a_target_ignores_the_tests_of_another_scenario", async () => {
    const s = await setup();
    const { inv, shas } = s;
    await attest(inv, shas[7]!, "good", "r1", FAILED);
    const tip = await attest(inv, shas[7]!, "bad", "r1", SCENARIO);
    const good = await attest(inv, shas[0]!, "good", "r1", SCENARIO);
    await run(s, SCENARIO);
    const v = verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id);
    v.fixes = [{ target: "main", status: "NOT_FIXED", evidenceIds: [tip.id] }];
    expect((await report(s, v)).flags.join("\n")).toContain(FAILED);
  });

  it("F2_a_good_test_of_another_scenario_does_not_prove_a_fix", async () => {
    const s = await setup();
    const { inv, shas } = s;
    const fixed = await attest(inv, shas[7]!, "good", "r1", FAILED);
    const shown = await attest(inv, shas[6]!, "bad", "r1", SCENARIO);
    const good = await attest(inv, shas[0]!, "good", "r1", SCENARIO);
    await run(s, SCENARIO);
    const v = verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id);
    v.fixes = [{ target: "main", status: "FULLY_FIXED", evidenceIds: [fixed.id, shown.id] }];
    const r = await submit(s, v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/BUG_NOT_SHOWN/);
  });

  it("F3_the_reuse_caveats_apply_to_a_probable_verdict", async () => {
    const s = await setup();
    const { inv, shas, snapshot } = s;
    const good = await attest(inv, shas[0]!, "good");
    const seen = await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectConfirm(inv, snapshot, shas[5]!);
    const v = { ...verdictOn(shas[5]!, good.id, culprits(inv).at(-1)!.id), origin: "PROBABLE_REGRESSION" as const };
    const json = await report(s, v);
    expect(json.flags).toContain(`Answers reused from a previous bisect, without a new test: ${seen.join(", ")}`);
    for (const sha of seen) expect(json.attestations.find((a) => a.evidenceId === answerOf(inv, sha).id)).toMatchObject({ reused: true });
  });

  it("bisect_confirm_refuses_a_modified_copy", async () => {
    const { inv, shas, snapshot } = await setup();
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await writeFile(join(snapshot.path, "n.txt"), "modified\n");
    await expect(bisectConfirm(inv, snapshot, shas[5]!)).rejects.toThrow(/modified/);
    expect(culprits(inv).filter((e) => !e.superseded)).toEqual([]);
    await bisectAbort(inv, snapshot);
  });

  it("bisect_confirm_replaces_the_other_culprits_of_the_repository", async () => {
    const { inv, shas, snapshot } = await setup();
    await fullRun(inv, snapshot, shas[0]!, shas[7]!);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const other = addEvidence(inv, { kind: "attestation", summary: "x", source: "s", data: { culprit: shas[3], repoId: "r1" }, untrusted: false, subject: { sha: shas[3]!, outcome: "culprit" } });
    const elsewhere = addEvidence(inv, { kind: "attestation", summary: "x", source: "s", data: { culprit: shas[3], repoId: "r2" }, untrusted: false, subject: { sha: shas[3]!, outcome: "culprit" } });
    await bisectConfirm(inv, snapshot, shas[5]!);
    expect(other.superseded).toBe(true);
    expect(elsewhere.superseded).toBeUndefined();
    expect(culprits(inv).at(-1)!.superseded).toBeUndefined();
  });
});
