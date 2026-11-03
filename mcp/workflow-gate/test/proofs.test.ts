import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTests } from "../src/counts.js";
import { parseWarnings } from "../src/gate.js";
import { commit, COMMANDS, env, FILES, NODE, sh, start, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;

beforeEach(async () => {
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

const run = (gateId: string, step: string, extra = {}) => e.s.call("gate_run", { gateId, step, ...extra });
const close = (gateId: string) => e.s.call("gate_close", { gateId });
const statusOf = async (id: string, step: string) =>
  (await e.s.call("gate_status", { gateId: id })).data.steps.find((s: { id: string }) => s.id === step);
const fixLib = () => write(repo, "lib.js", "module.exports = 'ok';\n");
const green = () => {
  fixLib();
  commit(repo, "green");
};

/** clean-up: `change` acts between the before and after proofs. */
async function clean(change: () => void): Promise<{ id: string; data: { score: number; missing: string[]; warnings: string[]; reportPath: string } }> {
  const id = await start(e.s, "clean-up", repo);
  await run(id, "tests_before");
  await run(id, "lint_before");
  change();
  commit(repo, "clean");
  for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
  return { id, data: (await close(id)).data };
}

describe("C1: the fix survives up to HEAD", () => {
  const commands = { test: COMMANDS.test, failingTest: [NODE, "spec.js"], lint: COMMANDS.lint, build: COMMANDS.build };
  const SPEC = `const ok = require('./lib.js') === 'ok'; console.log("ℹ tests 1"); process.exit(ok ? 0 : 1);\n`;

  async function fixed(): Promise<{ id: string; fix: string }> {
    const id = await start(e.s, "fix-bug", repo, { commands });
    write(repo, "spec.js", SPEC);
    await run(id, "failing_test_before");
    fixLib();
    return { id, fix: commit(repo, "fix") };
  }
  const finish = async (id: string, fix: string) => {
    await e.s.call("gate_note", { gateId: id, step: "same_bug_elsewhere", note: "nothing" });
    await run(id, "revert_fails", { fixCommit: fix, testFile: "spec.js" });
    for (const step of ["test_passes_after", "full_suite", "lint", "build"]) await run(id, step);
    return (await close(id)).data;
  };

  it("refuses the bug back at HEAD, test weakened afterwards", async () => {
    const { id, fix } = await fixed();
    write(repo, "lib.js", "module.exports = 'ko';\n");
    write(repo, "spec.js", `console.log("ℹ tests 1");\n`);
    commit(repo, "bug is back");
    const data = await finish(id, fix);
    expect(data.score).toBeLessThan(10);
    expect(data.missing.join()).toMatch(/revert_fails/);
  });

  it("refuses a commit touching anything but tests after the fix", async () => {
    const { id, fix } = await fixed();
    write(repo, "other.js", "x\n");
    commit(repo, "next");
    const refused = await run(id, "revert_fails", { fixCommit: fix, testFile: "spec.js" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/other\.js/);
    expect((await finish(id, fix)).missing.join()).toMatch(/revert_fails/);
  });

  it("accepts test-only commits after the fix", async () => {
    const { id, fix } = await fixed();
    write(repo, "tests/more.test.js", "x\n");
    commit(repo, "more tests");
    expect((await finish(id, fix)).score).toBe(10);
  });
});

describe("C2: the before proofs", () => {
  beforeEach(green);

  it("clean-up requires a strict ancestor: an uncommitted change is not enough", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "lint.txt", "a: Warning: x\n");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    expect((await close(id)).data.missing.join()).toMatch(/tests_before.*strict ancestor/);
  });

  it("refuses to redo a before proof on another state", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    write(repo, "x.txt", "x\n");
    const r = await run(id, "tests_before");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/another state/);
  });

  it("refuses a before proof when an after proof exists", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "build");
    expect((await run(id, "tests_before")).isError).toBe(true);
  });

  it("allows redoing on the same state", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    expect((await run(id, "tests_before")).isError).toBe(false);
  });

  it("no difference between before and after: nothing to clean up, score capped", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    await run(id, "lint_before");
    sh(repo, "commit", "-q", "--allow-empty", "-m", "empty");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    const { data } = await close(id);
    expect(data.score).toBe(9);
    expect(data.missing.join()).toMatch(/nothing to clean up/);
  });
});

describe("C3: the test counts", () => {
  beforeEach(green);

  it.each([
    ["node --test", "ℹ tests 12\nℹ suites 1\nℹ pass 10\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n", { total: 12, failed: 1, skipped: 1, parser: "node" }],
    ["node tap", "# tests 3\n# pass 3\n# fail 0\n# skipped 0\n", { total: 3, failed: 0, skipped: 0, parser: "node" }],
    ["vitest", "\u001b[2m      Tests \u001b[22m 1 failed | 105 passed | 2 skipped (108)\n", { total: 108, failed: 1, skipped: 2, parser: "vitest" }],
    ["jest", "Tests:       1 failed, 1 skipped, 10 passed, 12 total\n", { total: 12, failed: 1, skipped: 1, parser: "jest" }],
    ["gradle", "12 tests completed, 2 failed, 1 skipped\n3 tests completed, 1 failed\n", { total: 15, failed: 3, skipped: 1, parser: "gradle" }],
    ["surefire", "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1 s\nTests run: 9, Failures: 1, Errors: 1, Skipped: 2\n", { total: 9, failed: 2, skipped: 2, parser: "junit" }],
    ["junit console", "[        10 tests found     ]\n[         1 tests skipped   ]\n[         0 tests failed    ]\n", { total: 10, failed: 0, skipped: 1, parser: "junit" }],
  ])("reads %s", (_, text, expected) => {
    expect(parseTests(text)).toEqual(expected);
  });

  it("returns null on an output without a count", () => {
    expect(parseTests("BUILD SUCCESSFUL\n")).toBeNull();
  });

  it("refuses a falling test count", async () => {
    write(repo, "report.txt", "ℹ tests 5\nℹ skipped 0\n");
    write(repo, "t.js", "console.log(require('node:fs').readFileSync('report.txt', 'utf8'));\n");
    commit(repo, "count read from a file");
    const id = await start(e.s, "clean-up", repo, { commands: { ...COMMANDS, test: [NODE, "t.js"] } });
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "report.txt", "ℹ tests 4\nℹ skipped 0\n");
    commit(repo, "fewer");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    expect((await close(id)).data.missing.join()).toMatch(/tests_after.*down/);
  });

  it("an unreadable count caps at 9 and says so", async () => {
    write(repo, "test.js", "process.exit(0);\n");
    commit(repo, "silent");
    const { data } = await clean(() => write(repo, "lint.txt", "a: Warning: x\n"));
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/unreadable/);
  });

  it("reads Gradle JUnit results when the output stays silent", async () => {
    write(repo, ".gitignore", "build/\n");
    write(repo, "test.js", `require('node:fs').mkdirSync('build/test-results/test', { recursive: true });
require('node:fs').writeFileSync('build/test-results/test/TEST-A.xml', '<?xml version="1.0"?><testsuite name="A" tests="4" skipped="1" failures="0" errors="0"></testsuite>');\n`);
    commit(repo, "gradle");
    const id = await start(e.s, "clean-up", repo);
    expect((await run(id, "tests_before")).data.tests).toEqual({ total: 4, failed: 0, skipped: 1, parser: "junit-xml" });
  });

  it("a deleted test caps at 8", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "test");
    const { data } = await clean(() => sh(repo, "rm", "-q", "tests/a.test.js"));
    expect(data.score).toBe(8);
    expect(data.warnings.join()).toMatch(/deleted.*tests\/a\.test\.js/);
  });

  it("one more skipped test caps at 8", async () => {
    write(repo, "report.txt", "ℹ tests 5\nℹ skipped 0\n");
    write(repo, "t.js", "console.log(require('node:fs').readFileSync('report.txt', 'utf8'));\n");
    commit(repo, "count read from a file");
    const id = await start(e.s, "clean-up", repo, { commands: { ...COMMANDS, test: [NODE, "t.js"] } });
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "report.txt", "ℹ tests 5\nℹ skipped 2\n");
    commit(repo, "skip");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    const { data } = await close(id);
    expect(data.score).toBe(8);
    expect(data.warnings.join()).toMatch(/skipped tests up/);
  });

  it("clean-up: a modified test caps at 9", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "test");
    const { data } = await clean(() => write(repo, "tests/a.test.js", "y\n"));
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/modified.*tests\/a\.test\.js/);
  });
});

describe("C4: lint", () => {
  beforeEach(green);

  it("the generic reader counts errors and warnings", () => {
    expect(parseWarnings("error: a\nwarning: b\nerror c\nnothing\n")).toEqual({ count: 1, errors: 2, parser: "generic" });
  });

  it("sums the summaries of a multi-module build", () => {
    expect(parseWarnings("1 errors, 2 warnings\n3 errors, 4 warnings\n")).toEqual({ count: 6, errors: 4, parser: "android" });
  });

  it("refuses rising generic errors, even if warnings go down", async () => {
    write(repo, "lint.txt", "warning: a\nwarning: b\n");
    commit(repo, "generic lint");
    const { data } = await clean(() => write(repo, "lint.txt", "warning: a\nerror: b\n"));
    expect(data.missing.join()).toMatch(/lint_after.*errors/);
  });
});

describe("C7: the commands in the score", () => {
  beforeEach(green);

  it("the report shows the exact argv of each step", async () => {
    const { data } = await clean(() => write(repo, "lint.txt", "a: Warning: x\n"));
    const md = readFileSync(data.reportPath, "utf8");
    expect(md).toContain("test.js");
    expect(md).toContain("lint.js");
    expect(md).toContain("build.js");
  });

  it("evaluate compares the before and after commands", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "lint.txt", "a: Warning: x\n");
    commit(repo, "n");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    const file = join(e.gatesDir, `${id}.json`);
    const gate = JSON.parse(readFileSync(file, "utf8"));
    gate.proofs.find((p: { step: string }) => p.step === "lint_after").command = ["other"];
    writeFileSync(file, JSON.stringify(gate));
    expect((await statusOf(id, "lint_after")).reason).toMatch(/command/);
  });

  it("reports another recent gate on the repo, with its score", async () => {
    const first = await start(e.s, "clean-up", repo);
    await close(first);
    const reply = await e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands: COMMANDS });
    expect(reply.data.recentGates).toEqual([expect.objectContaining({ gateId: first, score: 0 })]);
    const closed = await close(reply.data.gateId);
    expect(readFileSync(closed.data.reportPath, "utf8")).toContain(first);
  });

  it("build-feature: a failingTest with another executable caps at 9", async () => {
    const other = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    write(repo, other, "@echo off\r\n");
    const id = await start(e.s, "build-feature", repo, { commands: { ...COMMANDS, failingTest: [other, "t"] } });
    const data = (await close(id)).data;
    expect(data.warnings.join()).toMatch(/failingTest/);
    expect(data.score).toBeLessThanOrEqual(9);
  });

  it.each([
    ["lint script", () => write(repo, "lint.js", "console.log('0 errors, 0 warnings');\n")],
    ["lint config", () => write(repo, "eslint.config.js", "module.exports = [{ rules: {} }];\n")],
    ["package.json scripts", () => write(repo, "package.json", `{ "scripts": { "test": "other" } }`)],
  ])("a change to the %s caps at 9", async (_, change) => {
    write(repo, "package.json", `{ "scripts": { "test": "x" } }`);
    write(repo, "eslint.config.js", "module.exports = [];\n");
    commit(repo, "config");
    const { data } = await clean(change);
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/control/);
  });
});
