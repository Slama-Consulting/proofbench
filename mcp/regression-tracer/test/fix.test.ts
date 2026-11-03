import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const spy = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../src/git.js", async (original) => {
  const real = await original<typeof import("../src/git.js")>();
  return {
    ...real,
    git: (cwd: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => {
      spy.calls.push(args);
      return real.git(cwd, args, opts);
    },
  };
});

import { git } from "../src/git.js";
import { createInvestigation } from "../src/investigation.js";
import { resolveRepo } from "../src/repo.js";
import { checkFix, claimsFix, fetchRefs, readFixReading, scrubGitOutput, type TargetFinding } from "../src/fix.js";
import { HISTORY_TRUNCATED_NOTE } from "../src/verdict.js";
import { cleanupRepos, makeRepo, type CommitSpec } from "./helpers/repo.js";

const FAULTY = "crash(user!!)";
const GOOD = "if (user != null) crash(user)";
const body = (line: string, extra = "") =>
  ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", line, "eta", "theta", "iota", "kappa", "lambda", extra].join("\n") + "\n";

const dirs: string[] = [];
beforeEach(() => {
  spy.calls.length = 0;
});
afterEach(async () => {
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(commits: CommitSpec[], remote?: string, config: object = {}) {
  const { path, shas } = await makeRepo({ commits });
  if (remote) await git(path, ["remote", "add", "origin", remote]);
  const dir = await mkdtemp(join(tmpdir(), "rt-fix-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ repos: { [path]: config } }));
  const inv = createInvestigation(dir);
  const repo = await resolveRepo(inv, path, undefined, configPath);
  const deps = { env: {}, configPath, runGlab: async () => null };
  return { inv, repo, path, shas, deps };
}

function router(handlers: Array<[string, () => Response]>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const [frag, h] of handlers) if (String(url).includes(frag)) return h();
    return new Response("[]", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}
const json = (b: unknown) => () => new Response(JSON.stringify(b), { status: 200 });

const row = (targets: TargetFinding[], name: string) => {
  const found = targets.find((t) => t.target === name);
  if (!found) throw new Error(`no line ${name}`);
  return found;
};

/** c0 good, c1 culprit on main; release branches from c1. */
const FORKED: CommitSpec[] = [
  { files: { "a.kt": body("ok()") }, message: "init" },
  { files: { "a.kt": body(FAULTY) }, message: "add crash" },
  { files: { "r.txt": "r" }, message: "release only", branch: "release" },
];

describe("checkFix", () => {
  it("fix_on_main_absent_from_release: two lines, two results", async () => {
    const { inv, repo, shas, deps } = await setup([
      ...FORKED,
      { files: { "a.kt": body(GOOD) }, message: "fix crash", branch: "main" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main", "release"] }, deps);
    const main = row(r.targets, "main");
    const release = row(r.targets, "release");
    expect(main).toMatchObject({ kind: "branch", containsCulprit: true, faultyCodePresent: false });
    expect(main.candidateFixes).toEqual([{ sha: shas[3], subject: "fix crash", via: "history" }]);
    expect(release).toMatchObject({ kind: "branch", containsCulprit: true, faultyCodePresent: true, candidateFixes: [] });
  });

  it("culprit absent from the target: containsCulprit false, from the merge base", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init" },
      { files: { "a.kt": body(GOOD) }, message: "fix on old", branch: "old" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "culprit", branch: "main" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[2], file: "a.kt", faultySnippet: FAULTY, targets: ["old"] }, deps);
    expect(r.targets[0]).toMatchObject({ containsCulprit: false, faultyCodePresent: false });
    expect(r.targets[0].candidateFixes.map((c) => c.sha)).toEqual([shas[1]]);
  });

  it("cherry_picked_fix_detected: same patch-id, different sha", async () => {
    const { inv, repo, shas, deps } = await setup([
      ...FORKED,
      { files: { "a.kt": body(GOOD) }, message: "fix crash", branch: "main" },
      { files: { "a.kt": body(GOOD) }, message: "fix crash (cherry picked)", branch: "release" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main", "release"] }, deps);
    const release = row(r.targets, "release");
    expect(release.faultyCodePresent).toBe(false);
    expect(release.candidateFixes).toEqual([{ sha: shas[4], subject: "fix crash (cherry picked)", via: "patch_id" }]);
    const ok = await git(repo.path, ["merge-base", "--is-ancestor", shas[3], "release"]);
    expect(ok.code).toBe(1);
  });

  it("two unrelated commits on the same file are not linked by patch-id", async () => {
    const { inv, repo, shas, deps } = await setup([
      ...FORKED,
      { files: { "a.kt": body(GOOD) }, message: "fix crash", branch: "main" },
      { files: { "a.kt": body(FAULTY, "other") }, message: "unrelated", branch: "release" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main", "release"] }, deps);
    expect(row(r.targets, "release").candidateFixes.map((c) => c.via)).toEqual(["history"]);
    expect(row(r.targets, "main").candidateFixes.map((c) => c.via)).toEqual(["history"]);
  });

  it("squash_fix_found_in_history: the squash is found, not the branch commits", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body("ok()") }, message: "init" },
      { files: { "a.kt": body(FAULTY) }, message: "add crash" },
      { files: { "a.kt": body("step1()") }, message: "wip 1", branch: "feature" },
      { files: { "a.kt": body(GOOD) }, message: "wip 2", branch: "feature" },
      { files: { "a.kt": body(GOOD) }, message: "fix crash (squash)", branch: "main" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(false);
    expect(r.targets[0].candidateFixes).toEqual([{ sha: shas[4], subject: "fix crash (squash)", via: "history" }]);
  });

  it("open_mr_is_read_not_executed: metadata only, code never read", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED, "https://gitlab.com/g/p.git");
    const mine = { iid: 7, title: "Fix crash in a.kt", description: "", source_branch: "fix/x", state: "opened" };
    const other = { iid: 8, title: "Update readme", description: "", source_branch: "doc", state: "opened" };
    const { fetchFn, calls } = router([["/merge_requests", json([mine, other])]]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY }, {
      ...deps, env: { GITLAB_TOKEN: "tok-secret" }, fetchFn,
    });
    const mr = row(r.targets, "!7");
    expect(mr.kind).toBe("open_mr");
    expect(mr.faultyCodePresent).toBeUndefined();
    expect(mr.claimedBy.map((m) => m.iid)).toEqual([7]);
    expect(r.targets.find((t) => t.target === "!8")).toBeUndefined();
    expect(r.coverage.some((c) => c.startsWith("target:!7: "))).toBe(true);
    expect(inv.coverage.examined).not.toContain("target:!7");

    const args = spy.calls.flat().join(" ");
    expect(args).not.toContain("refs/merge-requests");
    expect(spy.calls.some((a) => a.includes("checkout") || a.includes("fetch") || a.includes("switch"))).toBe(false);
    expect(calls.every((c) => new URL(c.url).host === "gitlab.com" && c.init?.method === "GET")).toBe(true);
    expect(JSON.stringify({ r, ev: inv.evidence })).not.toContain("tok-secret");
    const ev = inv.evidence.find((e) => JSON.stringify(e.data).includes("Fix crash in a.kt"))!;
    expect(ev.kind).toBe("code_reading");
    expect(ev.untrusted).toBe(true);
    expect(ev.subject).toBeUndefined();
  });

  it("open MR linked by the culprit ticket, or by the log text", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body("ok()") }, message: "init" },
      { files: { "a.kt": body(FAULTY) }, message: "add crash\n\nrefs: PROJ-12" },
    ], "https://gitlab.com/g/p.git");
    const byTicket = { iid: 1, title: "Patch", description: "", source_branch: "feature/PROJ-12-x", state: "opened" };
    const byLog = { iid: 2, title: "Patch", description: "seen: NullPointer at login", source_branch: "y", state: "opened" };
    const { fetchFn } = router([["/merge_requests", json([byTicket, byLog])]]);
    const r = await checkFix(inv, repo.repoId, {
      culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, logText: "NullPointer at login\n",
    }, { ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn });
    expect(r.targets.filter((t) => t.kind === "open_mr").map((t) => t.target)).toEqual(["!1", "!2"]);
  });

  it("claim_without_code_change: the MR announces, the faulty code is still there", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init" },
      { files: { "a.kt": body(FAULTY, "tweak") }, message: "tweak" },
    ], "https://gitlab.com/g/p.git");
    const mr = {
      iid: 4, title: "Fix crash", description: "", source_branch: "x", state: "merged", merge_commit_sha: shas[1],
    };
    const { fetchFn } = router([
      ["/repository/commits/", json([mr])],
      ["/merge_requests", json([])],
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, {
      ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn,
    });
    expect(r.targets[0].faultyCodePresent).toBe(true);
    expect(r.targets[0].claimedBy.map((m) => m.iid)).toEqual([4]);
  });

  it("a merged MR that announces nothing is not a claim", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init" },
      { files: { "a.kt": body(FAULTY, "tweak") }, message: "tweak" },
    ], "https://gitlab.com/g/p.git");
    const mr = { iid: 4, title: "Rename things", description: "", source_branch: "x", state: "merged", merge_commit_sha: shas[1] };
    const { fetchFn } = router([["/repository/commits/", json([mr])]]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, {
      ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn,
    });
    expect(r.targets[0].claimedBy).toEqual([]);
  });

  it("stores_the_culprit_and_its_presence_in_the_evidence", async () => {
    const { path, shas } = await makeRepo({
      commits: [{ files: { "a.kt": "ok\n" }, message: "A" }, { files: { "a.kt": "FAULT\n" }, message: "B" }],
    });
    const inv = createInvestigation(await mkdtemp(join(tmpdir(), "rt-fix-")));
    inv.repos.push({ repoId: "r", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
    const r = await checkFix(inv, "r", { culprit: shas[1]!, file: "a.kt", faultySnippet: "FAULT", targets: ["main"] });
    const ev = inv.evidence.find((e) => e.id === r.evidenceIds.at(-1))!;
    expect(readFixReading(ev)).toMatchObject({ target: "main", containsCulprit: true, culprit: shas[1], faultyCodePresent: true });
  });

  it("file_moved_then_fixed: follows the rename, the fix and the moved file", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "src/a.kt": body(FAULTY) }, message: "init" },
      { files: { "src/a.kt": null, "lib/b.kt": body(FAULTY) }, message: "move" },
      { files: { "lib/b.kt": null, "core/c.kt": body(FAULTY) }, message: "move again" },
      { files: { "core/c.kt": body(GOOD) }, message: "fix crash" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "src/a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(false);
    expect(r.targets[0].candidateFixes.map((c) => c.sha)).toContain(shas[3]);
    expect(r.coverage).toContain("target:main");
  });

  it("file moved without a fix: the faulty code is found at the new path", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "src/a.kt": body(FAULTY) }, message: "init" },
      { files: { "src/a.kt": null, "lib/b.kt": body(FAULTY) }, message: "move" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "src/a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(true);
  });

  it("code split out to another file: found by git log -S", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "big.kt": body(FAULTY), "keep.kt": "keep" }, message: "init" },
      { files: { "big.kt": null, "tiny.kt": `${FAULTY}\n` }, message: "split" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "big.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(true);
  });

  it("file deleted: never read as fixed, coverage \"file not found\"", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY), "k.kt": "k" }, message: "init" },
      { files: { "a.kt": null }, message: "drop" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBeUndefined();
    expect(r.coverage).toContain("target:main: file not found");
    expect(inv.coverage.notExamined).toContain("target:main: file not found");
    expect(inv.coverage.examined).not.toContain("target:main");
  });

  it("without a culprit: the absent file stays not found, the history is still read", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(GOOD) }, message: "fix" },
      { files: { "a.kt": body(GOOD, "x") }, message: "more" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].containsCulprit).toBeUndefined();
    expect(r.targets[0].faultyCodePresent).toBe(false);
    expect(r.targets[0].candidateFixes.map((c) => c.sha)).toEqual([shas[1], shas[0]]);
    const gone = await checkFix(inv, repo.repoId, { file: "b.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(gone.targets[0].faultyCodePresent).toBeUndefined();
  });

  it("literal comparison, only CRLF normalised", async () => {
    const crlf = body(FAULTY).split("\n").join("\r\n");
    const { inv, repo, deps } = await setup([{ files: { "a.kt": crlf }, message: "init" }]);
    const hit = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: `zeta\n${FAULTY}\n`, targets: ["main"] }, deps);
    expect(hit.targets[0].faultyCodePresent).toBe(true);
    const regexLike = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "crash.user", targets: ["main"] }, deps);
    expect(regexLike.targets[0].faultyCodePresent).toBe(false);
    const spaced = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "crash( user!!)", targets: ["main"] }, deps);
    expect(spaced.targets[0].faultyCodePresent).toBe(false);
  });

  it("badly decoded file: the snippet absence does not count as a fix", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": "caf�\n" }, message: "init" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "café", targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBeUndefined();
  });

  it("no_forge_token_still_checks_local_targets", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED, "https://gitlab.com/g/p.git");
    const { fetchFn, calls } = router([]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY }, { ...deps, fetchFn });
    expect(calls).toHaveLength(0);
    expect(r.targets.length).toBeGreaterThan(0);
    expect(row(r.targets, "main").faultyCodePresent).toBe(true);
    expect(r.coverage.some((c) => c.startsWith("target:open MRs: ") && c.includes("GITLAB_TOKEN"))).toBe(true);
    expect(r.evidenceIds.length).toBeGreaterThan(0);
  });

  it("non-GitLab platform: open MRs not examined, zero calls", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED, "https://github.com/g/p.git");
    const { fetchFn, calls } = router([]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY }, {
      ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn,
    });
    expect(calls).toHaveLength(0);
    expect(r.coverage.some((c) => c.startsWith("target:open MRs: "))).toBe(true);
  });

  it("coverage_lists_every_target_examined_and_missing", async () => {
    const { inv, repo, path, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init", tag: "v1.9" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "next", tag: "v1.10" },
    ], "https://gitlab.com/g/p.git");
    await git(path, ["update-ref", "refs/remotes/origin/release-1", shas[0]]);
    await git(path, ["update-ref", "refs/remotes/origin/release/2", shas[0]]);
    await git(path, ["update-ref", "refs/remotes/origin/main", shas[1]]);
    const { fetchFn } = router([["/merge_requests", json([])]]);
    const all = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY }, { ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn });
    expect(all.targets.map((t) => t.target).sort()).toEqual(["origin/main", "origin/release-1", "origin/release/2", "v1.10"]);
    expect(row(all.targets, "v1.10").kind).toBe("tag");
    expect(row(all.targets, "origin/main").kind).toBe("branch");
    for (const name of ["v1.10", "origin/main", "origin/release-1", "origin/release/2", "open MRs"]) {
      expect(all.coverage).toContain(`target:${name}`);
      expect(inv.coverage.examined).toContain(`target:${name}`);
    }

    const { inv: inv2, repo: repo2, deps: deps2 } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init", tag: "v1" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "next", tag: "v2" },
    ], "https://gitlab.com/g/p.git");
    const some = await checkFix(inv2, repo2.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["v1", "nope", "-x", "v1"] }, deps2);
    expect(some.targets.map((t) => t.target)).toEqual(["v1"]);
    expect(some.coverage).toContain("target:v1");
    expect(some.coverage).toContain("target:nope: reference not found");
    expect(some.coverage).toContain("target:-x: name refused");
    expect(some.coverage).toContain("target:v2: outside the requested list");
    expect(some.coverage).toContain("target:main: outside the requested list");
    expect(some.coverage).toContain("target:open MRs: outside the requested list");
    expect(some.coverage).toContain("target:origin/release*: no branch");
    expect(inv2.coverage.notExamined).toEqual(expect.arrayContaining(["target:nope: reference not found", "target:v2: outside the requested list"]));
  });

  it("repository without tag or remote: the absence of a default target is stated", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY) }, message: "init" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY }, deps);
    expect(r.coverage).toContain("target:latest tag: no tag");
    expect(r.coverage).toContain("target:main");
    expect(r.coverage.some((c) => c.startsWith("target:open MRs: "))).toBe(true);
    expect(r.coverage.some((c) => c.includes("git fetch"))).toBe(true);
  });

  it("latest tag: an rc comes after the final version", async () => {
    const { inv, repo, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init", tag: "v2.0-rc1" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "next", tag: "v2.0" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY }, deps);
    expect(r.targets.map((t) => t.target)).toContain("v2.0");
    expect(r.targets.map((t) => t.target)).not.toContain("v2.0-rc1");
    expect(r.targets.find((t) => t.target === "v2.0")?.kind).toBe("tag");
  });

  it("a re-run on the same question updates the coverage instead of stacking", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY) }, message: "init", tag: "v1" }]);
    const gone = { file: "gone.kt", faultySnippet: "nowhere" };
    await checkFix(inv, repo.repoId, { ...gone, targets: ["main"] }, deps);
    expect(inv.coverage.notExamined).toContain("target:main: file not found");
    await checkFix(inv, repo.repoId, { ...gone, targets: ["v1"] }, deps);
    expect(inv.coverage.notExamined).toContain("target:main: file not found");
    expect(inv.coverage.notExamined).not.toContain("target:main: outside the requested list");

    const same = { file: "a.kt", faultySnippet: FAULTY };
    await checkFix(inv, repo.repoId, { ...same, targets: ["main"] }, deps);
    expect(inv.coverage.examined.filter((c) => c === "target:main")).toHaveLength(1);
    await checkFix(inv, repo.repoId, { ...same, targets: ["main"] }, deps);
    expect(inv.coverage.examined.filter((c) => c === "target:main")).toHaveLength(1);
    await checkFix(inv, repo.repoId, { ...same, targets: ["v1"] }, deps);
    expect(inv.coverage.examined).toContain("target:main");
    expect(inv.coverage.notExamined.some((c) => c.startsWith("target:main: "))).toBe(false);
  });

  it("other file or other snippet: the previous question coverage disappears", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY), "b.kt": body("other") }, message: "init", tag: "v1" }]);
    await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(inv.coverage.examined).toContain("target:main");
    await checkFix(inv, repo.repoId, { file: "b.kt", faultySnippet: "other", targets: ["v1"] }, deps);
    expect(inv.coverage.examined).not.toContain("target:main");
    expect(inv.coverage.examined).toContain("target:v1");
    expect(inv.coverage.notExamined.some((c) => c.startsWith("scope:main: "))).toBe(false);
    await checkFix(inv, repo.repoId, { file: "b.kt", faultySnippet: "other ", targets: ["main"] }, deps);
    expect(inv.coverage.examined).not.toContain("target:v1");
  });

  it("code extracted to another file, old name reused: never read as fixed", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init" },
      { files: { "a.kt": "something else entirely\n", "helper.kt": `fun h() { ${FAULTY} }\n` }, message: "extract" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(true);
    const ev = inv.evidence.find((e) => r.evidenceIds.includes(e.id) && (e.data as { path?: string }).path === "helper.kt");
    expect(ev).toBeDefined();
  });

  it("code in another file outside the range: found by git grep -F, snippet over several lines", async () => {
    const snippet = "first();\n    second();";
    const { inv, repo, shas, deps } = await setup([
      { files: { "helper.kt": `x\n${snippet}\ny\n`, "a.kt": "a\n" }, message: "init" },
      { files: { "a.kt": "b\n" }, message: "culprit" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: snippet, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(true);
  });

  it("reformatted snippet: indeterminate with a note; literally absent: false, and the coverage says so", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": "call(first,\n     second)\n" }, message: "init" }]);
    const re = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "call(first, second)", targets: ["main"] }, deps);
    expect(re.targets[0].faultyCodePresent).toBeUndefined();
    expect(re.coverage.some((c) => c.startsWith("target:main: ") && c.includes("reformatted"))).toBe(true);
    const absent = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "call(third)", targets: ["main"] }, deps);
    expect(absent.targets[0].faultyCodePresent).toBe(false);
    expect(absent.coverage.some((c) => c.includes("literally"))).toBe(true);
  });

  it("moved and re-indented snippet: indeterminate, never absent", async () => {
    const snippet = "if (user == null) {\n  return\n}";
    const { inv, repo, deps } = await setup([
      { files: { "a.kt": `fun a() {\n${snippet}\n}\n`, "b.kt": "fun b() {}\n" }, message: "init" },
      { files: { "a.kt": "fun a() {}\n", "b.kt": "fun b() {\n    if (user == null) {\n        return\n    }\n}\n" }, message: "moved" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: snippet, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBeUndefined();
    expect(r.coverage.some((c) => c.startsWith("target:main: ") && c.includes("reformatted"))).toBe(true);
  });

  it("snippet intact elsewhere and reformatted in another file: present", async () => {
    const snippet = "if (user == null) {\n  return\n}";
    const { inv, repo, deps } = await setup([
      { files: { "a.kt": "x\n", "b.kt": "    if (user == null) {\n      return\n    }\n", "c.kt": `${snippet}\n` }, message: "init" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: snippet, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBe(true);
  });

  it("each target carries its scope: fixes in other files are not searched", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY) }, message: "init" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    const line = "scope:main: history limited to a.kt; fixes in other files not searched";
    expect(r.coverage).toContain(line);
    expect(inv.coverage.notExamined).toContain(line);
  });

  it("fix in another file citing the culprit ticket: via ticket, without a neighbouring prefix", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY), "c.kt": "1\n" }, message: "init" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "add crash\n\nrefs: PROJ-12" },
      { files: { "c.kt": "2\n" }, message: "fix guard\n\nrefs: PROJ-12" },
      { files: { "c.kt": "3\n" }, message: "other\n\nrefs: PROJ-123" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].candidateFixes).toEqual([{ sha: shas[2], subject: "fix guard", via: "ticket" }]);
  });

  it("commit already found by the history: no duplicate via ticket", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "add crash\n\nrefs: PROJ-12" },
      { files: { "a.kt": body(GOOD) }, message: "fix\n\nrefs: PROJ-12" },
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].candidateFixes).toEqual([{ sha: shas[1], subject: "fix", via: "history" }]);
  });

  it("partial MR list: target in notExamined, the MRs read remain", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED, "https://gitlab.com/g/p.git");
    const mine = { iid: 7, title: "Fix a.kt", description: "", source_branch: "x", state: "opened" };
    let n = 0;
    const { fetchFn } = router([
      ["/repository/commits/", json([])],
      ["/merge_requests", () => (++n === 1
        ? new Response(JSON.stringify([mine]), { status: 200, headers: { "x-next-page": "2" } })
        : new Response("{}", { status: 500 }))],
    ]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY }, { ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn });
    expect(r.targets.map((t) => t.target)).toContain("!7");
    expect(inv.coverage.examined).not.toContain("target:open MRs");
    expect(inv.coverage.notExamined.some((c) => c.startsWith("target:open MRs: "))).toBe(true);
  });

  it("open MR citing the path found after a move", async () => {
    const { inv, repo, shas, deps } = await setup([
      { files: { "src/a.kt": body(FAULTY) }, message: "init" },
      { files: { "src/a.kt": null, "lib/moved.kt": body(FAULTY) }, message: "move" },
    ], "https://gitlab.com/g/p.git");
    const mr = { iid: 3, title: "Patch moved.kt", description: "", source_branch: "x", state: "opened" };
    const { fetchFn } = router([["/repository/commits/", json([])], ["/merge_requests", json([mr])]]);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[0], file: "src/a.kt", faultySnippet: FAULTY }, { ...deps, env: { GITLAB_TOKEN: "t" }, fetchFn });
    expect(r.targets.map((t) => t.target)).toContain("!3");
  });

  it("all of GitLab reasons stay in the coverage", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED, "https://gitlab.com/g/p.git");
    await writeFile(deps.configPath, "{ not json");
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY }, deps);
    const line = r.coverage.find((c) => c.startsWith("target:open MRs: "))!;
    expect(line).toContain("Config ignored");
    expect(line).toContain("GITLAB_TOKEN");
  });

  it("logTextPresent: literal, per target, absent without logText, and the coverage recalls its scope", async () => {
    const { inv, repo, deps } = await setup([
      { files: { "a.kt": `log("boot.failed")\n${FAULTY}\n`, "z.kt": "z\n" }, message: "init", tag: "v1" },
      { files: { "a.kt": `${FAULTY}\n` }, message: "drop log" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["v1", "main"], logText: "\nboot.failed\n" }, deps);
    expect(row(r.targets, "v1").logTextPresent).toBe(true);
    expect(row(r.targets, "main").logTextPresent).toBe(false);
    expect(r.coverage.some((c) => c.includes("logTextPresent"))).toBe(true);
    const literal = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["v1"], logText: "boot.failed.*" }, deps);
    expect(literal.targets[0].logTextPresent).toBe(false);
    const none = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["v1"] }, deps);
    expect(none.targets[0].logTextPresent).toBeUndefined();
  });

  it.each(["resolved", "resolves", "fixes", "fixed", "Fix crash", "bugfix", "hotfix", "closes #4"])("announcement recognised: %s", (text) => {
    expect(claimsFix(`Ticket ${text}`)).toBe(true);
  });
  it.each(["prefix handling", "affixed", "correct format", "renaming"])("not an announcement: %s", (text) => {
    expect(claimsFix(text)).toBe(false);
  });

  it("latest tag: only version tags count, the others are noted", async () => {
    const { inv, repo, deps } = await setup([
      { files: { "a.kt": body(FAULTY) }, message: "init", tag: "v1.2.0" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "next", tag: "zebra" },
    ]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY }, deps);
    expect(r.targets.map((t) => t.target)).toContain("v1.2.0");
    expect(r.targets.map((t) => t.target)).not.toContain("zebra");
    expect(r.coverage.some((c) => c.includes("non-version") && c.includes("1"))).toBe(true);
  });

  it("only non-version tags: the absence is stated", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY) }, message: "init", tag: "zebra" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY }, deps);
    expect(r.coverage).toContain("target:latest tag: no version tag");
  });

  it("LFS pointer: indeterminate, never fixed", async () => {
    const lfs = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n";
    const { inv, repo, deps } = await setup([{ files: { "a.kt": lfs }, message: "init" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBeUndefined();
    expect(r.coverage.some((c) => c.startsWith("target:main: ") && c.includes("LFS"))).toBe(true);
  });

  it("symbolic link: indeterminate, never fixed", async () => {
    const { inv, repo, path, deps } = await setup([{ files: { "k.kt": "k\n" }, message: "init" }]);
    const hash = await git(path, ["hash-object", "-w", "--stdin"], { input: "elsewhere.kt" });
    await git(path, ["update-index", "--add", "--cacheinfo", `120000,${hash.stdout.trim()},link.kt`]);
    await git(path, ["commit", "-q", "-m", "link"]);
    const r = await checkFix(inv, repo.repoId, { file: "link.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].faultyCodePresent).toBeUndefined();
    expect(r.coverage.some((c) => c.startsWith("target:main: ") && c.includes("symbolic link"))).toBe(true);
  });

  it("the evidence keeps the snippet compared", async () => {
    const { inv, repo, deps } = await setup([{ files: { "a.kt": body(FAULTY) }, message: "init" }]);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    const ev = inv.evidence.find((e) => e.id === r.evidenceIds[0])!;
    expect((ev.data as { snippet: string }).snippet).toBe(FAULTY);
  });

  it("history cap: reported in the coverage", async () => {
    const commits: CommitSpec[] = [{ files: { "a.kt": body(FAULTY) }, message: "init" }];
    for (let i = 0; i < 52; i++) commits.push({ files: { "a.kt": body(FAULTY, `v${i}`) }, message: `c${i}` });
    const { inv, repo, deps } = await setup(commits);
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["main"] }, deps);
    expect(r.targets[0].candidateFixes).toHaveLength(50);
    expect(r.coverage.some((c) => c.includes("main") && c.includes("50"))).toBe(true);
  }, 60_000);

  it("shallow clone: the exact note is set", async () => {
    const { path, shas } = await makeRepo({ commits: [
      { files: { "a.kt": body(FAULTY) }, message: "init" },
      { files: { "a.kt": body(FAULTY, "x") }, message: "next" },
    ] });
    const dir = await mkdtemp(join(tmpdir(), "rt-fix-"));
    dirs.push(dir);
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${path.split("\\").join("/")}`, clone], { windowsHide: true });
    const inv = createInvestigation(dir);
    const repo = await resolveRepo(inv, clone, undefined, join(dir, "none.json"));
    const r = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: FAULTY, targets: ["HEAD"] }, { env: {}, configPath: join(dir, "none.json") });
    expect(r.coverage).toContain(HISTORY_TRUNCATED_NOTE);
    expect(inv.coverage.notExamined).toContain(HISTORY_TRUNCATED_NOTE);
    expect(shas).toHaveLength(2);
  });

  it("evidence: code_reading, untrusted, with no test subject", async () => {
    const { inv, repo, shas, deps } = await setup(FORKED);
    const r = await checkFix(inv, repo.repoId, { culprit: shas[1], file: "a.kt", faultySnippet: FAULTY, targets: ["main", "release"] }, deps);
    expect(r.evidenceIds).toHaveLength(2);
    for (const id of r.evidenceIds) {
      const e = inv.evidence.find((x) => x.id === id)!;
      expect(e.kind).toBe("code_reading");
      expect(e.untrusted).toBe(true);
      expect(e.subject).toBeUndefined();
    }
  });

  it("invalid inputs: clear error", async () => {
    const { inv, repo, deps } = await setup(FORKED);
    await expect(checkFix(inv, "R99", { file: "a.kt", faultySnippet: "x" }, deps)).rejects.toThrow(/R99/);
    await expect(checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: " \n " }, deps)).rejects.toThrow(/snippet/i);
    await expect(checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "a\0b" }, deps)).rejects.toThrow(/snippet/i);
    await expect(checkFix(inv, repo.repoId, { file: "", faultySnippet: "x" }, deps)).rejects.toThrow();
    await expect(checkFix(inv, repo.repoId, { culprit: "--output=x", file: "a.kt", faultySnippet: "x" }, deps)).rejects.toThrow();
    await expect(checkFix(inv, repo.repoId, { culprit: "deadbeef", file: "a.kt", faultySnippet: "x" }, deps)).rejects.toThrow(/not found/);
  });
});

describe("fetchRefs", () => {
  it("unreachable remote: ok false, the coverage says so", async () => {
    const { inv, repo } = await setup(FORKED, join(tmpdir(), "rt-no-such-remote-xyz"));
    const r = await fetchRefs(inv, repo.repoId);
    expect(r.ok).toBe(false);
    expect(r.output).not.toBe("");
    expect(inv.coverage.notExamined.some((n) => n.includes("git fetch"))).toBe(true);
  });

  it("updates references and tags, without touching the working copy or pruning", async () => {
    const up = await makeRepo({ commits: [{ files: { "a.kt": "1" }, message: "one" }] });
    const dir = await mkdtemp(join(tmpdir(), "rt-fix-"));
    dirs.push(dir);
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", up.path, clone], { windowsHide: true });
    await writeFile(join(clone, "a.kt"), "local edit");
    await git(clone, ["update-ref", "refs/remotes/origin/gone", up.shas[0]]);
    await writeFile(join(up.path, "a.kt"), "2");
    execFileSync("git", ["commit", "-qam", "two"], { cwd: up.path, windowsHide: true });
    execFileSync("git", ["tag", "v9"], { cwd: up.path, windowsHide: true });

    const inv = createInvestigation(dir);
    const repo = await resolveRepo(inv, clone, undefined, join(dir, "none.json"));
    const head = (await git(clone, ["rev-parse", "HEAD"])).stdout;
    const r = await fetchRefs(inv, repo.repoId);

    expect(r.ok).toBe(true);
    expect((await git(clone, ["rev-parse", "--verify", "-q", "refs/tags/v9"])).code).toBe(0);
    expect((await git(clone, ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone"])).code).toBe(0);
    expect((await git(clone, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await readFile(join(clone, "a.kt"), "utf8")).toBe("local edit");
    const call = spy.calls.find((a) => a.includes("fetch"))!;
    expect(call).toEqual(expect.arrayContaining(["fetch", "--all", "--tags"]));
    expect(call).not.toContain("--prune");
    expect(call).not.toContain("--force");

    const check = await checkFix(inv, repo.repoId, { file: "a.kt", faultySnippet: "1", targets: ["origin/HEAD"] }, { env: {}, configPath: join(dir, "none.json") });
    expect(check.coverage.some((c) => c.includes("git fetch"))).toBe(false);
  });

  it("fetch.prune=true in the repository: origin/release-1 stays", async () => {
    const up = await makeRepo({ commits: [{ files: { "a.kt": "1" }, message: "one" }] });
    const dir = await mkdtemp(join(tmpdir(), "rt-fix-"));
    dirs.push(dir);
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", up.path, clone], { windowsHide: true });
    await git(clone, ["config", "fetch.prune", "true"]);
    await git(clone, ["update-ref", "refs/remotes/origin/release-1", up.shas[0]]);
    const inv = createInvestigation(dir);
    const repo = await resolveRepo(inv, clone, undefined, join(dir, "none.json"));
    expect((await fetchRefs(inv, repo.repoId)).ok).toBe(true);
    expect((await git(clone, ["rev-parse", "--verify", "-q", "refs/remotes/origin/release-1"])).code).toBe(0);
  });

  it("no remote: nothing is refreshed, and that is stated", async () => {
    const { inv, repo } = await setup(FORKED);
    const r = await fetchRefs(inv, repo.repoId);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no remote");
    expect(spy.calls.some((a) => a.includes("fetch"))).toBe(false);
    expect(inv.coverage.notExamined.some((n) => n.includes("git fetch"))).toBe(true);
  });

  it("URL credentials and known tokens: stripped from the output", () => {
    const out = scrubGitOutput("fatal: unable to access 'https://oauth2:s3cret@gitlab.com/g/p.git/': tok-abc", ["tok-abc"]);
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("tok-abc");
    expect(out).toContain("gitlab.com/g/p.git");
  });

  it("unknown repository: clear error", async () => {
    const { inv } = await setup(FORKED);
    await expect(fetchRefs(inv, "R99")).rejects.toThrow(/R99/);
  });
});
