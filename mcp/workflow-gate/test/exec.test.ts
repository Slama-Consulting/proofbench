import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandEnv, resolveCommand, runCommand, storedOutput } from "../src/exec.js";

const NODE = process.execPath;
let repo: string;
let outside: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "wg exec "));
  outside = mkdtempSync(join(tmpdir(), "wg out "));
  writeFileSync(join(repo, "gradlew.bat"), "@echo off\r\necho got %1 %2\r\nexit /b 3\r\n");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "run.cmd"), "@echo off\r\nexit /b 0\r\n");
  writeFileSync(join(outside, "evil.bat"), "@echo off\r\n");
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveCommand", () => {
  it("leaves an ordinary command intact, without a shell", () => {
    expect(resolveCommand([NODE, "a&b"], repo, "win32")).toEqual({ file: NODE, args: ["a&b"], verbatim: false });
  });

  it("runs gradlew.bat through cmd.exe /d /s /c", () => {
    const r = resolveCommand(["gradlew.bat", "test", "--info"], repo, "win32");
    expect(r.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(r.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r.args[3]).toBe('"".\\gradlew.bat" "test" "--info""');
    expect(r.verbatim).toBe(true);
  });

  it("accepts a .cmd relative to the repo", () => {
    expect(resolveCommand(["scripts/run.cmd"], repo, "win32").args[3]).toContain("scripts\\run.cmd");
  });

  it.each(["&", "|", "<", ">", "^", "%", "!", '"', "\n", "\r"])("refuses metacharacter %j in an argument", (c) => {
    expect(() => resolveCommand(["gradlew.bat", `a${c}b`], repo, "win32")).toThrow(/refused/i);
  });

  it("refuses a .bat outside the repo, missing, or named on the PATH", () => {
    expect(() => resolveCommand([join(outside, "evil.bat")], repo, "win32")).toThrow(/refused/i);
    expect(() => resolveCommand(["..\\evil.bat"], repo, "win32")).toThrow(/refused/i);
    expect(() => resolveCommand(["absent.bat"], repo, "win32")).toThrow(/refused/i);
  });

  it("refuses extension variants that would bypass the rule", () => {
    expect(() => resolveCommand(["gradlew.bat."], repo, "win32")).toThrow(/refused/i);
    expect(() => resolveCommand(["gradlew.bat "], repo, "win32")).toThrow(/refused/i);
  });

  it("refuses a symlink to an external .bat", () => {
    try {
      symlinkSync(join(outside, "evil.bat"), join(repo, "link.bat"));
    } catch {
      return; // privilege missing on Windows
    }
    expect(() => resolveCommand(["link.bat"], repo, "win32")).toThrow(/refused/i);
  });
});

describe("runCommand", () => {
  it.runIf(process.platform === "win32")("really runs gradlew.bat in a path with spaces", async () => {
    const r = await runCommand(["gradlew.bat", "one", "two three"], repo, 30_000);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('got "one" "two three"');
  });

  it("returns the exit code and the output, without a shell", async () => {
    const r = await runCommand([NODE, "-e", "console.log('output'); process.exit(4)"], repo, 30_000);
    expect(r).toMatchObject({ exitCode: 4, timedOut: false });
    expect(r.stdout).toContain("output");
  });

  it("a timeout gives no exit code, descendants included", async () => {
    const child = "require('node:child_process').spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio:'inherit'})";
    const started = Date.now();
    const r = await runCommand([NODE, "-e", child], repo, 500);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a command not found gives no exit code", async () => {
    const r = await runCommand(["does-not-exist-at-all"], repo, 30_000);
    expect(r.exitCode).toBeNull();
    expect(r.failure).toBeTruthy();
  });
});

describe("secrets", () => {
  it("removes secrets from the command environment", () => {
    process.env.MY_API_TOKEN = "very-secret-value";
    process.env.GIT_DIR = "x";
    try {
      const e = commandEnv();
      expect(e.MY_API_TOKEN).toBeUndefined();
      expect(e.GIT_DIR).toBeUndefined();
      expect(e.PATH ?? e.Path).toBeDefined();
    } finally {
      delete process.env.MY_API_TOKEN;
      delete process.env.GIT_DIR;
    }
  });

  it("masks before truncating and keeps the tail", () => {
    process.env.MY_API_TOKEN = "very-secret-value";
    try {
      const text = `very-secret-value ${"x".repeat(50_000)} ghp_${"a".repeat(36)} end`;
      const out = storedOutput(text);
      expect(out.length).toBeLessThan(21_000);
      expect(out).toContain("[truncated]");
      expect(out).not.toContain("very-secret-value");
      expect(out).not.toContain("a".repeat(36));
      expect(out.endsWith("end")).toBe(true);
    } finally {
      delete process.env.MY_API_TOKEN;
    }
  });
});
