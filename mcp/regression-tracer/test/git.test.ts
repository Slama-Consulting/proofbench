import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

const execFileP = promisify(execFile);
afterEach(cleanupRepos);

describe("git", () => {
  it("git_returns_stdout_and_code", async () => {
    const { path, shas } = await makeRepo({ commits: [{ files: { "a.txt": "hello\n" }, message: "one" }] });
    const r = await git(path, ["rev-parse", "HEAD"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(shas[0]);
  });

  it("git_non_zero_does_not_throw", async () => {
    const { path } = await makeRepo({ commits: [{ files: { "a.txt": "x" }, message: "one" }] });
    const r = await git(path, ["rev-parse", "--verify", "no-such-ref"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("git_works_in_path_with_spaces", async () => {
    const { path } = await makeRepo({
      dirName: "My Projects",
      commits: [{ files: { "a.txt": "x" }, message: "one" }],
    });
    expect(path).toContain("My Projects");
    const r = await git(path, ["log", "--format=%s"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("one");
  });

  it("git_never_uses_shell", async () => {
    const { path } = await makeRepo({
      commits: [{ files: { "a.txt": "x" }, message: "a; echo pwned" }],
    });
    const r = await git(path, ["log", "--grep", "a; echo pwned", "--format=%s"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("a; echo pwned");
  });

  it("fake_git_in_cwd_is_not_executed", async () => {
    const { path } = await makeRepo({ commits: [{ files: { "a.txt": "x" }, message: "one" }] });
    if (process.platform === "win32") {
      await copyFile(process.execPath, join(path, "git.exe"));
    } else {
      await writeFile(join(path, "git"), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
    }
    const r = await git(path, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
  });

  it("nonexistent_cwd_gives_code_minus_one", async () => {
    const r = await git(join(tmpdir(), "rt-does-not-exist-xyz"), ["--version"]);
    expect(r.code).toBe(-1);
  });

  it("timeout_gives_code_minus_one", async () => {
    const { path } = await makeRepo({ commits: [{ files: { "a.txt": "x" }, message: "one" }] });
    const r = await git(path, ["hash-object", "--stdin"], { timeoutMs: 300 });
    expect(r.code).toBe(-1);
  });

  it("crlf_file_is_read_intact", async () => {
    const { path } = await makeRepo({ commits: [{ files: { "a.txt": "l1\r\nl2\r\n" }, message: "crlf" }] });
    const r = await git(path, ["show", "HEAD:a.txt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("l1\r\nl2\r\n");
  });

  it("repo_configured_external_diff_is_not_executed", async () => {
    const { path } = await makeRepo({
      commits: [{ files: { "a.txt": "one\n" }, message: "one" }, { files: { "a.txt": "two\n" }, message: "two" }],
    });
    const marker = join(path, "..", "ext-ran.txt").split("\\").join("/");
    await execFileP("git", ["config", "diff.external", `sh -c "echo x > '${marker}'"`], { cwd: path });
    await git(path, ["diff", "HEAD~1", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
  });
});
