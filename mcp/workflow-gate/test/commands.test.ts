import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, env, FILES, NODE, start, write, type Env } from "./helpers/gate.js";
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

const open = (commands: Record<string, string[]>) => e.s.call("gate_start", { workflow: "clean-up", repoPath: repo, commands });

describe("no-effect commands", () => {
  it.each([["-e"], ["--eval"], ["-p"], ["--print"], ["-pe"], ["--eval=process.exit(0)"], ["--print=1"]])("refuses node %s", async (flag) => {
    for (const exe of ["node", NODE]) {
      const r = await open({ test: [exe, flag, "0"] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/refused/i);
    }
  });

  it("lets -e through after the script, which owns it", async () => {
    expect((await open({ test: [NODE, "test.js", "-e"] })).isError).toBe(false);
  });

  it("refuses the same command for two steps", async () => {
    const r = await open({ test: COMMANDS.test, lint: COMMANDS.test });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/identical/i);
    expect((await open({ test: COMMANDS.test, build: COMMANDS.test })).isError).toBe(true);
  });

  it("failingTest may reuse test", async () => {
    expect((await open({ test: COMMANDS.test, failingTest: COMMANDS.test })).isError).toBe(false);
  });
});

describe("node: allowlist", () => {
  it.each([
    [["--import", "./x.mjs", "test.js"]],
    [["--import=./x.mjs", "test.js"]],
    [["--loader", "./x.mjs", "test.js"]],
    [["--experimental-loader=./x.mjs", "test.js"]],
    [["-r", "./x.js", "test.js"]],
    [["--require", "./x.js", "test.js"]],
    [["--input-type=module", "test.js"]],
    [["--input-type", "module", "test.js"]],
    [["--test-reporter", "data:text/javascript,0", "test.js"]],
    [["--test-reporter=http://x/y.js", "test.js"]],
    [["data:text/javascript,process.exit(0)"]],
    [["http://x/y.js"]],
    [["absent.js"]],
    [["../outside.js"]],
    [["--version"]],
    [[]],
    [["--run", "test"]],
    [["--env-file=.env", "test.js"]],
    [["-c", "test.js"]],
    [["-"]],
    [["--", "test.js"]],
    [["--test-reporter-destination", "x", "test.js"]],
    [["--conditions", "--test"]],
    [["--max-old-space-size=512", "test.js"]],
    [["--conditions", "dev", "test.js"]],
    [["--test", "--test-reporter", "spec"]],
    [["--test", "absent.test.js"]],
    [["--test", "../outside.test.js"]],
    [["--test", "--", "test.js"]],
  ])("refuses node %j", async (args) => {
    const r = await open({ test: [NODE, ...args] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/refused/i);
  });

  it("refuses a script outside the repo by absolute path", async () => {
    write(e.tmp, "x.js", "0;\n");
    expect((await open({ test: [NODE, join(e.tmp, "x.js")] })).isError).toBe(true);
    expect((await open({ test: [NODE, "--test", join(repo, "test.js")] })).isError).toBe(true);
  });

  it.each([
    [["--test"]],
    [["--test", "test.js", "lint.js"]],
    [["test.js"]],
    [["test.js", "--import", "this-is-for-the-script"]],
  ])("accepts node %j", async (args) => {
    expect((await open({ test: [NODE, ...args] })).isError).toBe(false);
  });

  it("normalizes paths before comparing steps", async () => {
    const r = await open({ test: [NODE, "test.js"], lint: ["node", "./test.js"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/identical/i);
    expect((await open({ test: [NODE, "test.js"], lint: [NODE, join(repo, "test.js")] })).isError).toBe(true);
  });
});

describe("command not found", () => {
  it("refuses an executable that does not resolve, with the Windows note", async () => {
    const r = await open({ test: ["does-not-exist-at-all", "x"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
    expect(r.text).toMatch(/Windows/);
  });

  it("refuses a relative path missing from the repo", async () => {
    expect((await open({ test: ["./absent"] })).isError).toBe(true);
  });

  it("accepts node by name and by absolute path", async () => {
    expect(await start(e.s, "clean-up", repo, { commands: { test: ["node", "test.js"], lint: [NODE, "lint.js"] } })).toBeTruthy();
  });
});
