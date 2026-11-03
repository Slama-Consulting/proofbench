import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createInvestigation, type Investigation, type Snapshot } from "../src/investigation.js";
import { classifyChange, recordClassification, traceOrigin } from "../src/origin.js";
import { HISTORY_TRUNCATED_NOTE } from "../src/verdict.js";
import { cleanupRepos, makeRepo, type CommitSpec } from "./helpers/repo.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-org-"));
  dirs.push(d);
  return d;
}

async function setup(commits: CommitSpec[]): Promise<{ inv: Investigation; snap: Snapshot; shas: string[]; path: string }> {
  const { path, shas } = await makeRepo({ commits });
  return { ...(await attach(path)), shas, path };
}

async function attach(path: string): Promise<{ inv: Investigation; snap: Snapshot }> {
  const inv = createInvestigation(await tmp());
  inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
  return { inv, snap: { path, repoId: "r1", ref: "HEAD" } };
}

const msg = (message: string, files: Record<string, string | null>): CommitSpec => ({ message, files });

const SRC1 = [
  "class Calc {",
  "    fun compute(a: Int): Int {",
  "        val total = a * 2",
  "        return total",
  "    }",
  "}",
  "",
].join("\n");

describe("traceOrigin", () => {
  it("skips_whitespace_commit", async () => {
    const reindented = SRC1.replace(/^ {4}/gm, "\t");
    const { inv, snap, shas } = await setup([msg("c1", { "Calc.kt": SRC1 }), msg("c2 reformat", { "Calc.kt": reindented })]);
    const r = await traceOrigin(inv, snap, "Calc.kt", 2, 4);
    expect(r.candidates[0]!.sha).toBe(shas[0]);
    expect(r.candidates[0]!.hint).toBe("unknown");
    const reformat = r.candidates.find((c) => c.sha === shas[1]);
    expect(reformat?.hint).toBe("cosmetic");
    expect(r.candidates.indexOf(reformat!)).toBeGreaterThan(0);
    expect(r.shallow).toBe(false);
    expect(r.evidenceIds).toHaveLength(1);
    const e = inv.evidence.find((x) => x.id === r.evidenceIds[0])!;
    expect(e.kind).toBe("code_reading");
    expect(e.untrusted).toBe(true);
    expect(e.subject).toBeUndefined();
  });

  it("returns full lowercase shas with author, date and subject", async () => {
    const { inv, snap, shas } = await setup([msg("first commit", { "Calc.kt": SRC1 })]);
    const r = await traceOrigin(inv, snap, "Calc.kt", 1, 1);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ sha: shas[0], author: "Test", subject: "first commit", hint: "unknown" });
    expect(r.candidates[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.candidates[0]!.date).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("follows_move_across_files", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `    val value${i} = computeSomethingUnique(${i}, "payload-${i}")`);
    const a = ["object A {", ...lines, "}", ""].join("\n");
    const aLeft = ["object A {", ...lines.slice(0, 4), "}", ""].join("\n");
    const b = ["object B {", ...lines.slice(4), "}", ""].join("\n");
    const { inv, snap, shas } = await setup([msg("c1", { "A.kt": a }), msg("c2 move", { "A.kt": aLeft, "B.kt": b })]);
    const r = await traceOrigin(inv, snap, "B.kt", 2, 9);
    expect(r.candidates.map((c) => c.sha)).toContain(shas[0]);
  });

  it("honours_blame_ignore_revs", async () => {
    const changed = SRC1.replace("a * 2", "a * 3");
    const { inv, snap, shas, path } = await setup([msg("c1", { "Calc.kt": SRC1 }), msg("c2 tweak", { "Calc.kt": changed })]);
    const before = await traceOrigin(inv, snap, "Calc.kt", 3, 3);
    expect(before.candidates[0]!.sha).toBe(shas[1]);
    await writeFile(join(path, ".git-blame-ignore-revs"), `# noise\n${shas[1]}\n`);
    const after = await traceOrigin(inv, snap, "Calc.kt", 3, 3);
    expect(after.candidates.map((c) => c.sha)).toEqual([shas[0]]);
  });

  it("falls back to plain blame, with a note, when the ignore file is unusable", async () => {
    const { inv, snap, path, shas } = await setup([msg("c1", { "Calc.kt": SRC1 })]);
    await writeFile(join(path, ".git-blame-ignore-revs"), "definitely-not-a-sha\n");
    const r = await traceOrigin(inv, snap, "Calc.kt", 1, 2);
    expect(r.candidates[0]!.sha).toBe(shas[0]);
    expect(inv.coverage.notExamined.some((n) => n.includes(".git-blame-ignore-revs"))).toBe(true);
  });

  it("rename_only_commit_hint_cosmetic", async () => {
    const renamed = SRC1.replace(/total/g, "sum");
    const { inv, snap, shas } = await setup([msg("c1", { "Calc.kt": SRC1 }), msg("c2 rename", { "Calc.kt": renamed })]);
    const r = await traceOrigin(inv, snap, "Calc.kt", 3, 4);
    const c2 = r.candidates.find((c) => c.sha === shas[1]);
    expect(c2).toBeDefined();
    expect(c2!.hint).toBe("cosmetic");
  });

  it("does not hint a swap of two names as a rename", async () => {
    const before = "fun f(a: Int, b: Int): Int {\n    return a - b\n}\n";
    const after = "fun f(a: Int, b: Int): Int {\n    return b - a\n}\n";
    const { inv, snap, shas } = await setup([msg("c1", { "S.kt": before }), msg("c2 swap", { "S.kt": after })]);
    const r = await traceOrigin(inv, snap, "S.kt", 2, 2);
    expect(r.candidates.find((c) => c.sha === shas[1])!.hint).toBe("unknown");
  });

  it("does not hint a changed literal as cosmetic", async () => {
    const { inv, snap, shas } = await setup([
      msg("c1", { "Calc.kt": SRC1 }),
      msg("c2", { "Calc.kt": SRC1.replace("a * 2", "a * 3") }),
    ]);
    const r = await traceOrigin(inv, snap, "Calc.kt", 3, 3);
    expect(r.candidates.find((c) => c.sha === shas[1])!.hint).toBe("unknown");
  });

  it("real_change_after_rename_ranked_first", async () => {
    const renamed = SRC1.replace(/total/g, "sum");
    const changed = renamed.replace("a * 2", "a * 5");
    const { inv, snap, shas } = await setup([
      msg("c1", { "Calc.kt": SRC1 }),
      msg("c2 rename", { "Calc.kt": renamed }),
      msg("c3 real change", { "Calc.kt": changed }),
    ]);
    const r = await traceOrigin(inv, snap, "Calc.kt", 3, 4);
    expect(r.candidates[0]!.sha).toBe(shas[2]);
    expect(r.candidates[0]!.hint).toBe("unknown");
    const order = r.candidates.map((c) => c.sha);
    expect(order).toContain(shas[1]);
    expect(order.indexOf(shas[1])).toBeGreaterThan(order.indexOf(shas[2]));
    expect(r.candidates.find((c) => c.sha === shas[1])!.hint).toBe("cosmetic");
  });

  it("gradle_only_commit_hint_dependency_bump", async () => {
    const g1 = 'dependencies {\n    implementation("org.acme:lib:1.0")\n}\n';
    const g2 = 'dependencies {\n    implementation("org.acme:lib:2.0")\n}\n';
    const { inv, snap, shas } = await setup([
      msg("c1", { "build.gradle": g1, "Foo.kt": "class Foo\n" }),
      msg("c2 bump", { "build.gradle": g2 }),
    ]);
    const r = await traceOrigin(inv, snap, "build.gradle", 2, 2);
    expect(r.candidates.find((c) => c.sha === shas[1])!.hint).toBe("dependency_bump");
    expect(r.candidates.find((c) => c.sha === shas[0])!.hint).toBe("unknown");
    expect(r.candidates[0]!.sha).toBe(shas[0]);
  });

  it("hints dependency_bump for libs.versions.toml and keeps mixed commits unknown", async () => {
    const t1 = '[versions]\nlib = "1.0"\n';
    const t2 = '[versions]\nlib = "2.0"\n';
    const { inv, snap, shas } = await setup([
      msg("c1", { "gradle/libs.versions.toml": t1 }),
      msg("c2 bump", { "gradle/libs.versions.toml": t2 }),
      msg("c3 mixed", { "gradle/libs.versions.toml": '[versions]\nlib = "3.0"\n', "Foo.kt": "class Foo\n" }),
    ]);
    const r = await traceOrigin(inv, snap, "gradle/libs.versions.toml", 2, 2);
    expect(r.candidates.find((c) => c.sha === shas[1])!.hint).toBe("dependency_bump");
    expect(r.candidates.find((c) => c.sha === shas[2])!.hint).toBe("unknown");
  });

  it("hints dependency_bump for .gitmodules and submodule gitlink commits", async () => {
    const { path, shas } = await makeRepo({ commits: [msg("c1", { "README.md": "x\n" })] });
    const sub = "1".repeat(40);
    const sh = async (...args: string[]) => (await run("git", args, { cwd: path, windowsHide: true })).stdout.trim();
    await writeFile(join(path, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.com/lib.git\n');
    await sh("add", ".gitmodules");
    await sh("update-index", "--add", "--cacheinfo", `160000,${sub},lib`);
    await sh("commit", "-q", "-m", "add submodule");
    const addSha = await sh("rev-parse", "HEAD");
    const { inv, snap } = await attach(path);
    const r = await traceOrigin(inv, snap, ".gitmodules", 1, 3);
    expect(r.candidates.find((c) => c.sha === addSha)!.hint).toBe("dependency_bump");
  });

  it("shallow_clone_reported", async () => {
    const { path } = await makeRepo({
      commits: [msg("c1", { "Calc.kt": SRC1 }), msg("c2", { "Calc.kt": SRC1.replace("a * 2", "a * 3") })],
    });
    const dest = join(await tmp(), "clone");
    await run("git", ["clone", "-q", "--depth", "1", pathToFileURL(path).href, dest], { windowsHide: true });
    const { inv, snap } = await attach(dest);
    const r = await traceOrigin(inv, snap, "Calc.kt", 1, 3);
    expect(r.shallow).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
    await traceOrigin(inv, snap, "Calc.kt", 1, 3);
    expect(inv.coverage.notExamined.filter((n) => n === HISTORY_TRUNCATED_NOTE)).toHaveLength(1);
    expect(inv.coverage.notExamined).toContain("history truncated");
  });

  it("rejects invalid ranges and file names before running git", async () => {
    const { inv, snap } = await setup([msg("c1", { "Calc.kt": SRC1 })]);
    for (const [s, e] of [[0, 1], [-1, 2], [3, 2], [1.5, 2], [1, Number.NaN], [1, Infinity]] as const) {
      await expect(traceOrigin(inv, snap, "Calc.kt", s, e)).rejects.toThrow(/Invalid line range/);
    }
    await expect(traceOrigin(inv, snap, "", 1, 1)).rejects.toThrow(/Invalid file path/);
    await expect(traceOrigin(inv, snap, "a\0b", 1, 1)).rejects.toThrow(/Invalid file path/);
  });

  it("treats a dash-leading file name as a path, not an option", async () => {
    const { inv, snap } = await setup([msg("c1", { "Calc.kt": SRC1 })]);
    await expect(traceOrigin(inv, snap, "--output=pwned", 1, 1)).rejects.toThrow(/git blame failed/);
  });

  it("rejects an option-looking ref in the snapshot", async () => {
    const { inv, snap } = await setup([msg("c1", { "Calc.kt": SRC1 })]);
    await expect(traceOrigin(inv, { ...snap, ref: "--all" }, "Calc.kt", 1, 1)).rejects.toThrow(/Invalid reference/);
  });
});

describe("classifyChange", () => {
  it("classify_returns_before_after", async () => {
    const after = SRC1.replace("a * 2", "a * 3");
    const { inv, snap, shas } = await setup([msg("c1", { "Calc.kt": SRC1 }), msg("c2", { "Calc.kt": after })]);
    const r = await classifyChange(inv, snap, shas[1]!, "Calc.kt");
    expect(r.before).toBe(SRC1);
    expect(r.after).toBe(after);
    expect(r.evidenceIds).toHaveLength(1);
    const e = inv.evidence.find((x) => x.id === r.evidenceIds[0])!;
    expect(e).toMatchObject({ kind: "code_reading", untrusted: true });
    expect(e.subject).toBeUndefined();
  });

  it("returns an empty before for a root commit and an empty after for a deleted file", async () => {
    const { inv, snap, shas } = await setup([msg("c1", { "Calc.kt": SRC1 }), msg("c2", { "Calc.kt": null, "Other.kt": "x\n" })]);
    const root = await classifyChange(inv, snap, shas[0]!, "Calc.kt");
    expect(root).toMatchObject({ before: "", after: SRC1 });
    const del = await classifyChange(inv, snap, shas[1]!, "Calc.kt");
    expect(del).toMatchObject({ before: SRC1, after: "" });
  });

  it("verifies the sha through git and rejects unknown or option-like values", async () => {
    const { inv, snap, shas } = await setup([msg("c1", { "Calc.kt": SRC1 })]);
    await expect(classifyChange(inv, snap, "f".repeat(40), "Calc.kt")).rejects.toThrow(/Commit not found/);
    await expect(classifyChange(inv, snap, "--all", "Calc.kt")).rejects.toThrow(/Invalid reference/);
    const short = await classifyChange(inv, snap, shas[0]!.slice(0, 10), "Calc.kt");
    expect(short.after).toBe(SRC1);
  });
});

describe("recordClassification", () => {
  const sha = "a".repeat(40);

  it("cosmetic carries a subject", async () => {
    const inv = createInvestigation(await tmp());
    const e = recordClassification(inv, sha, "cosmetic", "reformatting");
    expect(e).toMatchObject({ kind: "code_reading", untrusted: true, subject: { sha, outcome: "cosmetic" } });
    expect(inv.evidence).toContain(e);
  });

  it("behavior has no subject: a reading does not prove the bug", async () => {
    const inv = createInvestigation(await tmp());
    const e = recordClassification(inv, sha, "behavior", "changes the condition");
    expect(e.kind).toBe("code_reading");
    expect(e.subject).toBeUndefined();
  });

  it("rejects anything but a full lowercase sha, and unknown kinds", async () => {
    const inv = createInvestigation(await tmp());
    for (const bad of ["abc123", "A".repeat(40), "a".repeat(39), "a".repeat(41), "--all", ""]) {
      expect(() => recordClassification(inv, bad, "cosmetic", "x")).toThrow(/Invalid sha/);
    }
    expect(() => recordClassification(inv, sha, "other" as never, "x")).toThrow(/Unknown classification/);
    expect(inv.evidence).toHaveLength(0);
  });
});

describe("stricter cosmetic hints", () => {
  async function hintOfSecond(f1: string, f2: string, name: string): Promise<string> {
    const { inv, snap, shas } = await setup([msg("c1", { [name]: f1 }), msg("c2", { [name]: f2 })]);
    const r = await traceOrigin(inv, snap, name, 1, f1.split("\n").length - 1);
    return r.candidates.find((c) => c.sha === shas[1])!.hint;
  }
  const wrap = (body: string) => `fun f(list: List<Int>, a: Int, b: Int): Int {\n    ${body}\n    return 1\n}\n`;

  it.each([
    ["first to last", "val x = list.first()", "val x = list.last()"],
    ["min to max", "val x = min(a, b)", "val x = max(a, b)"],
    ["Int to Long", "val x: Int = a", "val x: Long = a"],
    ["and to or", "val x = a and b", "val x = a or b"],
    ["use renamed to an undeclared name", "val x = a - b", "val x = a - z"],
    ["declared once, never used", "val unused = 1", "val gone = 1"],
  ])("rename_hint_rejects_%s", async (_n, from, to) => {
    expect(await hintOfSecond(wrap(from), wrap(to), "F.kt")).toBe("unknown");
  });

  it("rename_hint_accepts_a_local_variable_renamed_across_its_uses", async () => {
    const h = await hintOfSecond(
      wrap("val total = a + b\n    println(total)"),
      wrap("val sum = a + b\n    println(sum)"),
      "F.kt",
    );
    expect(h).toBe("cosmetic");
  });

  it("rename_hint_accepts_a_renamed_parameter", async () => {
    const h = await hintOfSecond(
      "fun g(count: Int): Int {\n    return count * 2\n}\n",
      "fun g(n: Int): Int {\n    return n * 2\n}\n",
      "G.kt",
    );
    expect(h).toBe("cosmetic");
  });

  it("whitespace_hint_ignores_python_indentation", async () => {
    const before = "def f(x):\n    if x:\n        return 1\n    return 2\n";
    const after = "def f(x):\n    if x:\n    return 1\n    return 2\n";
    expect(await hintOfSecond(before, after, "m.py")).toBe("unknown");
  });

  it("whitespace_hint_ignores_yaml", async () => {
    expect(await hintOfSecond("a:\n  b: 1\nc: 2\n", "a:\n  b: 1\n c: 2\n", "x.yml")).toBe("unknown");
  });

  it("whitespace_hint_rejects_changed_string_literal", async () => {
    expect(await hintOfSecond(wrap('val s = "a b"'), wrap('val s = "a  b"'), "F.kt")).toBe("unknown");
  });

  it("whitespace_hint_rejects_changed_raw_string", async () => {
    const raw = (ind: string) => wrap(`val s = """\n${ind}hello\n    """`);
    expect(await hintOfSecond(raw("  "), raw("      "), "F.kt")).toBe("unknown");
  });

  it("whitespace_hint_still_accepts_reindented_source", async () => {
    expect(await hintOfSecond(wrap("val x = a"), wrap("val x   =   a"), "F.kt")).toBe("cosmetic");
  });

  it("notes_the_count_of_commits_dropped_through_blame_ignore_revs", async () => {
    const { inv, snap, shas, path } = await setup([
      msg("c1", { "Calc.kt": SRC1 }),
      msg("c2 tweak", { "Calc.kt": SRC1.replace("a * 2", "a * 3") }),
    ]);
    await writeFile(join(path, ".git-blame-ignore-revs"), `${shas[1]}\n`);
    await traceOrigin(inv, snap, "Calc.kt", 3, 3);
    expect(inv.coverage.notExamined.filter((n) => n.includes(".git-blame-ignore-revs"))).toEqual([
      expect.stringContaining("1 commit"),
    ]);
  });

  it("never_runs_a_repo_configured_textconv_or_external_diff", async () => {
    const { inv, snap, path, shas } = await setup([
      msg("c1", { "Calc.kt": SRC1, ".gitattributes": "*.kt diff=evil\n" }),
      msg("c2", { "Calc.kt": SRC1.replace("a * 2", "a * 3") }),
    ]);
    const marker = join(await tmp(), "pwned.txt").split("\\").join("/");
    const sh = (...a: string[]) => run("git", a, { cwd: path, windowsHide: true });
    await sh("config", "diff.evil.textconv", `echo textconv > '${marker}'; cat`);
    await sh("config", "diff.external", `echo external > '${marker}'; true`);
    await traceOrigin(inv, snap, "Calc.kt", 1, 6);
    await classifyChange(inv, snap, shas[1]!, "Calc.kt");
    expect(existsSync(marker)).toBe(false);
  });

  it("orders_30_commits_sharing_one_timestamp_topologically", async () => {
    const saved = { a: process.env.GIT_AUTHOR_DATE, c: process.env.GIT_COMMITTER_DATE };
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-01-01T00:00:00Z";
    try {
      // Commit k modifies line k: the blame order (by line) is the reverse of the expected order.
      const lines = Array.from({ length: 30 }, (_, i) => `val v${i} = 0`);
      const file = () => `${lines.join("\n")}\n`;
      const commits = [msg("c0", { "N.kt": file() })];
      for (let k = 0; k < 29; k++) {
        lines[k] = `val v${k} = 1`;
        commits.push(msg(`c${k + 1}`, { "N.kt": file() }));
      }
      const { inv, snap, shas } = await setup(commits);
      const r = await traceOrigin(inv, snap, "N.kt", 1, 30);
      expect(r.candidates.map((c) => c.sha)).toEqual([...shas].reverse());
    } finally {
      if (saved.a === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = saved.a;
      if (saved.c === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = saved.c;
    }
  }, 60_000);
});
