import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bisectAbort as rawAbort,
  bisectAnswer as rawAnswer,
  bisectAuto as rawAuto,
  bisectStart as rawStart,
  recordAttestation,
  type BisectAnswer,
  type BisectStep,
} from "../src/bisect.js";
import { git } from "../src/git.js";
import { sessionFor } from "../src/jira-session.js";
import {
  createInvestigation,
  loadInvestigation,
  saveInvestigation,
  type Investigation,
  type Snapshot,
} from "../src/investigation.js";
import { closeSnapshots, openSnapshot } from "../src/snapshot.js";
import { validateVerdict, type Verdict } from "../src/verdict.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

vi.setConfig({ testTimeout: 60_000 });

const FULL_SHA = /^[0-9a-f]{40}$/;
const dirs: string[] = [];
const open: { inv: Investigation; base: string }[] = [];

/** The investigation's copies folder, the one the server would give. */
const baseOf = (inv: Investigation) => open.find((o) => o.inv === inv)!.base;
const bisectStart = (inv: Investigation, s: Snapshot, good: string, bad: string) => rawStart(inv, s, good, bad, { scenario: "s", reuseAnswers: false }, baseOf(inv));
const bisectAnswer = (inv: Investigation, s: Snapshot, answer: BisectAnswer, sha: string) => rawAnswer(inv, s, answer, sha, baseOf(inv));
const bisectAbort = (inv: Investigation, s: Snapshot) => rawAbort(inv, s, baseOf(inv));
const bisectAuto = (inv: Investigation, s: Snapshot, good: string, bad: string, command: string[], budgetMs: number, expected?: string) =>
  rawAuto(inv, s, good, bad, command, budgetMs, expected, baseOf(inv));

afterEach(async () => {
  for (const { inv, base } of open.splice(0)) await closeSnapshots(inv, base);
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-bisect-"));
  dirs.push(d);
  return d;
}

interface Setup {
  inv: Investigation;
  root: string;
  path: string;
  shas: string[];
  snapshot: Snapshot;
}

/** Eight commits; `state.txt` is `ok` up to `firstBad` excluded, `broken` afterwards. */
async function setup(firstBad = 5, count = 8, label: (i: number) => string = () => ""): Promise<Setup> {
  const commits = Array.from({ length: count }, (_, i) => ({
    files: {
      "state.txt": i < firstBad ? "ok\n" : "broken\n",
      "n.txt": `${i}\n`,
      "label.txt": label(i),
      ".gitignore": "cache.bin\n",
      ...(label(i) === "late" ? { "late.txt": "x\n" } : {}),
    },
    message: `commit ${i}`,
  }));
  const { path, shas } = await makeRepo({ commits });
  const root = await tmp();
  const inv = createInvestigation(root);
  inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
  const base = await tmp();
  open.push({ inv, base });
  const snapshot = await openSnapshot(inv, "r1", shas[count - 1]!, [], base);
  return { inv, root, path, shas, snapshot };
}

async function oracle(step: BisectStep): Promise<"good" | "bad"> {
  const state = await readFile(join(step.worktree, "state.txt"), "utf8");
  return state.startsWith("ok") ? "good" : "bad";
}

const head = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
const culprits = (inv: Investigation) => inv.evidence.filter((e) => e.subject?.outcome === "culprit");
const notes = (inv: Investigation) => inv.coverage.notExamined.join("\n");
const gitDir = async (cwd: string) => (await git(cwd, ["rev-parse", "--absolute-git-dir"])).stdout.trim();

/** Counter outside the repository: the script acts on the Nth visit of commit `n`. */
async function visits(): Promise<string> {
  const file = join(await tmp(), "visits.txt").split("\\").join("/");
  await writeFile(file, "0");
  return `const seen = Number(fs.readFileSync("${file}", "utf8"));`;
}

/** Test script: bad if `state.txt` says so, 125 or other according to `label.txt`. */
async function script(body = ""): Promise<string[]> {
  const file = join(await tmp(), "check.cjs");
  await writeFile(
    file,
    `const fs = require("fs");
const state = fs.readFileSync("state.txt", "utf8");
const label = fs.readFileSync("label.txt", "utf8");
console.log("checking " + state.trim());
${body}
process.exit(state.startsWith("ok") ? 0 : 1);
`,
  );
  return [process.execPath, file];
}

describe("assisted bisect", () => {
  it("assisted_bisect_finds_culprit", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(step.done).toBe(false);
    expect(step.worktree).toBe(snapshot.path);
    expect(step.testSha).toMatch(FULL_SHA);
    expect(step.remainingEstimate).toBeGreaterThan(0);

    while (!step.done) {
      expect(await head(snapshot.path)).toBe(step.testSha);
      expect(culprits(inv)).toEqual([]);
      const tested = step.testSha!;
      const answer = await oracle(step);
      const before = inv.evidence.length;
      step = await bisectAnswer(inv, snapshot, answer, tested);
      const added = inv.evidence[before]!;
      expect(added.kind).toBe("attestation");
      expect(added.subject).toEqual({ sha: tested, outcome: answer });
    }

    expect(step.culprit).toBe(shas[5]);
    expect(step.testSha).toBeUndefined();
    expect(step.remainingEstimate).toBe(0);
    const found = culprits(inv);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("attestation");
    expect(found[0]!.subject).toEqual({ sha: shas[5], outcome: "culprit" });
  });

  it("answer_after_end_is_refused_and_adds_no_culprit", async () => {
    const { inv, shas, snapshot } = await setup(2, 4);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[3]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    const count = inv.evidence.length;
    await expect(bisectAnswer(inv, snapshot, "bad", shas[3]!)).rejects.toThrow(/bisect/i);
    expect(inv.evidence).toHaveLength(count);
  });

  it("untested_bad_bound_gives_no_culprit", async () => {
    const { inv, shas, snapshot } = await setup(7);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, "good", step.testSha!);
    expect(step.done).toBe(true);
    expect(step.culprit).toBeUndefined();
    expect(step.possibleCommits).toEqual([shas[7]]);
    expect(step.instruction).toMatch(/[Aa]ttest/);
    expect(step.instruction).not.toContain(shas[7]!.slice(0, 7));
    expect(culprits(inv)).toEqual([]);
    expect(notes(inv)).toContain(shas[7]!.slice(0, 12));
  });

  it("attested_bad_bound_gives_a_culprit", async () => {
    const { inv, shas, snapshot } = await setup(7);
    await recordAttestation(inv, { statement: "broken", version: "1", sha: shas[7]!, outcome: "bad", kind: "tested" }, "r1");
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, "good", step.testSha!);
    expect(step.culprit).toBe(shas[7]);
    expect(culprits(inv)[0]!.data).toMatchObject({ parentsTested: true });
  });

  it("culprit_data_records_bounds_and_untested_parent", async () => {
    const { inv, shas, snapshot } = await setup(1);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(step.culprit).toBe(shas[1]);
    const data = culprits(inv)[0]!.data as { limits: string[] };
    expect(data).toMatchObject({ parentsTested: false, goodBound: shas[0], badBound: shas[7], command: null });
    expect(data.limits.join(" ")).toMatch(/Caches.*daemons/);
    expect(notes(inv)).toContain(shas[0]!.slice(0, 12));
  });

  it("expected_sha_mismatch_is_refused", async () => {
    const { inv, shas, snapshot } = await setup();
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await expect(bisectAnswer(inv, snapshot, "bad", shas[1]!)).rejects.toThrow(/expectedSha/);
    await expect(bisectAnswer(inv, snapshot, "bad", undefined as unknown as string)).rejects.toThrow(/expectedSha/);
    expect(inv.evidence).toEqual([]);
  });

  it("concurrent_answers_are_refused", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const answers = await Promise.allSettled([
      bisectAnswer(inv, snapshot, "bad", step.testSha!),
      bisectAnswer(inv, snapshot, "bad", step.testSha!),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = answers.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/busy/);
    expect(inv.evidence).toHaveLength(1);
  });

  it("assisted_commit_is_shown_clean_with_copy_files", async () => {
    const { inv, path, shas } = await setup();
    await writeFile(join(path, "local.env"), "secret=1\n");
    const snapshot = await openSnapshot(inv, "r1", shas[7]!, ["local.env"], open[0]!.base);
    await rm(join(path, "local.env"));

    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(await readFile(join(snapshot.path, "local.env"), "utf8")).toBe("secret=1\n");
    await writeFile(join(snapshot.path, "cache.bin"), "stale");
    await writeFile(join(snapshot.path, "junk.txt"), "stale");
    await writeFile(join(snapshot.path, "local.env"), "tampered");
    step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(existsSync(join(snapshot.path, "cache.bin"))).toBe(false);
    expect(existsSync(join(snapshot.path, "junk.txt"))).toBe(false);
    expect(await readFile(join(snapshot.path, "local.env"), "utf8")).toBe("secret=1\n");
  });

  it("new_bisect_supersedes_earlier_culprit", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    const first = culprits(inv)[0]!;
    expect(first.superseded).toBeUndefined();
    await recordAttestation(inv, { statement: "good", version: "1", sha: shas[0]!, outcome: "good", kind: "tested", intermittent: false }, "r1");
    const good = inv.evidence.at(-1)!;
    inv.coverage.examined.push("bisect");
    const verdict: Verdict = {
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: good.id,
      candidates: [{ sha: step.culprit!, evidenceIds: [first.id] }],
      fixes: [],
      noProposedFixReason: "test",
      observed: [],
      inferred: [],
      unknown: [],
    };
    expect(validateVerdict(inv, verdict)).toEqual({ ok: true });

    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(first.superseded).toBe(true);
    expect(validateVerdict(inv, verdict)).toEqual({ ok: false, errors: ["TEST_REQUIRED"] });
    await bisectAbort(inv, snapshot);

    await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(`process.exit(200);`), 60_000);
    expect(first.superseded).toBe(true);
  });

  it("refused_or_unaccepted_bisect_supersedes_nothing", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    const first = culprits(inv)[0]!;

    await expect(bisectStart(inv, snapshot, shas[7]!, shas[0]!)).rejects.toThrow(/ancestor/);
    await expect(bisectStart(inv, snapshot, shas[6]!, shas[7]!)).rejects.toThrow(/direct parent/);
    await writeFile(join(snapshot.path, "state.txt"), "edited\n");
    await expect(bisectStart(inv, snapshot, shas[0]!, shas[7]!)).rejects.toThrow(/modified/);
    await git(snapshot.path, ["checkout", "--", "state.txt"]);
    await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(`process.exit(1);`), 60_000);
    expect(first.superseded).toBeUndefined();
  });

  it("bisect_supersedes_only_its_own_repo", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    const first = culprits(inv)[0]!;

    const other = await makeRepo({
      commits: [0, 1, 2].map((i) => ({ files: { "state.txt": "ok\n", "n.txt": `${i}\n` }, message: `c${i}` })),
    });
    inv.repos.push({ repoId: "r2", path: other.path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
    const snapshot2 = await openSnapshot(inv, "r2", other.shas[2]!, [], open[0]!.base);
    await bisectStart(inv, snapshot2, other.shas[0]!, other.shas[2]!);
    expect(first.superseded).toBeUndefined();
    await bisectAbort(inv, snapshot2);

    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(first.superseded).toBe(true);
  });

  it("a_linked_worktree_outside_the_folder_is_never_cleaned", async () => {
    const { inv, path, shas } = await setup();
    const outside = join(await tmp(), "elsewhere");
    await git(path, ["worktree", "add", "-q", "--detach", outside, shas[7]!]);
    await writeFile(join(outside, "junk.txt"), "precious\n");
    const forged: Snapshot = { path: outside, repoId: "r1", ref: "main" };
    inv.snapshots.push(forged);

    await expect(bisectStart(inv, forged, shas[0]!, shas[7]!)).rejects.toThrow(/refused/);
    await expect(bisectAuto(inv, forged, shas[0]!, shas[7]!, await script(), 5000)).rejects.toThrow(/refused/);
    await expect(bisectAnswer(inv, forged, "good", shas[7]!)).rejects.toThrow(/refused/);
    await expect(bisectAbort(inv, forged)).rejects.toThrow(/refused/);
    // Without a given folder, the default one applies, never none.
    await expect(rawStart(inv, forged, shas[0]!, shas[7]!, { scenario: "s", reuseAnswers: false })).rejects.toThrow(/refused/);

    expect(await readFile(join(outside, "junk.txt"), "utf8")).toBe("precious\n");
    inv.snapshots = inv.snapshots.filter((s) => s !== forged);
    await git(path, ["worktree", "remove", "--force", outside]);
  });

  it("a_later_culprit_clears_the_failed_attempts_of_its_repo_only", async () => {
    const { inv, shas, snapshot } = await setup();
    inv.coverage.notExamined.push("module b");
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectAbort(inv, snapshot);
    expect(notes(inv)).toMatch(/abandoned/);

    const other = await makeRepo({
      commits: [0, 1, 2].map((i) => ({ files: { "state.txt": "ok\n", "n.txt": `${i}\n` }, message: `c${i}` })),
    });
    inv.repos.push({ repoId: "r2", path: other.path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
    const snapshot2 = await openSnapshot(inv, "r2", other.shas[2]!, [], baseOf(inv));
    await bisectStart(inv, snapshot2, other.shas[0]!, other.shas[2]!);
    await bisectAbort(inv, snapshot2);

    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);

    expect(step.culprit).toBe(shas[5]);
    const left = inv.coverage.notExamined.filter((n) => n.includes("abandoned"));
    expect(left).toHaveLength(1);
    expect(left[0]).toContain("r2");
    expect(notes(inv)).toContain("module b");
  });

  it("an_auto_culprit_clears_the_failed_attempts", async () => {
    const { inv, shas, snapshot } = await setup();
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await bisectAbort(inv, snapshot);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 60_000);
    expect(step.culprit).toBe(shas[5]);
    expect(notes(inv)).not.toMatch(/abandoned/);
  });

  it("ordinary_repo_is_never_cleaned", async () => {
    const { inv, path, shas } = await setup();
    const forged: Snapshot = { path, repoId: "r1", ref: "main" };
    inv.snapshots.push(forged);
    await writeFile(join(path, "cache.bin"), "precious\n");
    await writeFile(join(path, "junk.txt"), "precious\n");
    await writeFile(join(path, "label.txt"), "wip\n");
    const before = await head(path);

    // The copies folder contains this repository: it is the linked worktree check that must refuse.
    const folder = dirname(path);
    await expect(rawStart(inv, forged, shas[0]!, shas[7]!, { scenario: "s", reuseAnswers: false }, folder)).rejects.toThrow(/worktree/);
    await expect(rawAuto(inv, forged, shas[0]!, shas[7]!, await script(), 5000, undefined, folder)).rejects.toThrow(/worktree/);
    await git(path, ["stash", "-q"]);
    await git(path, ["bisect", "start", shas[7]!, shas[0]!, "--"]);
    await git(path, ["stash", "pop", "-q"]);
    const tested = await head(path);
    await expect(rawAnswer(inv, forged, "good", tested, folder)).rejects.toThrow(/worktree/);
    await expect(rawAbort(inv, forged, folder)).rejects.toThrow(/worktree/);

    expect(await readFile(join(path, "cache.bin"), "utf8")).toBe("precious\n");
    expect(await readFile(join(path, "junk.txt"), "utf8")).toBe("precious\n");
    expect(await readFile(join(path, "label.txt"), "utf8")).toBe("wip\n");
    await git(path, ["checkout", "-q", "--", "label.txt"]);
    await git(path, ["bisect", "reset"]);
    expect(await head(path)).toBe(before);
    inv.snapshots = inv.snapshots.filter((s) => s !== forged);
  });

  it("abort_ends_a_stuck_bisect", async () => {
    const { inv, shas, snapshot } = await setup();
    await expect(bisectAbort(inv, snapshot)).rejects.toThrow(/No bisect/);
    const start = await head(snapshot.path);
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await git(snapshot.path, ["checkout", "-q", "--detach", shas[1]!]);
    const step = await bisectAbort(inv, snapshot);
    expect(step).toMatchObject({ done: true, worktree: snapshot.path, remainingEstimate: 0 });
    expect(step.culprit).toBeUndefined();
    expect(await head(snapshot.path)).toBe(start);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
    expect(culprits(inv)).toEqual([]);
    await expect(bisectStart(inv, snapshot, shas[0]!, shas[7]!)).resolves.toMatchObject({ done: false });
  });

  it("failing_reset_writes_no_culprit", async () => {
    const { inv, shas, snapshot } = await setup(1, 3);
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[2]!);
    const lock = join(await gitDir(snapshot.path), "index.lock");
    await writeFile(lock, "");
    await expect(bisectAnswer(inv, snapshot, "bad", step.testSha!)).rejects.toThrow(/reset/);
    expect(culprits(inv)).toEqual([]);
    await rm(lock);
    await bisectAbort(inv, snapshot);
  });

  it("skip_is_supported", async () => {
    const { inv, shas, snapshot } = await setup(6);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    const skipped = step.testSha!;
    expect([shas[5], shas[6]]).not.toContain(skipped);
    const before = inv.evidence.length;
    step = await bisectAnswer(inv, snapshot, "skip", skipped);
    expect(step.done).toBe(false);
    expect(step.testSha).not.toBe(skipped);
    expect(inv.evidence.slice(before).every((e) => e.subject === undefined)).toBe(true);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(step.culprit).toBe(shas[6]);
  });

  it("skip_next_to_culprit_gives_no_culprit", async () => {
    const { inv, shas, snapshot } = await setup(4);
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    // The real culprit (4) is ignored: nothing allows telling it apart from the next one.
    while (!step.done) {
      const skip = step.testSha === shas[4];
      step = await bisectAnswer(inv, snapshot, skip ? "skip" : await oracle(step), step.testSha!);
    }
    expect(step.done).toBe(true);
    expect(step.culprit).toBeUndefined();
    expect(step.possibleCommits).toEqual(expect.arrayContaining([shas[4], shas[5]]));
    expect(culprits(inv)).toEqual([]);
    expect(inv.coverage.notExamined.join("\n")).toMatch(/undetermined/);
    expect(JSON.stringify(inv.evidence.at(-1)!.data)).toContain(shas[4]!);
  });

  it("assisted_survives_reload", async () => {
    const { inv, root, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    saveInvestigation(inv, root);

    const reloaded = loadInvestigation(inv.id, root);
    const snap = reloaded.snapshots[0]!;
    open.splice(0, 1, { inv: reloaded, base: open[0]!.base });
    while (!step.done) step = await bisectAnswer(reloaded, snap, await oracle(step), step.testSha!);

    expect(step.culprit).toBe(shas[5]);
    expect(culprits(reloaded)).toHaveLength(1);
  });

  it("refuses_bad_bounds", async () => {
    const { inv, path, shas, snapshot } = await setup();
    await expect(bisectStart(inv, snapshot, shas[7]!, shas[0]!)).rejects.toThrow(/ancestor/);
    await expect(bisectStart(inv, snapshot, shas[3]!, shas[3]!)).rejects.toThrow(/ancestor/);
    await expect(bisectStart(inv, snapshot, "--all", shas[7]!)).rejects.toThrow(/refused/);
    await expect(bisectStart(inv, snapshot, shas[0]!, "-x")).rejects.toThrow(/refused/);
    await expect(bisectStart(inv, snapshot, "nope", shas[7]!)).rejects.toThrow(/Unknown/);

    await git(path, ["checkout", "-q", "-b", "side", shas[2]!]);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "side"]);
    await expect(bisectStart(inv, snapshot, "side", shas[7]!)).rejects.toThrow(/ancestor/);
    expect(inv.evidence).toEqual([]);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
  });

  it("direct_child_has_nothing_to_bisect_without_test", async () => {
    const { inv, shas, snapshot } = await setup();
    await expect(bisectStart(inv, snapshot, shas[6]!, shas[7]!)).rejects.toThrow(/direct parent/);
    expect(culprits(inv)).toEqual([]);
  });

  it("refuses_second_start_while_active", async () => {
    const { inv, shas, snapshot } = await setup();
    await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await expect(bisectStart(inv, snapshot, shas[0]!, shas[7]!)).rejects.toThrow(/in progress/);
  });

  it("refuses_a_snapshot_outside_the_investigation", async () => {
    const { inv, path, shas, snapshot } = await setup();
    const foreign: Snapshot = { path, repoId: "r1", ref: "main" };
    const before = await head(path);
    await expect(bisectStart(inv, foreign, shas[0]!, shas[7]!)).rejects.toThrow(/working copy/);
    await expect(bisectAnswer(inv, foreign, "bad", shas[1]!)).rejects.toThrow(/working copy/);
    await expect(bisectAuto(inv, foreign, shas[0]!, shas[7]!, await script(), 5000)).rejects.toThrow(/working copy/);
    expect(await head(path)).toBe(before);
    expect(snapshot.path).not.toBe(path);
  });

  it("refuses_unknown_answer", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await expect(bisectAnswer(inv, snapshot, "culprit" as "bad", step.testSha!)).rejects.toThrow(/Unknown answer/);
    expect(inv.evidence).toEqual([]);
  });

  it("refuses_answer_when_worktree_left_the_tested_commit", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await git(snapshot.path, ["checkout", "-q", "--detach", shas[1]!]);
    await expect(bisectAnswer(inv, snapshot, "bad", step.testSha!)).rejects.toThrow(/commit to test/);
    expect(inv.evidence).toEqual([]);
  });

  it("refuses_answer_when_tracked_file_is_modified", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    await writeFile(join(snapshot.path, "state.txt"), "edited\n");
    await expect(bisectAnswer(inv, snapshot, "bad", step.testSha!)).rejects.toThrow(/modified/);
    expect(inv.evidence).toEqual([]);
  });

  it("checkout_failure_never_lets_next_answer_hit_the_wrong_commit", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    // The lock makes the commit change fail, after git has noted the answer.
    const lock = join(await gitDir(snapshot.path), "index.lock");
    await writeFile(lock, "");
    await expect(bisectAnswer(inv, snapshot, "good", step.testSha!)).rejects.toThrow(/commit to test|failed/);
    expect(inv.evidence.map((e) => e.subject)).toEqual([{ sha: step.testSha, outcome: "good" }]);
    await rm(lock);

    // git noted the answer but HEAD stayed: the next one would target the wrong commit.
    await expect(bisectAnswer(inv, snapshot, "bad", step.testSha!)).rejects.toThrow(/commit to test/);
    expect(inv.evidence).toHaveLength(1);
    expect(culprits(inv)).toEqual([]);
    await bisectAbort(inv, snapshot);
  });

  it("culprit_passes_verdict_validation", async () => {
    const { inv, shas, snapshot } = await setup();
    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    await recordAttestation(inv, { statement: "good", version: "1.0", sha: shas[0]!, outcome: "good", kind: "tested", intermittent: false }, "r1");
    inv.coverage.examined.push("bisect");
    const culprit = culprits(inv)[0]!;
    const good = inv.evidence.at(-1)!;
    const verdict: Verdict = {
      origin: "PROVEN_REGRESSION",
      goodStateEvidenceId: good.id,
      candidates: [{ sha: step.culprit!, evidenceIds: [culprit.id] }],
      fixes: [],
      noProposedFixReason: "test",
      observed: [],
      inferred: [],
      unknown: [],
    };
    expect(validateVerdict(inv, verdict)).toEqual({ ok: true });
  });
});

describe("automatic bisect", () => {
  it("auto_bisect_finds_culprit", async () => {
    const { inv, shas, snapshot } = await setup();
    const command = await script();
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step).toMatchObject({ done: true, culprit: shas[5], stoppedByBudget: false, remainingEstimate: 0 });

    const found = culprits(inv);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("execution");
    expect(found[0]!.untrusted).toBe(true);
    expect(found[0]!.subject).toEqual({ sha: shas[5], outcome: "culprit" });
    expect(found[0]!.data).toMatchObject({ command, stdout: expect.stringContaining("checking broken") });

    const tested = inv.evidence.filter((e) => e.subject && e.subject.outcome !== "culprit");
    expect(tested.every((e) => e.kind === "execution" && FULL_SHA.test(e.subject!.sha))).toBe(true);
    expect(tested).toContainEqual(expect.objectContaining({ subject: { sha: shas[0], outcome: "good" } }));
    expect(tested).toContainEqual(expect.objectContaining({ subject: { sha: shas[7], outcome: "bad" } }));
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
  });

  it("auto_handles_direct_child", async () => {
    const { inv, shas, snapshot } = await setup(7);
    const step = await bisectAuto(inv, snapshot, shas[6]!, shas[7]!, await script(), 60_000);
    expect(step.culprit).toBe(shas[7]);
    expect(culprits(inv)[0]!.kind).toBe("execution");
  });

  it("auto_truncates_output", async () => {
    const { inv, shas, snapshot } = await setup(1, 2);
    const command = await script(`console.log("x".repeat(100000)); console.log("END");`);
    await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000);
    const data = culprits(inv)[0]!.data as { stdout: string };
    expect(data.stdout.length).toBeLessThan(25_000);
    expect(data.stdout).toContain("END");
    expect(data.stdout).toContain("[truncated]");
  });

  it("auto_exit_125_skips", async () => {
    const { inv, shas, snapshot } = await setup(5, 8, (i) => (i === 2 || i === 3 ? "skip" : ""));
    const command = await script(`if (label === "skip") process.exit(125);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.culprit).toBe(shas[5]);
    const onSkipped = (sha?: string) => sha === shas[2] || sha === shas[3];
    expect(inv.evidence.some((e) => onSkipped(e.subject?.sha))).toBe(false);
    expect(inv.evidence.some((e) => (e.data as { exitCode?: number }).exitCode === 125)).toBe(true);
  });

  it("auto_exit_125_everywhere_gives_no_culprit", async () => {
    const { inv, shas, snapshot } = await setup(4, 8, (i) => (i >= 1 && i <= 6 ? "skip" : ""));
    const command = await script(`if (label === "skip") process.exit(125);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step).toMatchObject({ done: true, stoppedByBudget: false });
    expect(step.culprit).toBeUndefined();
    expect(step.possibleCommits).toHaveLength(7);
    expect(culprits(inv)).toEqual([]);
    expect(inv.coverage.notExamined.join("\n")).toMatch(/undetermined/);
  });

  it("auto_broken_command_never_blames_a_commit", async () => {
    const { inv, shas, snapshot } = await setup();
    const command = await script(`process.exit(1);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.done).toBe(false);
    expect(step.culprit).toBeUndefined();
    expect(step.stopReason).toMatch(/good/);
    expect(culprits(inv)).toEqual([]);
    expect(inv.evidence.some((e) => e.subject?.outcome === "good")).toBe(false);
  });

  it("auto_command_passing_everywhere_never_blames_a_commit", async () => {
    const { inv, shas, snapshot } = await setup();
    const command = await script(`process.exit(0);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.done).toBe(false);
    expect(step.culprit).toBeUndefined();
    expect(culprits(inv)).toEqual([]);
  });

  it("auto_stops_on_exit_128_or_more", async () => {
    const { inv, shas, snapshot } = await setup(5, 8, (i) => (i > 0 && i < 7 ? "crash" : ""));
    const command = await script(`if (label === "crash") process.exit(200);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: false });
    expect(step.culprit).toBeUndefined();
    expect(culprits(inv)).toEqual([]);
    expect(inv.coverage.notExamined.join("\n")).toMatch(/200/);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
  });

  it("auto_stops_on_spawn_failure", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, [join(await tmp(), "nothing-here")], 60_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: false });
    expect(culprits(inv)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("auto_stops_on_signal", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(`process.kill(process.pid, "SIGKILL");`), 60_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: false });
    expect(culprits(inv)).toEqual([]);
  });

  it("auto_budget_stops_cleanly", async () => {
    const { inv, shas, snapshot } = await setup(5, 8, (i) => (i > 0 && i < 7 ? "slow" : ""));
    // A grandchild keeps stdout open: killing only the direct process would leave the call blocked.
    const command = await script(`if (label === "slow") {
  require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "inherit" });
  setTimeout(() => {}, 120000);
  return;
}`);
    const started = Date.now();
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 6000);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: true });
    expect(step.culprit).toBeUndefined();
    expect(culprits(inv)).toEqual([]);
    expect(inv.coverage.notExamined.join("\n")).toMatch(/budget/);
    // The killed process does not count as a test: only the two bounds have a result.
    expect(inv.evidence.filter((e) => e.subject)).toHaveLength(2);
    expect((await git(snapshot.path, ["for-each-ref", "refs/bisect/"])).stdout).toBe("");
  });

  it("auto_budget_exhausted_before_any_step", async () => {
    const { inv, shas, snapshot } = await setup();
    await expect(bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 0)).rejects.toThrow(/budget/i);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 1);
    expect(step.stoppedByBudget).toBe(true);
    expect(culprits(inv)).toEqual([]);
  });

  it("auto_stale_output_does_not_reach_the_next_run", async () => {
    const { inv, shas, snapshot } = await setup();
    // Without cleanup, the ignored file left by one test makes all the following ones fail.
    const command = await script(`if (fs.existsSync("cache.bin") || fs.existsSync("junk.txt")) process.exit(1);
fs.writeFileSync("cache.bin", "stale");
fs.writeFileSync("junk.txt", "stale");`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.culprit).toBe(shas[5]);
    expect(existsSync(join(snapshot.path, "cache.bin"))).toBe(false);
    expect(existsSync(join(snapshot.path, "junk.txt"))).toBe(false);
    expect((culprits(inv)[0]!.data as { limits: string[] }).limits.join(" ")).toMatch(/Caches.*daemons/);
  });

  it("auto_keeps_copy_files_at_every_run", async () => {
    const { inv, path, shas } = await setup();
    await writeFile(join(path, "local.env"), "x\n");
    const snapshot = await openSnapshot(inv, "r1", shas[7]!, ["local.env"], open[0]!.base);
    await rm(join(path, "local.env"));
    const command = await script(`if (fs.readFileSync("local.env", "utf8") !== "x\\n") process.exit(1);
fs.writeFileSync("local.env", "tampered");`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.culprit).toBe(shas[5]);
    expect(await readFile(join(snapshot.path, "local.env"), "utf8")).toBe("x\n");
  });

  it("auto_exit_126_and_127_stop", async () => {
    for (const code of [126, 127]) {
      const { inv, shas, snapshot } = await setup(5, 8, (i) => (i > 0 && i < 7 ? "missing" : ""));
      const command = await script(`if (label === "missing") process.exit(${code});`);
      const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
      expect(step).toMatchObject({ done: false, stoppedByBudget: false });
      expect(culprits(inv)).toEqual([]);
      expect(notes(inv)).toContain(String(code));
    }
  });

  it("expected_failure_treats_other_failures_as_skip", async () => {
    const { inv, shas, snapshot } = await setup(6, 8, (i) => (i === 3 || i === 4 ? "network" : ""));
    const body = `if (label === "network") { console.error("network down"); process.exit(1); }
if (!state.startsWith("ok")) console.log("BUG-42 reproduced");`;
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(body), 60_000, "BUG-42");
    expect(step.culprit).toBe(shas[6]);
    expect(inv.evidence.some((e) => e.subject?.outcome === "bad" && [shas[3], shas[4]].includes(e.subject.sha))).toBe(false);
    expect(culprits(inv)[0]!.data).toMatchObject({ expectedFailure: "BUG-42" });
  });

  it("expected_failure_absent_on_bad_bound_stops", async () => {
    const { inv, shas, snapshot } = await setup();
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 60_000, "BUG-42");
    expect(step.done).toBe(false);
    expect(culprits(inv)).toEqual([]);
    await expect(bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 60_000, "")).rejects.toThrow(/expectedFailure/);
  });

  it("confirmation_fails_when_culprit_passes_on_rerun", async () => {
    const { inv, shas, snapshot } = await setup();
    const count = await visits();
    const counter = count.match(/"([^"]+)"/)![1]!;
    const command = await script(`${count}
if (fs.readFileSync("n.txt", "utf8").trim() === "5") {
  fs.writeFileSync("${counter}", String(seen + 1));
  if (seen === 1) process.exit(0);
}`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: false, stopReason: "confirmation_failed" });
    expect(step.culprit).toBeUndefined();
    expect(culprits(inv)).toEqual([]);
    expect(notes(inv)).toMatch(/confirmation/);
  });

  it("confirmation_fails_when_parent_fails_on_rerun", async () => {
    const { inv, shas, snapshot } = await setup();
    const count = await visits();
    const counter = count.match(/"([^"]+)"/)![1]!;
    const command = await script(`${count}
if (fs.readFileSync("n.txt", "utf8").trim() === "4") {
  fs.writeFileSync("${counter}", String(seen + 1));
  if (seen === 1) process.exit(1);
}`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.stopReason).toBe("confirmation_failed");
    expect(culprits(inv)).toEqual([]);
  });

  it("confirmation_fails_on_other_exit_code_than_bad_bound", async () => {
    const { inv, shas, snapshot } = await setup(5, 8, (i) => (i === 7 ? "bound" : ""));
    const command = await script(`if (!state.startsWith("ok") && label !== "bound") process.exit(2);`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.stopReason).toBe("confirmation_failed");
    expect(culprits(inv)).toEqual([]);
  });

  it("confirmation_covers_every_parent_of_a_merge", async () => {
    const { path, shas } = await makeRepo({
      commits: [
        { files: { "state.txt": "ok\n", "label.txt": "", "n.txt": "0" }, message: "base" },
        { files: { "n.txt": "1" }, message: "main" },
      ],
    });
    await git(path, ["checkout", "-q", "-b", "side", shas[0]!]);
    await writeFile(join(path, "side.txt"), "s");
    await git(path, ["add", "-A"]);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", "side"]);
    await git(path, ["checkout", "-q", "main"]);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e", "merge", "-q", "--no-ff", "--no-commit", "side"]);
    await writeFile(join(path, "state.txt"), "broken\n");
    await git(path, ["add", "-A"]);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "-m", "merge"]);
    const merge = await head(path);
    const inv = createInvestigation(await tmp());
    inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
    const base = await tmp();
    open.push({ inv, base });
    const snapshot = await openSnapshot(inv, "r1", merge, [], base);
    const step = await bisectAuto(inv, snapshot, shas[0]!, merge, await script(), 60_000);
    expect(step.culprit).toBe(merge);
    const side = (await git(path, ["rev-parse", "side"])).stdout.trim();
    const goods = inv.evidence.filter((e) => e.subject?.outcome === "good").map((e) => e.subject!.sha);
    expect(goods).toEqual(expect.arrayContaining([shas[1], side]));
  });

  it.runIf(process.platform === "win32")("windows_killed_process_reads_as_exit_1_and_confirmation_catches_it", async () => {
    // No faulty commit before 7: the first middle commit is killed once, and git thinks it is bad.
    const { inv, shas, snapshot } = await setup(7, 8, (i) => (i > 0 && i < 7 ? "once" : ""));
    const count = await visits();
    const counter = count.match(/"([^"]+)"/)![1]!;
    const command = await script(`${count}
if (label === "once" && seen === 0) {
  fs.writeFileSync("${counter}", "1");
  require("child_process").execFileSync("taskkill", ["/pid", String(process.pid), "/F"], { stdio: "ignore" });
  setTimeout(() => {}, 60000);
  return;
}`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    // Code 1 is indistinguishable from a real failure: only the confirmation avoids the false culprit.
    expect(inv.evidence.some((e) => (e.data as { exitCode?: number }).exitCode === 1 && e.subject?.outcome === "bad" && e.subject.sha !== shas[7])).toBe(true);
    expect(step.stopReason).toBe("confirmation_failed");
    expect(culprits(inv)).toEqual([]);
  });

  it.runIf(process.platform === "win32")("windows_limit_is_disclosed_in_culprit_data", async () => {
    const { inv, shas, snapshot } = await setup(1, 2);
    await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, await script(), 60_000);
    expect((culprits(inv)[0]!.data as { limits: string[] }).limits.join(" ")).toMatch(/Windows.*code 1/);
  });

  it("answer_is_refused_during_auto", async () => {
    const { inv, shas, snapshot } = await setup(5, 8, (i) => (i === 7 ? "slow" : ""));
    const command = await script(`if (label === "slow") setTimeout(() => process.exit(1), 2000); else process.exit(0);
return;`);
    const running = bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    await new Promise((r) => setTimeout(r, 200));
    await expect(bisectAnswer(inv, snapshot, "bad", shas[1]!)).rejects.toThrow(/busy/);
    await running;
  });

  it("environment_secrets_are_removed_and_redacted", async () => {
    const names = ["GITLAB_TOKEN", "JIRA_API_TOKEN", "JIRA_EMAIL", "RT_MY_SECRET", "RT_PASSWORD_X", "RT_API_KEY"];
    const value = "s3cr3t-value-for-test";
    for (const n of names) process.env[n] = `${value}-${n}`;
    process.env.RT_PLAIN = "visible-value";
    try {
      const { inv, shas, snapshot } = await setup(1, 2);
      const leaked = names.map((n) => `${value}-${n}`);
      const command = await script(`console.log(JSON.stringify(${JSON.stringify(names)}.map((n) => process.env[n] ?? null)));
console.log("plain=" + process.env.RT_PLAIN);
console.error(${JSON.stringify(leaked)}.join(" "));`);
      await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000);
      const data = culprits(inv)[0]!.data as { stdout: string; stderr: string };
      expect(data.stdout).toContain(JSON.stringify(names.map(() => null)));
      expect(data.stdout).toContain("plain=visible-value");
      expect(data.stderr).toContain("[redacted]");
      expect(JSON.stringify(inv.evidence)).not.toContain(value);
    } finally {
      for (const n of [...names, "RT_PLAIN"]) delete process.env[n];
    }
  });

  it("session_cookie_is_redacted_from_command_output", async () => {
    const secret = "session-value-secret";
    const session = sessionFor(
      async () => ({ ok: true, cookies: [{ name: "JSESSIONID", value: secret, domain: "jira.corp.example" }] }),
      "https://jira.corp.example",
    );
    await session.acquire(1000);
    try {
      const { inv, shas, snapshot } = await setup(1, 2);
      const command = await script(`console.log(${JSON.stringify(secret)}); process.exit(1);`);
      await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000);
      expect(JSON.stringify(inv)).not.toContain(secret);
    } finally {
      session.drop();
    }
  });

  it("secret_in_argv_appears_nowhere_in_the_evidence", async () => {
    const secret = "s3cr3t-value-123456";
    process.env.RT_API_KEY = secret;
    try {
      const { inv, shas, snapshot } = await setup(1, 2);
      const command = [...(await script(`console.log(process.argv.join(" "));`)), `--token=${secret}`];
      const step = await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000, `--token=${secret}`);
      expect(step.culprit).toBe(shas[1]);
      expect(culprits(inv)[0]!.data).toMatchObject({ expectedFailure: "--token=[redacted]" });
      expect((culprits(inv)[0]!.data as { command: string[] }).command.at(-1)).toBe("--token=[redacted]");
      expect(JSON.stringify(inv)).not.toContain(secret);

      await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, [join(await tmp(), "absent"), `--token=${secret}`], 60_000);
      expect(JSON.stringify(inv)).not.toContain(secret);
    } finally {
      delete process.env.RT_API_KEY;
    }
  });

  it("short_sensitive_value_does_not_destroy_the_record", async () => {
    process.env.RT_SHORT_KEY = "1234567";
    try {
      const { inv, shas, snapshot } = await setup(1, 2);
      const command = [...(await script(`console.log("build 1234567 done");`)), "--level=1234567"];
      await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000);
      const data = culprits(inv)[0]!.data as { stdout: string; command: string[] };
      expect(data.stdout).toContain("build 1234567 done");
      expect(data.command.at(-1)).toBe("--level=1234567");
    } finally {
      delete process.env.RT_SHORT_KEY;
    }
  });

  it("failing_status_stops_and_failed_restore_keeps_the_result", async () => {
    const { inv, shas, snapshot } = await setup();
    const command = await script(`const dir = fs.readFileSync(".git", "utf8").slice(8).trim();
fs.writeFileSync(dir + "/index", "garbage");`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step).toMatchObject({ done: false, stoppedByBudget: false });
    expect(step.stopReason).toBeTruthy();
    expect(culprits(inv)).toEqual([]);
    expect(notes(inv)).toMatch(/restoring the copy|stopped/);
  });

  it("auto_stops_when_command_changes_a_tracked_file", async () => {
    const { inv, shas, snapshot } = await setup();
    const command = await script(`fs.writeFileSync("n.txt", "changed");`);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, command, 60_000);
    expect(step.stopReason).toMatch(/modified/);
    expect(culprits(inv)).toEqual([]);
  });

  it("auto_refuses_invalid_command", async () => {
    const { inv, shas, snapshot } = await setup();
    await expect(bisectAuto(inv, snapshot, shas[0]!, shas[7]!, [], 1000)).rejects.toThrow(/Invalid command/);
    await expect(bisectAuto(inv, snapshot, shas[0]!, shas[7]!, [""], 1000)).rejects.toThrow(/Invalid command/);
    await expect(bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), Number.NaN)).rejects.toThrow(/budget/i);
  });

  it("auto_does_not_use_a_shell", async () => {
    const { inv, shas, snapshot } = await setup(1, 2);
    const marker = join(await tmp(), "injected");
    const command = [...(await script()), `; echo pwned > ${marker}`, `$(echo pwned > ${marker})`];
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[1]!, command, 60_000);
    expect(step.culprit).toBe(shas[1]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("user's repository", () => {
  it("user_repo_untouched", async () => {
    const { inv, path, shas, snapshot } = await setup();
    await git(path, ["checkout", "-q", "-b", "work", shas[3]!]);
    await writeFile(join(path, "n.txt"), "wip\n");
    await writeFile(join(path, "new.txt"), "untracked\n");
    const look = async () => ({
      status: (await git(path, ["status", "--porcelain"])).stdout,
      head: await head(path),
      branch: (await git(path, ["symbolic-ref", "HEAD"])).stdout,
      bisect: (await git(path, ["for-each-ref", "refs/bisect/"])).stdout,
      gitBisectLog: existsSync(join(path, ".git", "BISECT_LOG")),
    });
    const before = await look();
    expect(before.status).not.toBe("");

    let step = await bisectStart(inv, snapshot, shas[0]!, shas[7]!);
    expect(await look()).toEqual(before);
    step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(await look()).toEqual(before);
    while (!step.done) step = await bisectAnswer(inv, snapshot, await oracle(step), step.testSha!);
    expect(await look()).toEqual(before);

    await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 60_000);
    expect(await look()).toEqual(before);
    await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(`process.exit(200);`), 60_000);
    expect(await look()).toEqual(before);
  });

  it("user_bisect_in_progress_is_independent", async () => {
    const { inv, path, shas, snapshot } = await setup();
    await git(path, ["bisect", "start", shas[6]!, shas[1]!, "--"]);
    const before = (await git(path, ["for-each-ref", "refs/bisect/"])).stdout;
    const userHead = await head(path);
    const step = await bisectAuto(inv, snapshot, shas[0]!, shas[7]!, await script(), 60_000);
    expect(step.culprit).toBe(shas[5]);
    expect((await git(path, ["for-each-ref", "refs/bisect/"])).stdout).toBe(before);
    expect(await head(path)).toBe(userHead);
    await git(path, ["bisect", "reset"]);
  });
});

describe("attestations", () => {
  it("attestation_tested_vs_asserted", async () => {
    const { inv, shas } = await setup();
    const tested = await recordAttestation(
      inv,
      { statement: "bug vu", version: "3.2", sha: shas[4]!.slice(0, 10), outcome: "bad", kind: "tested" },
      "r1",
    );
    expect(tested.kind).toBe("attestation");
    expect(tested.subject).toEqual({ sha: shas[4], outcome: "bad" });
    expect(tested.data).toMatchObject({ statement: "bug vu", version: "3.2" });

    const asserted = await recordAttestation(inv, { statement: "it worked", version: "3.1", kind: "asserted" });
    expect(asserted.kind).toBe("claim");
    expect(asserted.subject).toBeUndefined();

    const withSha = await recordAttestation(inv, { statement: "x", version: "3.1", sha: shas[0]!, outcome: "good", kind: "asserted" });
    expect(withSha.kind).toBe("claim");
    expect(withSha.subject).toBeUndefined();
    expect(inv.intermittent).toBeNull();
  });

  it("tested_requires_sha_outcome_and_known_repo", async () => {
    const { inv, shas } = await setup();
    const a = { statement: "s", version: "1", kind: "tested" as const };
    await expect(recordAttestation(inv, { ...a, outcome: "bad" }, "r1")).rejects.toThrow(/sha/);
    await expect(recordAttestation(inv, { ...a, sha: shas[0]! }, "r1")).rejects.toThrow(/outcome|result/);
    await expect(recordAttestation(inv, { ...a, sha: shas[0]!, outcome: "bad" })).rejects.toThrow(/repoId|Unknown repository/);
    await expect(recordAttestation(inv, { ...a, sha: shas[0]!, outcome: "bad" }, "zz")).rejects.toThrow(/Unknown repository/);
    await expect(recordAttestation(inv, { ...a, sha: "-x", outcome: "bad" }, "r1")).rejects.toThrow(/refused/);
    await expect(recordAttestation(inv, { ...a, sha: "nope", outcome: "bad" }, "r1")).rejects.toThrow(/Unknown/);
    expect(inv.evidence).toEqual([]);
  });

  it("attestation_cannot_declare_a_culprit", async () => {
    const { inv, shas } = await setup();
    await expect(
      recordAttestation(inv, { statement: "s", version: "1", kind: "tested", sha: shas[0]!, outcome: "culprit" as "bad" }, "r1"),
    ).rejects.toThrow(/result/);
    expect(culprits(inv)).toEqual([]);
  });

  it("refuses_unknown_kind_and_blank_statement", async () => {
    const { inv } = await setup();
    await expect(recordAttestation(inv, { statement: "s", version: "1", kind: "other" as "tested" })).rejects.toThrow(/kind|type/);
    await expect(recordAttestation(inv, { statement: " ", version: "1", kind: "asserted" })).rejects.toThrow(/statement|Empty statement/);
  });

  it("intermittent_is_set_only_when_given", async () => {
    const { inv } = await setup();
    await recordAttestation(inv, { statement: "s", version: "1", kind: "asserted" });
    expect(inv.intermittent).toBeNull();
    await recordAttestation(inv, { statement: "s", version: "1", kind: "asserted", intermittent: false });
    expect(inv.intermittent).toBe(false);
    await recordAttestation(inv, { statement: "s", version: "1", kind: "asserted", intermittent: true });
    expect(inv.intermittent).toBe(true);
    await recordAttestation(inv, { statement: "s", version: "1", kind: "asserted" });
    expect(inv.intermittent).toBe(true);
  });

  it("refused_attestation_leaves_intermittent_alone", async () => {
    const { inv } = await setup();
    await expect(
      recordAttestation(inv, { statement: "s", version: "1", kind: "tested", sha: "nope", outcome: "bad", intermittent: false }, "r1"),
    ).rejects.toThrow();
    expect(inv.intermittent).toBeNull();
  });
});
