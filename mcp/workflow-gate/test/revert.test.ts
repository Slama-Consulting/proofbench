import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, env, FILES, sh, start, TEST_JS, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;

/** Without the fix, spec.js fails; the test only exists in the fix commit. */
const SPEC = TEST_JS;
const commands = { test: [process.execPath, "test.js"], failingTest: [process.execPath, "spec.js"], lint: [process.execPath, "lint.js"], build: [process.execPath, "build.js"] };

beforeEach(async () => {
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

async function fixed(): Promise<{ id: string; fix: string }> {
  const id = await start(e.s, "fix-bug", repo, { commands });
  write(repo, "spec.js", SPEC);
  await e.s.call("gate_run", { gateId: id, step: "failing_test_before" });
  write(repo, "lib.js", "module.exports = 'ok';\n");
  return { id, fix: commit(repo, "fix") };
}

const revert = (gateId: string, fixCommit: string, testFile = "spec.js") =>
  e.s.call("gate_run", { gateId, step: "revert_fails", fixCommit, testFile });

const leftovers = () =>
  existsSync(e.worktreesDir) ? readdirSync(e.worktreesDir).flatMap((d) => readdirSync(join(e.worktreesDir, d))) : [];

describe("revert_fails", () => {
  it("makes the test fail again without touching the checkout, then cleans up", async () => {
    const { id, fix } = await fixed();
    const before = sh(repo, "status", "--porcelain");
    const r = await revert(id, fix);
    expect(r.data).toMatchObject({ ok: true, controlExitCode: 0 });
    expect(r.data.exitCode).not.toBe(0);
    expect(sh(repo, "status", "--porcelain")).toBe(before);
    expect(readFileSync(join(repo, "lib.js"), "utf8")).toContain("ok");
    expect(sh(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it("gives 10/10 on fix-bug when everything is proved", async () => {
    const { id, fix } = await fixed();
    await e.s.call("gate_note", { gateId: id, step: "same_bug_elsewhere", note: "searched, nothing" });
    await revert(id, fix);
    for (const step of ["test_passes_after", "full_suite", "lint", "build"]) await e.s.call("gate_run", { gateId: id, step });
    expect((await e.s.call("gate_close", { gateId: id })).data).toMatchObject({ score: 10, missing: [] });
  });

  it("a test that passes without the fix is not a proof", async () => {
    const id = await start(e.s, "fix-bug", repo, { commands });
    write(repo, "spec.js", "process.exit(0);\n");
    const fix = commit(repo, "fake fix");
    expect((await revert(id, fix)).data).toMatchObject({ exitCode: 0, ok: false });
  });

  it("a test that also fails with the fix proves nothing: control", async () => {
    const id = await start(e.s, "fix-bug", repo, { commands });
    write(repo, "spec.js", "process.exit(1);\n");
    const fix = commit(repo, "broken test");
    const r = await revert(id, fix);
    expect(r.data.ok).toBe(false);
    expect(r.data.controlExitCode).toBe(1);
    expect(r.data.failure).toMatch(/control/i);
  });

  it("a revert proof goes stale if the commit changes", async () => {
    const { id, fix } = await fixed();
    await revert(id, fix);
    write(repo, "x.txt", "x\n");
    commit(repo, "x");
    const s = await e.s.call("gate_status", { gateId: id });
    expect(s.data.steps.find((x: { id: string }) => x.id === "revert_fails").status).toBe("missing");
  });

  it.each(["../outside.js", "C:/Windows/win.ini", "/etc/passwd", ":(glob)**", ".git/config", "absent.js"])(
    "refuses the test path %s",
    async (path) => {
      const { id, fix } = await fixed();
      expect((await revert(id, fix, path)).isError).toBe(true);
    },
  );

  it("requires testFile and fixCommit, and a commit that is an ancestor of HEAD", async () => {
    const { id, fix } = await fixed();
    expect((await e.s.call("gate_run", { gateId: id, step: "revert_fails" })).isError).toBe(true);
    sh(repo, "checkout", "-q", "HEAD~1");
    expect((await revert(id, fix)).isError).toBe(true);
    expect((await revert(id, "--help")).isError).toBe(true);
  });

  it("refuses testFile on another step", async () => {
    const { id } = await fixed();
    expect((await e.s.call("gate_run", { gateId: id, step: "lint", testFile: "spec.js" })).isError).toBe(true);
    expect((await e.s.call("gate_run", { gateId: id, step: "lint", copyFiles: ["a"] })).isError).toBe(true);
  });

  describe("copyFiles", () => {
    /** The test needs untracked files: without them, it fails even with the fix. */
    const NEEDS = "const fs = require('node:fs'); fs.readFileSync('local.properties'); fs.readFileSync('app/google-services.json'); process.exit(require('./lib.js') === 'ok' ? 0 : 1);\n";

    async function fixedWithLocalFiles(): Promise<{ id: string; fix: string }> {
      write(repo, ".gitignore", "local.properties\ngoogle-services.json\n");
      write(repo, "local.properties", "sdk.dir=C:/sdk\n");
      write(repo, "app/google-services.json", "{}\n");
      write(repo, "spec.js", NEEDS);
      commit(repo, "before");
      write(repo, "lib.js", "module.exports = 'ok';\n");
      write(repo, "spec.js", `${NEEDS}// tweak\n`);
      const fix = commit(repo, "fix");
      return { id: await start(e.s, "fix-bug", repo, { commands }), fix };
    }

    const withCopy = (gateId: string, fixCommit: string, copyFiles: string[]) =>
      e.s.call("gate_run", { gateId, step: "revert_fails", fixCommit, testFile: "spec.js", copyFiles });

    it("without them the control fails, with them the proof holds, including after cleanup", async () => {
      const { id, fix } = await fixedWithLocalFiles();
      expect((await revert(id, fix)).data.ok).toBe(false);
      const r = await withCopy(id, fix, ["local.properties", "app/google-services.json"]);
      expect(r.data).toMatchObject({ ok: true, controlExitCode: 0 });
      expect(leftovers()).toEqual([]);
    });

    it.each(["../outside.txt", "C:/Windows/win.ini", "/etc/passwd", ".git/config", "a/../b", "absent.txt", ""])("refuses %j", async (path) => {
      const { id, fix } = await fixedWithLocalFiles();
      expect((await withCopy(id, fix, [path])).isError).toBe(true);
      expect(leftovers()).toEqual([]);
    });

    it("does not follow a link in the repo", async () => {
      const { id, fix } = await fixedWithLocalFiles();
      write(e.tmp, "outside/secret.txt", "x\n");
      symlinkSync(join(e.tmp, "outside"), join(repo, "link"), "junction");
      const r = await withCopy(id, fix, ["link/secret.txt"]);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/symlink/i);
    });

    it("copyDirs brings in a folder like node_modules, for both runs", async () => {
      write(repo, ".gitignore", "node_modules/\n");
      write(repo, "node_modules/dep/index.js", "module.exports = 1;\n");
      write(repo, "spec.js", "require('./node_modules/dep/index.js'); process.exit(require('./lib.js') === 'ok' ? 0 : 1);\n");
      commit(repo, "before");
      write(repo, "lib.js", "module.exports = 'ok';\n");
      write(repo, "spec.js", "require('./node_modules/dep/index.js'); process.exit(require('./lib.js') === 'ok' ? 0 : 1); // tweak\n");
      const fix = commit(repo, "fix");
      const id = await start(e.s, "fix-bug", repo, { commands });
      const r = await e.s.call("gate_run", { gateId: id, step: "revert_fails", fixCommit: fix, testFile: "spec.js", copyDirs: ["node_modules"] });
      expect(r.data).toMatchObject({ ok: true, controlExitCode: 0 });
    });

    it("copyDirs refuses a path outside the repo, a file, a link", async () => {
      const { id, fix } = await fixedWithLocalFiles();
      const dirs = (copyDirs: string[]) => e.s.call("gate_run", { gateId: id, step: "revert_fails", fixCommit: fix, testFile: "spec.js", copyDirs });
      expect((await dirs([".."])).isError).toBe(true);
      expect((await dirs(["local.properties"])).isError).toBe(true);
      write(e.tmp, "outside/x.txt", "x\n");
      symlinkSync(join(e.tmp, "outside"), join(repo, "link"), "junction");
      expect((await dirs(["link"])).isError).toBe(true);
    });

    it("does not overwrite a tracked file", async () => {
      const { id, fix } = await fixedWithLocalFiles();
      const r = await withCopy(id, fix, ["lib.js"]);
      expect(r.isError).toBe(true);
    });
  });

  it("leaves no copy behind when the commit is unknown", async () => {
    const { id } = await fixed();
    expect((await revert(id, "0000000000000000000000000000000000000000")).isError).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});
