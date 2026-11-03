import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashUntracked } from "../src/gate.js";
import { commit, COMMANDS, env, FILES, sh, start, write, type Env } from "./helpers/gate.js";
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
const fix = () => write(repo, "lib.js", "module.exports = 'ok';\n");

/** A complete build-feature gate: failing test, committed fix, everything proved. */
async function provedBuildFeature(): Promise<string> {
  const id = await start(e.s, "build-feature", repo);
  for (const step of ["requirements", "edge_cases", "plan"]) await e.s.call("gate_note", { gateId: id, step, note: "done" });
  await run(id, "failing_test_before");
  fix();
  commit(repo, "feat");
  for (const step of ["tests_after", "lint", "build"]) await run(id, step);
  return id;
}

/** A complete clean-up gate, with lint going from 2 warnings to the `after` text. */
async function cleanUp(after: string): Promise<string> {
  fix();
  commit(repo, "green");
  const id = await start(e.s, "clean-up", repo);
  await run(id, "tests_before");
  await run(id, "lint_before");
  write(repo, "lint.txt", after);
  commit(repo, "clean");
  for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
  return id;
}

describe("spec success criterion", () => {
  it("accepts 10/10 when everything is proved", async () => {
    const closed = await close(await provedBuildFeature());
    expect(closed.data.score).toBe(10);
    expect(closed.data.missing).toEqual([]);
  });

  it("refuses 10/10 if a step is missing", async () => {
    const id = await start(e.s, "build-feature", repo);
    for (const step of ["requirements", "edge_cases", "plan"]) await e.s.call("gate_note", { gateId: id, step, note: "done" });
    await run(id, "failing_test_before");
    fix();
    commit(repo, "feat");
    await run(id, "tests_after");
    await run(id, "lint");
    const closed = await close(id);
    expect(closed.data.score).toBe(8);
    expect(closed.data.missing.join()).toContain("build");
  });

  it("refuses 10/10 if the commit changed", async () => {
    const id = await provedBuildFeature();
    write(repo, "other.txt", "x\n");
    commit(repo, "again");
    const closed = await close(id);
    expect(closed.data.score).toBeLessThan(10);
    expect(closed.data.missing.join()).toMatch(/tests_after/);
  });

  it("refuses 10/10 if lint gets worse", async () => {
    const closed = await close(await cleanUp("a: Warning: x\nb: Warning: y\nc: Warning: z\n"));
    expect(closed.data.score).toBeLessThan(10);
    expect(closed.data.missing.join()).toMatch(/lint_after/);
  });

  it("accepts 10/10 when lint does not get worse", async () => {
    expect((await close(await cleanUp("a: Warning: x\n"))).data.score).toBe(10);
  });
});

describe("proof validity", () => {
  it("an uncommitted change makes a proof stale", async () => {
    const id = await provedBuildFeature();
    write(repo, "lib.js", "module.exports = 'ok'; // tweak\n");
    expect((await close(id)).data.score).toBeLessThan(10);
  });

  it("a modified untracked file also makes the proof stale", async () => {
    write(repo, "local.txt", "a\n");
    const id = await start(e.s, "build-feature", repo);
    await run(id, "failing_test_before");
    fix();
    commit(repo, "feat");
    await run(id, "tests_after");
    write(repo, "local.txt", "b\n");
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "tests_after").status).toBe("missing");
  });

  describe("untracked files hash", () => {
    const content = (files: Record<string, string>) => (p: string) => Buffer.from(files[p] ?? "");

    it("covers a path with a newline, which Windows cannot create", () => {
      const a = hashUntracked(["a\nb"], content({ "a\nb": "one" }));
      expect(a).not.toBe(hashUntracked(["a\nb"], content({ "a\nb": "two" })));
      expect(a).not.toBe(hashUntracked([], content({})));
    });

    it("separates path and content with NUL: no collision between them", () => {
      expect(hashUntracked(["ab"], content({ ab: "c" }))).not.toBe(hashUntracked(["a"], content({ a: "bc" })));
      expect(hashUntracked(["a", "b"], content({ a: "", b: "x" }))).not.toBe(hashUntracked(["a", "b"], content({ a: "x", b: "" })));
    });

    it.runIf(process.platform !== "win32")("a modified file with a multiline name makes the proof stale", async () => {
      write(repo, "a\nb.txt", "one\n");
      const id = await start(e.s, "build-feature", repo);
      await run(id, "failing_test_before");
      fix();
      commit(repo, "feat");
      await run(id, "tests_after");
      write(repo, "a\nb.txt", "two\n");
      const status = await e.s.call("gate_status", { gateId: id });
      expect(status.data.steps.find((s: { id: string }) => s.id === "tests_after").status).toBe("missing");
    });

    it("a file with an accented name, a space or a single quote also counts", async () => {
      write(repo, "dir é/it's.txt", "one\n");
      const id = await start(e.s, "build-feature", repo);
      await run(id, "tests_after");
      write(repo, "dir é/it's.txt", "two\n");
      const status = await e.s.call("gate_status", { gateId: id });
      expect(status.data.steps.find((s: { id: string }) => s.id === "tests_after").reason).toMatch(/stale/);
    });

    it("an ignored file does not enter the hash", async () => {
      fix();
      write(repo, ".gitignore", "build/\n");
      commit(repo, "ignore");
      write(repo, "build/a.txt", "one\n");
      const id = await start(e.s, "build-feature", repo);
      await run(id, "tests_after");
      write(repo, "build/a.txt", "two\n");
      const status = await e.s.call("gate_status", { gateId: id });
      expect(status.data.steps.find((s: { id: string }) => s.id === "tests_after").status).toBe("proved");
    });
  });

  it("the latest proof for the final state decides", async () => {
    const id = await provedBuildFeature();
    writeFileSync(join(repo, "build.js"), "process.exit(1);\n");
    commit(repo, "break");
    await run(id, "build");
    const closed = await close(id);
    expect(closed.data.missing.join()).toMatch(/build/);
  });

  it("failing test on the same commit, different state: TDD accepted", async () => {
    const id = await start(e.s, "build-feature", repo);
    for (const step of ["requirements", "edge_cases", "plan"]) await e.s.call("gate_note", { gateId: id, step, note: "n" });
    write(repo, "wip.txt", "in progress\n");
    await run(id, "failing_test_before");
    fix();
    for (const step of ["tests_after", "lint", "build"]) await run(id, step);
    expect((await close(id)).data.score).toBe(10);
  });

  it("a \"before\" taken on the final state does not count", async () => {
    fix();
    commit(repo, "green");
    const id = await start(e.s, "clean-up", repo);
    for (const step of ["tests_before", "lint_before", "tests_after", "lint_after", "build"]) await run(id, step);
    const closed = await close(id);
    expect(closed.data.score).toBeLessThan(10);
    expect(closed.data.missing.join()).toMatch(/tests_before/);
  });

  it("a \"before\" on a commit that is not an ancestor does not count", async () => {
    const base = sh(repo, "rev-parse", "HEAD");
    sh(repo, "checkout", "-q", "-b", "other");
    write(repo, "x.txt", "x\n");
    commit(repo, "elsewhere");
    const id = await start(e.s, "build-feature", repo);
    await run(id, "failing_test_before");
    sh(repo, "checkout", "-q", base);
    sh(repo, "checkout", "-q", "-b", "fix");
    fix();
    commit(repo, "feat");
    await run(id, "tests_after");
    const closed = await close(id);
    expect(closed.data.missing.join()).toMatch(/failing_test_before/);
  });

  it("a \"before\" taken after the final proofs does not count", async () => {
    const id = await start(e.s, "build-feature", repo);
    fix();
    commit(repo, "feat");
    await run(id, "tests_after");
    write(repo, "lib.js", "module.exports = 'ko';\n");
    await run(id, "failing_test_before");
    sh(repo, "checkout", "--", "lib.js");
    const closed = await close(id);
    expect(closed.data.missing.join()).toMatch(/failing_test_before/);
  });

  it("the failing test must really fail", async () => {
    fix();
    commit(repo, "green");
    const id = await start(e.s, "build-feature", repo);
    const r = await run(id, "failing_test_before");
    expect(r.data).toMatchObject({ exitCode: 0, ok: false });
    write(repo, "z.txt", "z\n");
    commit(repo, "z");
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "failing_test_before").status).toBe("missing");
  });

  it("a timeout is not a failing test", async () => {
    const id = await start(e.s, "build-feature", repo, {
      commands: { ...COMMANDS, test: [process.execPath, "hang.js"] },
    });
    const r = await run(id, "failing_test_before", { timeoutMs: 300 });
    expect(r.data).toMatchObject({ exitCode: null, ok: false });
  });

  it("compares lint with the full count, not the truncated output", async () => {
    write(repo, "lint.txt", "w: Warning: x\n".repeat(5000));
    fix();
    commit(repo, "many");
    const id = await start(e.s, "clean-up", repo);
    const before = await run(id, "lint_before");
    expect(before.data.warnings).toEqual({ count: 5000, errors: 0, parser: "android" });
  });

  it("lintMarker counts a literal substring, never a regex", async () => {
    const id = await start(e.s, "clean-up", repo, { lintMarker: "a.kt" });
    expect((await run(id, "lint_before")).data.warnings).toEqual({ count: 1, parser: "marker" });
    write(repo, "lint.txt", "(a+)+$ axkt\n");
    const literal = await start(e.s, "clean-up", repo, { lintMarker: "(a+)+$" });
    expect((await run(literal, "lint_before")).data.warnings.count).toBe(1);
  });

  it("lintRegex no longer exists, and lintMarker cannot be empty", async () => {
    const base = { workflow: "clean-up", repoPath: repo, commands: COMMANDS };
    expect((await e.s.call("gate_start", { ...base, lintRegex: "a" })).isError).toBe(true);
    expect((await e.s.call("gate_start", { ...base, lintMarker: "" })).isError).toBe(true);
  });
});

describe("lint already failing at the start", () => {
  /** Lint exits with 1 as long as lint.txt reports errors. */
  const LINT = "const t = require('node:fs').readFileSync('lint.txt', 'utf8'); console.log(t); process.exit(/^0 errors/m.test(t) ? 0 : 1);\n";

  async function cleaned(before: string, after: string): Promise<{ score: number; missing: string[] }> {
    fix();
    write(repo, "lint.js", LINT);
    write(repo, "lint.txt", before);
    commit(repo, "start");
    const id = await start(e.s, "clean-up", repo);
    await run(id, "tests_before");
    await run(id, "lint_before");
    write(repo, "lint.txt", after);
    commit(repo, "clean");
    for (const step of ["tests_after", "lint_after", "build"]) await run(id, step);
    return (await close(id)).data;
  }

  it("reaches 10 by improving, even while still failing", async () => {
    expect((await cleaned("2 errors, 9 warnings\n", "1 errors, 8 warnings\n")).score).toBe(10);
  });

  it("reaches 10 by going back to green", async () => {
    expect((await cleaned("2 errors, 9 warnings\n", "0 errors, 3 warnings\n")).score).toBe(10);
  });

  it("refuses if errors go up while warnings go down", async () => {
    const closed = await cleaned("1 errors, 9 warnings\n", "3 errors, 2 warnings\n");
    expect(closed.score).toBeLessThan(10);
    expect(closed.missing.join()).toMatch(/lint_after.*errors/);
  });

  it("a lint that crashes afterwards, counting nothing, is not an improvement", async () => {
    const closed = await cleaned("2 errors, 9 warnings\n", "crash\n");
    expect(closed.missing.join()).toMatch(/lint_after/);
  });

  it("a lint green before and failing after does not pass", async () => {
    const closed = await cleaned("0 errors, 9 warnings\n", "1 errors, 2 warnings\n");
    expect(closed.missing.join()).toMatch(/lint_after/);
  });

  it("a lint_before that did not run to completion does not count", async () => {
    const id = await start(e.s, "clean-up", repo, { commands: { ...COMMANDS, lint: [process.execPath, "hang.js"] } });
    expect((await run(id, "lint_before", { timeoutMs: 300 })).data).toMatchObject({ exitCode: null, ok: false });
  });
});

describe("shell wrappers", () => {
  it.each([["cmd"], ["cmd.exe"], ["CMD.EXE"], ["powershell"], ["powershell.exe"], ["pwsh"], ["bash"], ["sh"], ["C:\\Windows\\System32\\cmd.exe"], ["/usr/bin/bash"], ["cmd.exe."]])(
    "gate_start refuses %s",
    async (wrapper) => {
      const r = await e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands: { test: [wrapper, "/c", "echo"] } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/refused/i);
    },
  );

  it("node remains allowed", async () => {
    expect(await start(e.s, "clean-up", repo, { commands: { test: ["node", "test.js"] } })).toBeTruthy();
  });
});

describe("tools", () => {
  it("gate_run accepts no command: only those from gate_start run", async () => {
    const id = await start(e.s, "build-feature", repo);
    const r = await run(id, "tests_after", { command: ["node", "-e", "0"] });
    expect(r.isError).toBe(true);
  });

  it("gate_run refuses a judged or unknown step", async () => {
    const id = await start(e.s, "build-feature", repo);
    expect((await run(id, "plan")).isError).toBe(true);
    expect((await run(id, "unknown")).isError).toBe(true);
  });

  it("gate_note refuses a run step", async () => {
    const id = await start(e.s, "build-feature", repo);
    expect((await e.s.call("gate_note", { gateId: id, step: "lint", note: "ok" })).isError).toBe(true);
  });

  it("a note alone proves nothing", async () => {
    const id = await start(e.s, "build-feature", repo);
    for (const step of ["requirements", "edge_cases", "plan"]) await e.s.call("gate_note", { gateId: id, step, note: "done" });
    expect((await close(id)).data.score).toBe(0);
  });

  it("gate_close refuses the score and note keys", async () => {
    const id = await start(e.s, "build-feature", repo);
    for (const extra of [{ score: 10 }, { note: "10/10" }]) {
      const r = await e.s.call("gate_close", { gateId: id, ...extra });
      expect(r.isError).toBe(true);
      expect(readdirSync(e.gatesDir).length).toBe(1);
    }
    const stored = JSON.parse(readFileSync(join(e.gatesDir, `${id}.json`), "utf8"));
    expect(stored.score).toBeUndefined();
  });

  it("gate_start refuses a command given as a string and a path that is not a repo", async () => {
    expect((await e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands: { test: "npm test" } })).isError).toBe(true);
    expect((await e.s.call("gate_start", { workflow: "clean-up", repoPath: e.tmp, commands: COMMANDS })).isError).toBe(true);
  });

  it("gate_start validates a .bat right at open", async () => {
    write(repo, "gradlew.bat", "@echo off\r\n");
    const r = await e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands: { test: ["gradlew.bat", "a&b"] } });
    expect(r.isError).toBe(process.platform === "win32");
  });

  it("an id that is not a UUID builds no path", async () => {
    const r = await e.s.call("gate_status", { gateId: "../../etc/passwd" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/invalid/i);
  });

  it("refuses a state file whose id does not match its name", async () => {
    const id = await start(e.s, "build-feature", repo);
    const file = join(e.gatesDir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), id: "../../outside" }));
    expect((await e.s.call("gate_status", { gateId: id })).isError).toBe(true);
  });

  it("a step without a command stays missing and says so", async () => {
    const r = await e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands: { test: COMMANDS.test } });
    expect(r.data.missingCommands).toEqual(expect.arrayContaining(["lint", "build"]));
    expect((await run(r.data.gateId, "build")).isError).toBe(true);
  });

  it("does not modify the repo, except what the command does", async () => {
    const id = await provedBuildFeature();
    const before = sh(repo, "status", "--porcelain");
    await e.s.call("gate_status", { gateId: id });
    await close(id);
    expect(sh(repo, "status", "--porcelain")).toBe(before);
  });
});
