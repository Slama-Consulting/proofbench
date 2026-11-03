import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { cleanEnv, runCliHelp, type CliRunner } from "../src/cli.js";
import { parseToml, parseTomlValue } from "../src/detect/toml.js";

describe("TOML parsing of untrusted manifests", () => {
  it("never pollutes Object.prototype", () => {
    parseToml(
      [
        "[__proto__]",
        'polluted = "section"',
        "[tool.constructor.prototype]",
        'polluted2 = "nested section"',
        "[deps]",
        '__proto__.polluted3 = "dotted key"',
        'constructor.prototype.polluted4 = "dotted key"',
        'inline = { __proto__ = { polluted5 = "inline" } }',
      ].join("\n"),
    );
    parseTomlValue('{ "__proto__" = { polluted6 = "value" } }');
    const probe = {} as Record<string, unknown>;
    for (const k of ["polluted", "polluted2", "polluted3", "polluted4", "polluted5", "polluted6"]) expect(probe[k]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("still parses ordinary keys next to forbidden ones", () => {
    const doc = parseToml(['[deps]', 'serde = "1.0"', '__proto__ = "x"'].join("\n"));
    expect(doc["deps"]!["serde"]).toBe("1.0");
    expect(Object.keys(doc["deps"]!)).not.toContain("__proto__");
  });
});

describe("docs_cli_help isolation", () => {
  it("runs in a private directory that is removed afterwards", async () => {
    let seenCwd = "";
    let seenHome = "";
    const runner: CliRunner = async (_file, _argv, env, cwd) => {
      seenCwd = cwd;
      seenHome = env.HOME ?? "";
      expect(existsSync(cwd)).toBe(true);
      return { stdout: "usage: git", stderr: "", code: 0, timedOut: false, overflow: false };
    };
    await runCliHelp({ tool: "git", args: ["--help"] }, runner);
    expect(seenCwd).not.toBe(tmpdir());
    expect(seenCwd.startsWith(tmpdir())).toBe(true);
    expect(seenHome).toBe(seenCwd);
    expect(existsSync(seenCwd)).toBe(false);
  });

  it("uses a different directory for every call", async () => {
    const dirs: string[] = [];
    const runner: CliRunner = async (_f, _a, _e, cwd) => {
      dirs.push(cwd);
      return { stdout: "ok", stderr: "", code: 0, timedOut: false, overflow: false };
    };
    await runCliHelp({ tool: "git", args: ["--help"] }, runner);
    await runCliHelp({ tool: "git", args: ["--help"] }, runner);
    expect(new Set(dirs).size).toBe(2);
  });

  it("points tool configuration at the private home, not at the user's", () => {
    const env = cleanEnv("/private/home");
    expect(env.HOME).toBe("/private/home");
    expect(env.XDG_CONFIG_HOME).toBe("/private/home");
    expect(env.DOCKER_CONFIG).toBe("/private/home");
  });
});
