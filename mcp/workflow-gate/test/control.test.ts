import { appendFileSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlKind, parseTests } from "../src/counts.js";
import { auditManifest } from "../src/scan.js";
import { commit, COMMANDS, env, FILES, NODE, sh, start, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;

beforeEach(async () => {
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
  write(repo, "lib.js", "module.exports = 'ok';\n");
  commit(repo, "green");
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

const run = (gateId: string, step: string, extra = {}) => e.s.call("gate_run", { gateId, step, ...extra });

async function clean(change: () => void, extra = {}): Promise<{ score: number; warnings: string[]; reportPath: string }> {
  const id = await start(e.s, "clean-up", repo, extra);
  await run(id, "tests_before");
  await run(id, "lint_before");
  change();
  commit(repo, "clean");
  for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
  return (await e.s.call("gate_close", { gateId: id })).data;
}

async function buildFeature(change: () => void): Promise<{ score: number; warnings: string[] }> {
  write(repo, "lib.js", "module.exports = 'ko';\n");
  commit(repo, "red");
  const id = await start(e.s, "build-feature", repo);
  for (const step of ["requirements", "edge_cases", "plan"]) await e.s.call("gate_note", { gateId: id, step, note: "n" });
  await run(id, "failing_test_before");
  write(repo, "lib.js", "module.exports = 'ok';\n");
  change();
  commit(repo, "feat");
  for (const step of ["tests_after", "lint", "build"]) await run(id, step);
  return (await e.s.call("gate_close", { gateId: id })).data;
}

describe("1: file classification", () => {
  it.each([
    ["src/test/A.kt", "test"], ["tests/a.py", "test"], ["spec/a.rb", "test"], ["x/__tests__/a.js", "test"], ["app/src/androidTest/A.kt", "test"],
    ["pkg/a_test.go", "test"], ["src/a.test.ts", "test"], ["src/a.spec.ts", "test"],
    ["scripts/deploy.mjs", "control"], ["package.json", "control"], ["vite.config.ts", "control"], ["a/b/.eslintrc", "control"], [".github/workflows/x.yml", "control"],
    ["app/build.gradle", "control"], ["settings.gradle.kts", "control"], ["gradle/libs.toml", "control"], ["app/lint.xml", "control"], ["lint/rules.xml", "control"], ["app/lint-baseline.xml", "control"],
    ["src/main/Main.kt", null], ["README.md", null], ["src/latest.ts", null], ["res/layout/main.xml", null],
  ])("%s: %s", (path, kind) => {
    expect(controlKind(path, new Set())).toBe(kind);
  });

  it("a file cited by a command counts", () => {
    expect(controlKind("tools/run.js", new Set(["tools/run.js"]))).toBe("control");
  });
});

describe("1: cap at 9", () => {
  it.each([
    ["a file under scripts/", "scripts/x.js"],
    ["a *.config.* file", "vite.config.ts"],
    ["a deep dotfile", "a/.prettierrc"],
    ["a .gradle file", "app/build.gradle"],
    ["a baseline", "lint-baseline.xml"],
  ])("clean-up: %s", async (_, path) => {
    const data = await clean(() => write(repo, path, "x\n"));
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toContain(path);
    expect(readFileSync(data.reportPath, "utf8")).toContain(path.split("/").at(-1)?.split(".")[0]);
  });

  it("a file cited by a command", async () => {
    expect((await clean(() => write(repo, "build.js", "process.exit(0); // tweak\n"))).score).toBe(9);
  });

  it("an ordinary source file does not cap", async () => {
    expect((await clean(() => write(repo, "src/a.kt", "x\n"))).score).toBe(10);
  });

  it("an untracked control file counts", async () => {
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "lint.txt", "a: Warning: x\n");
    commit(repo, "n");
    write(repo, "vite.config.ts", "x\n");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    expect((await e.s.call("gate_close", { gateId: id })).data.warnings.join()).toContain("vite.config.ts");
  });

  it("a changed ignored file under watchIgnored", async () => {
    write(repo, ".gitignore", "gen/\n");
    write(repo, "gen/a.txt", "one\n");
    commit(repo, "ignore");
    const data = await clean(() => {
      write(repo, "gen/a.txt", "two\n");
      write(repo, "src/a.kt", "x\n");
    }, { watchIgnored: ["gen"] });
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toContain("gen");
  });

  it.each([
    [".eslintrc"], [".eslintrc.json"], ["eslintrc.js"], ["eslint.config.mjs"], ["app/lint.xml"], ["detekt.yml"], ["config/detekt-rules.yaml"],
    [".ktlint"], ["biome.json"], ["biome.jsonc"], [".swiftlint.yml"],
  ])("keeps %s in the control list", (path) => {
    expect(controlKind(path, new Set())).toBe("control");
  });

  it("a control file hidden by info/exclude and changed counts, as in the hash", async () => {
    appendFileSync(join(repo, ".git", "info", "exclude"), "vite.config.ts\n");
    write(repo, "vite.config.ts", "one\n");
    const data = await clean(() => {
      write(repo, "vite.config.ts", "two\n");
      write(repo, "src/a.kt", "x\n");
    });
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toContain("vite.config.ts");
  });

  it("an unchanged untracked control file does not cap", async () => {
    appendFileSync(join(repo, ".git", "info", "exclude"), ".idea-local\n");
    write(repo, ".idea-local", "one\n");
    expect((await clean(() => write(repo, "src/a.kt", "x\n"))).score).toBe(10);
  });

  it("an ignored file cited by a command and changed caps", async () => {
    write(repo, ".gitignore", "tool/\n");
    commit(repo, "ignore");
    write(repo, "tool/run.js", "process.exit(0);\n");
    const commands = { ...COMMANDS, build: [NODE, "tool/run.js"] };
    const data = await clean(() => {
      write(repo, "tool/run.js", "process.exit(0); // other\n");
      write(repo, "src/a.kt", "x\n");
    }, { commands });
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/commands/);
  });

  it("clean-up: any added test caps", async () => {
    expect((await clean(() => write(repo, "tests/a.test.js", "x\n"))).score).toBe(9);
  });

  it("build-feature: an added test is listed without a cap", async () => {
    const data = await buildFeature(() => write(repo, "tests/a.test.js", "x\n"));
    expect(data.score).toBe(10);
    expect(data.warnings.join()).toContain("tests/a.test.js");
  });

  it("build-feature: a modified test caps", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "t");
    expect((await buildFeature(() => write(repo, "tests/a.test.js", "y\n"))).score).toBe(9);
  });

  it("build-feature: lines only added to a test are listed without a cap", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "t");
    const data = await buildFeature(() => write(repo, "tests/a.test.js", "x\ny\n"));
    expect(data.score).toBe(10);
    expect(data.warnings.join()).toContain("tests/a.test.js");
  });

  it("build-feature: a line removed from a test caps, even with additions", async () => {
    write(repo, "tests/a.test.js", "x\nz\n");
    commit(repo, "t");
    expect((await buildFeature(() => write(repo, "tests/a.test.js", "x\ny\nw\n"))).score).toBe(9);
  });

  it("clean-up: lines added to a test still cap", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "t");
    expect((await clean(() => write(repo, "tests/a.test.js", "x\ny\n"))).score).toBe(9);
  });

  it("build-feature: a removed test caps", async () => {
    write(repo, "tests/a.test.js", "x\n");
    commit(repo, "t");
    expect((await buildFeature(() => sh(repo, "rm", "-q", "tests/a.test.js"))).score).toBeLessThanOrEqual(9);
  });
});

describe("2: the numbers", () => {
  it("the report shows tests and lint per step", async () => {
    const data = await clean(() => write(repo, "lint.txt", "1 errors, 1 warnings\n"));
    const md = readFileSync(data.reportPath, "utf8");
    expect(md).toContain("tests run 1, passed 1, skipped 0, failed 0");
    expect(md).toContain("warnings 1, errors 1");
    expect(md).toContain("warnings 2, errors 0");
  });

  it("zero tests run caps at 9", async () => {
    write(repo, "report.txt", "ℹ tests 0\nℹ skipped 0\n");
    write(repo, "t.js", "console.log(require('node:fs').readFileSync('report.txt', 'utf8'));\n");
    commit(repo, "zero");
    const data = await clean(() => write(repo, "src/a.kt", "x\n"), { commands: { ...COMMANDS, test: [NODE, "t.js"] } });
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/no test run/);
  });

  it("a lint without a readable count, on either side, caps at 9", async () => {
    write(repo, "lint.txt", "nothing\n");
    commit(repo, "silent");
    const data = await clean(() => write(repo, "src/a.kt", "x\n"));
    expect(data.score).toBe(9);
    expect(data.warnings.join()).toMatch(/lint without a readable count/);
  });

  it.each([
    ["vitest", "Tests  1 passed | 2 todo (3)\n", 2],
    ["jest", "Tests:       2 todo, 1 skipped, 1 passed, 4 total\n", 3],
    ["node", "ℹ tests 3\nℹ skipped 1\nℹ todo 1\n", 2],
  ])("counts test.todo as skipped: %s", (_, text, skipped) => {
    expect(parseTests(text)?.skipped).toBe(skipped);
  });
});

describe("3: failingTest not created yet", () => {
  const commands = { ...COMMANDS, failingTest: [NODE, "tests/new.js"] };

  it("fix-bug accepts it at open time, gate_run checks it", async () => {
    const id = await start(e.s, "fix-bug", repo, { commands });
    const r = await run(id, "failing_test_before");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/script/);
    write(repo, "tests/new.js", "process.exit(1);\n");
    expect((await run(id, "failing_test_before")).data.exitCode).toBe(1);
  });

  it("stays refused outside the repo, and for other commands and workflows", async () => {
    const open = (workflow: string, cmds: object) => e.s.call("gate_start", { workflow, repoPath: repo, commands: cmds });
    expect((await open("fix-bug", { failingTest: [NODE, "../outside.js"] })).isError).toBe(true);
    expect((await open("fix-bug", { failingTest: [NODE, "--import", "x"] })).isError).toBe(true);
    expect((await open("fix-bug", { test: [NODE, "absent.js"] })).isError).toBe(true);
    expect((await open("build-feature", commands)).isError).toBe(true);
  });
});

describe("4: manifest", () => {
  const head = `<manifest><application android:allowBackup="false"`;

  it.each([
    ["&#116;rue"], ["t&#x72;ue"], [" TRUE "], ["@bool/debuggable"], ["${debug}"],
  ])("debuggable=%s stays possibly true", (value) => {
    expect(auditManifest(`${head} android:debuggable="${value}" android:usesCleartextTraffic="${value}"/></manifest>`, "m").map((f) => f.rule)).toEqual(["debuggable", "cleartext"]);
  });

  it("unrecognized exported counts, encoded false does not", () => {
    const tag = (v: string) => `${head}><service android:name=".S" android:exported="${v}"/></application></manifest>`;
    expect(auditManifest(tag("@bool/e"), "m").map((f) => f.rule)).toEqual(["exported"]);
    expect(auditManifest(tag(" &#102;alse "), "m")).toEqual([]);
  });

  it("comments and CDATA in a single left-to-right pass", () => {
    const xml = `<!-- <![CDATA[ --><manifest><application android:allowBackup="false" android:debuggable="true"/><![CDATA[ <!-- ]]></manifest>`;
    expect(auditManifest(xml, "m").map((f) => f.rule)).toEqual(["debuggable"]);
  });

  it("a link named AndroidManifest.xml in an ignored folder prevents \"not applicable\"", async () => {
    write(repo, ".gitignore", "gen/\n");
    commit(repo, "ignore");
    write(repo, "elsewhere/x.txt", "x\n");
    write(repo, "gen/y.txt", "y\n");
    symlinkSync(join(repo, "elsewhere"), join(repo, "gen", "AndroidManifest.xml"), "junction");
    const id = await start(e.s, "security-audit", repo, { commands: { audit: [NODE, "build.js"] } });
    await e.s.call("gate_scan_manifest", { gateId: id });
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "manifest").status).toBe("missing");
  });
});
