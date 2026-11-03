import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, env, FILES, sh, start, write, type Env } from "./helpers/gate.js";
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

const run = (gateId: string, step: string) => e.s.call("gate_run", { gateId, step });
const buildStatus = async (id: string) => (await e.s.call("gate_status", { gateId: id })).data.steps.find((s: { id: string }) => s.id === "build");

async function proved(extra = {}): Promise<string> {
  const id = await start(e.s, "build-feature", repo, extra);
  await run(id, "build");
  expect((await buildStatus(id)).status).toBe("proved");
  return id;
}

describe("C5: the repo state", () => {
  it.each([["--assume-unchanged"], ["--skip-worktree"]])("refuses an index entry flagged %s", async (flag) => {
    const id = await start(e.s, "build-feature", repo);
    sh(repo, "update-index", flag, "lib.js");
    const r = await run(id, "build");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/index/i);
  });

  it("the content of a nested repo enters the hash", async () => {
    write(repo, "sub/a.txt", "one\n");
    sh(join(repo, "sub"), "init", "-q");
    const id = await proved();
    write(repo, "sub/a.txt", "two\n");
    expect((await buildStatus(id)).status).toBe("missing");
  });

  it("a file hidden by .git/info/exclude enters the hash", async () => {
    appendFileSync(join(repo, ".git", "info", "exclude"), "cache.txt\n");
    write(repo, "cache.txt", "one\n");
    const id = await proved();
    write(repo, "cache.txt", "two\n");
    expect((await buildStatus(id)).status).toBe("missing");
  });

  it("an ignored file under watchIgnored enters the hash, the others do not", async () => {
    write(repo, ".gitignore", "gen/\nout/\n");
    commit(repo, "ignore");
    write(repo, "gen/a.kt", "one\n");
    write(repo, "out/a.txt", "one\n");
    const id = await proved({ watchIgnored: ["gen"] });
    write(repo, "out/a.txt", "two\n");
    expect((await buildStatus(id)).status).toBe("proved");
    write(repo, "gen/a.kt", "two\n");
    expect((await buildStatus(id)).status).toBe("missing");
  });

  it("watchIgnored refuses a path outside the repo", async () => {
    const r = await e.s.call("gate_start", { workflow: "build-feature", repoPath: repo, commands: {}, watchIgnored: ["../x"] });
    expect(r.isError).toBe(true);
  });

  it("the report says the other ignored files are excluded", async () => {
    const closed = await e.s.call("gate_close", { gateId: await start(e.s, "build-feature", repo) });
    expect(readFileSync(closed.data.reportPath, "utf8")).toMatch(/ignored/);
  });

  it("a report from another gate makes nothing stale: .proofbench does not enter the state", async () => {
    const id = await proved();
    write(repo, ".proofbench/reports/old.md", "x\n");
    expect((await buildStatus(id)).status).toBe("proved");
  });

  it("gate_close excludes .proofbench before reading the state, a 10 stays a 10 on rerun", async () => {
    write(repo, "AndroidManifest.xml", `<manifest><application android:allowBackup="false"/></manifest>`);
    commit(repo, "m");
    const id = await start(e.s, "build-feature", repo);
    await run(id, "build");
    await e.s.call("gate_close", { gateId: id });
    expect((await buildStatus(id)).status).toBe("proved");
  });

  it.each([["a=b"], ["a b"], ["a\"b"]])("refuses a filter named %j, without running anything", async (name) => {
    const id = await start(e.s, "build-feature", repo);
    sh(repo, "config", `filter.${name}.clean`, "cat");
    const r = await e.s.call("gate_status", { gateId: id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/filter/i);
  });

  it("a submodule: its filter does not run, its content and commit count", async () => {
    const other = (await makeRepo({ commits: [{ files: { "a.txt": "one\n", ".gitattributes": "*.txt filter=evil\n" }, message: "sub" }] })).path;
    sh(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", other, "sub");
    commit(repo, "submodule");
    const marker = join(e.tmp, "pwned").replace(/\\/g, "/");
    sh(join(repo, "sub"), "config", "filter.evil.clean", `node -e "require('fs').writeFileSync('${marker}','x')"; cat`);
    const id = await proved();
    rmSync(join(e.tmp, "pwned"), { force: true });
    write(repo, "sub/a.txt", "two\n");
    expect((await buildStatus(id)).status).toBe("missing");
    expect(readdirSync(e.tmp)).not.toContain("pwned");
    sh(join(repo, "sub"), "config", "--unset", "filter.evil.clean");
    sh(join(repo, "sub"), "checkout", "-q", "--", "a.txt");
    expect((await buildStatus(id)).status).toBe("proved");
    sh(join(repo, "sub"), "-c", "user.name=T", "-c", "user.email=t@e.st", "commit", "-q", "--allow-empty", "-m", "more");
    expect((await buildStatus(id)).status).toBe("missing");
  });

  it("a gitlink folder without .git stays in the hash", async () => {
    sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sh(repo, "rev-parse", "HEAD")},sub`);
    sh(repo, "commit", "-q", "-m", "gitlink");
    write(repo, "sub/a.txt", "one\n");
    const id = await proved();
    write(repo, "sub/a.txt", "two\n");
    expect((await buildStatus(id)).status).toBe("missing");
  });

  it("gate_status runs no repo filter", async () => {
    const marker = join(e.tmp, "pwned").replace(/\\/g, "/");
    sh(repo, "config", "filter.evil.clean", `node -e "require('fs').writeFileSync('${marker}','x')"; cat`);
    write(repo, ".gitattributes", "*.js filter=evil\n");
    commit(repo, "attr");
    const id = await start(e.s, "build-feature", repo);
    rmSync(join(e.tmp, "pwned"), { force: true });
    write(repo, "lib.js", "module.exports = 'ok'; // change\n");
    await e.s.call("gate_status", { gateId: id });
    expect(readdirSync(e.tmp)).not.toContain("pwned");
  });
});
