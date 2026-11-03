import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CLI_MAX_OUTPUT, CLI_TOOLS, cleanEnv, runCliHelp, validateCliRequest, type CliRunner } from "../src/cli.js";

const ok = (stdout: string, extra: Partial<Awaited<ReturnType<CliRunner>>> = {}): CliRunner => async () => ({ stdout, stderr: "", code: 0, timedOut: false, overflow: false, ...extra });

describe("validateCliRequest", () => {
  it("allows the documented shapes", () => {
    expect(validateCliRequest({ tool: "git" }).argv).toEqual(["--help"]);
    expect(validateCliRequest({ tool: "git", args: ["commit", "--help"] }).argv).toEqual(["commit", "--help"]);
    expect(validateCliRequest({ tool: "git", args: ["help", "commit"] }).argv).toEqual(["help", "commit"]);
    expect(validateCliRequest({ tool: "git", args: ["remote", "add", "-h"] }).argv).toEqual(["remote", "add", "-h"]);
    expect(validateCliRequest({ tool: "node", args: ["--version"] }).argv).toEqual(["--version"]);
    expect(validateCliRequest({ tool: "java", args: ["-version"] }).argv).toEqual(["-version"]);
    expect(validateCliRequest({ tool: "python3", args: ["-V"] }).argv).toEqual(["-V"]);
    expect(validateCliRequest({ tool: "adb", args: ["devices", "--help"] }).argv).toEqual(["devices", "--help"]);
    expect(validateCliRequest({ tool: "docker", args: ["run", "--help"] }).argv).toEqual(["run", "--help"]);
    expect(validateCliRequest({ tool: "npm", args: ["install", "--help"] }).argv).toEqual(["install", "--help"]);
  });

  it("offers exactly the seven allowed tools", () => {
    expect([...CLI_TOOLS]).toEqual(["git", "node", "npm", "adb", "java", "python3", "docker"]);
  });

  it.each(["gradlew", "./gradlew", "gradlew.bat", "mvnw", "gradle", "bash", "sh", "rm", "curl", "../git", "/usr/bin/git", "git ", "GIT", "git;ls", "", "powershell", "cmd"])("refuses unknown tool %j", (tool) => {
    expect(() => validateCliRequest({ tool })).toThrow(/tool not allowed/);
  });

  it.each([
    [["commit", "--help; rm -rf /"]],
    [["commit", "&&", "ls"]],
    [["$(whoami)", "--help"]],
    [["`id`", "--help"]],
    [["commit|cat", "--help"]],
    [["commit", "--help", "> out.txt"]],
    [["--help\n"]],
    [["../x", "--help"]],
    [["-c", "core.pager=sh", "--help"]],
    [["--exec-path=/tmp", "--help"]],
    [["Commit", "--help"]],
    [["a".repeat(41)]],
    [["--help", "commit"]],
    [["commit"]],
    [["a", "b", "c", "d", "--help"]],
    [["commit", "-version"]],
    [[" --help"]],
    [["--help=all"]],
  ])("refuses unsafe or malformed arguments %j", (args) => {
    expect(() => validateCliRequest({ tool: "git", args })).toThrow();
  });

  it("never lets an interpreter run a file, and restricts adb to non-shell sub-commands", () => {
    for (const tool of ["node", "java", "python3"]) {
      expect(() => validateCliRequest({ tool, args: ["script", "--help"] })).toThrow(/single flag/);
      expect(() => validateCliRequest({ tool, args: ["help"] })).toThrow(/single flag/);
    }
    for (const sub of ["shell", "exec-out", "reboot", "root", "sideload"]) {
      expect(() => validateCliRequest({ tool: "adb", args: [sub, "--help"] })).toThrow(/sub-command not allowed/);
    }
  });
});

describe("runCliHelp", () => {
  it("runs the tool in a private directory with a clean environment and no shell", async () => {
    process.env.GITHUB_TOKEN = "ghp_should_not_leak_0123456789abc";
    process.env.NODE_OPTIONS_TEST_SECRET = "leak";
    try {
      let seen: { file: string; argv: string[]; env: Record<string, string>; cwd: string } | undefined;
      const runner: CliRunner = async (file, argv, env, cwd) => {
        seen = { file, argv, env, cwd };
        return { stdout: "usage: git\n", stderr: "", code: 0, timedOut: false, overflow: false };
      };
      const r = await runCliHelp({ tool: "git", args: ["commit", "--help"] }, runner);
      expect(r).toMatchObject({ tool: "git", command: "git commit --help", exitCode: 0, output: "usage: git\n", truncated: false, timedOut: false });
      expect(seen!.file).toBe("git");
      expect(seen!.argv).toEqual(["commit", "--help"]);
      expect(seen!.cwd).not.toBe(tmpdir());
      expect(seen!.cwd.startsWith(tmpdir())).toBe(true);
      expect(Object.keys(seen!.env)).not.toContain("GITHUB_TOKEN");
      expect(Object.keys(seen!.env)).not.toContain("NODE_OPTIONS_TEST_SECRET");
      expect(JSON.stringify(seen!.env)).not.toContain("leak");
      expect(cleanEnv().GIT_PAGER).toBe("cat");
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.NODE_OPTIONS_TEST_SECRET;
    }
  });

  it("merges stderr (java prints its version there) and caps the output at 40 KiB", async () => {
    const merged = await runCliHelp({ tool: "java", args: ["-version"] }, async () => ({ stdout: "", stderr: "openjdk 21", code: 0, timedOut: false, overflow: false }));
    expect(merged.output).toBe("openjdk 21");
    const big = await runCliHelp({ tool: "git" }, ok("x".repeat(CLI_MAX_OUTPUT * 2)));
    expect(Buffer.byteLength(big.output)).toBeLessThanOrEqual(CLI_MAX_OUTPUT);
    expect(big.truncated).toBe(true);
    const overflow = await runCliHelp({ tool: "git" }, ok("partial", { overflow: true }));
    expect(overflow.truncated).toBe(true);
  });

  it("reports missing tools and timeouts", async () => {
    await expect(runCliHelp({ tool: "adb" }, ok("", { code: "ENOENT" }))).rejects.toThrow(/not installed/);
    const t = await runCliHelp({ tool: "docker" }, ok("", { code: 1, timedOut: true }));
    expect(t).toMatchObject({ timedOut: true, exitCode: 1 });
  });

  it("really runs node --version (no shell, no network)", async () => {
    const r = await runCliHelp({ tool: "node", args: ["--version"] });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe(process.version);
  });

  it("really runs npm --version through the node entry point", async () => {
    const r = await runCliHelp({ tool: "npm", args: ["--version"] });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
