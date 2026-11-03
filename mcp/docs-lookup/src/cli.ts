import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InputError } from "./validate.js";

/** System tools whose own help may be run. Nothing else, and never anything that lives inside a repository. */
export const CLI_TOOLS = ["git", "node", "npm", "adb", "java", "python3", "docker"] as const;
export type CliTool = (typeof CLI_TOOLS)[number];

export const CLI_TIMEOUT_MS = 10_000;
export const CLI_MAX_OUTPUT = 40 * 1024;

/** Which positional sub-commands a tool accepts before `--help`. Interpreters take none: `node x` would run a script. */
const SUBCOMMANDS: Record<CliTool, "any" | "none" | ReadonlySet<string>> = {
  git: "any",
  npm: "any",
  docker: "any",
  node: "none",
  java: "none",
  python3: "none",
  adb: new Set([
    "help", "version", "devices", "install", "uninstall", "logcat", "push", "pull", "connect", "disconnect", "forward", "reverse",
    "bugreport", "backup", "restore", "keygen", "get-state", "get-serialno", "get-devpath", "wait-for-device", "mdns", "pair", "jdwp", "track-devices",
  ]),
};

const FLAG = /^(--help|-h|--version|-v|-V|-version)$/;
const WORD = /^[a-z][a-z0-9-]{0,30}$/;

export interface CliRequest {
  tool: string;
  args?: string[] | undefined;
}

/** Validates the request and returns the exact argv to run (without the tool name). Throws InputError. */
export function validateCliRequest(req: CliRequest): { tool: CliTool; argv: string[] } {
  const tool = req.tool;
  if (!(CLI_TOOLS as readonly string[]).includes(tool)) {
    throw new InputError(`tool not allowed: ${JSON.stringify(String(tool).slice(0, 40))}. Allowed: ${CLI_TOOLS.join(", ")}`);
  }
  const t = tool as CliTool;
  const args = req.args ?? [];
  if (args.length > 4) throw new InputError("too many arguments (max 4)");
  for (const a of args) {
    if (typeof a !== "string" || a.length > 40 || !(FLAG.test(a) || WORD.test(a))) {
      throw new InputError(`argument not allowed: ${JSON.stringify(String(a).slice(0, 40))}. Only --help, -h, --version, -V and plain sub-command words are accepted`);
    }
  }
  if (args.length === 0) return { tool: t, argv: ["--help"] };
  const flagIdx = args.findIndex((a) => FLAG.test(a));
  if (flagIdx >= 0 && flagIdx !== args.length - 1) throw new InputError("a flag must be the last argument");
  const words = flagIdx >= 0 ? args.slice(0, -1) : args;
  const rule = SUBCOMMANDS[t];
  if (words.length) {
    if (rule === "none") throw new InputError(`${t} accepts only a single flag such as --help or --version`);
    if (rule !== "any" && !rule.has(words[0]!)) throw new InputError(`sub-command not allowed for ${t}: ${JSON.stringify(words[0])}`);
    if (words.length > 3) throw new InputError("too many sub-commands");
  }
  if (flagIdx >= 0 && words.length && !/^(--help|-h|--version)$/.test(args[args.length - 1]!)) {
    throw new InputError("after a sub-command only --help, -h or --version are accepted");
  }
  if (flagIdx < 0 && words[0] !== "help") {
    throw new InputError("end the arguments with --help, or use `help <sub-command>`");
  }
  return { tool: t, argv: args };
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  code: number | string | null;
  timedOut: boolean;
  overflow: boolean;
}

export type CliRunner = (file: string, argv: string[], env: Record<string, string>, cwd: string) => Promise<RunOutcome>;

export const defaultRunner: CliRunner = (file, argv, env, cwd) =>
  new Promise((resolve) => {
    execFile(
      file,
      argv,
      { cwd, env, timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: CLI_MAX_OUTPUT, windowsHide: true, shell: false, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: e ? (e.code ?? 1) : 0,
          timedOut: e?.killed === true && !/MAXBUFFER/.test(String(e.code)),
          overflow: /MAXBUFFER/.test(String(e?.code)),
        });
      },
    );
  });

/**
 * A clean environment: no inherited variables (tokens, proxies, tool config), pagers off.
 * `home` should be a private directory made for this one call: the shared temp folder is writable by
 * other local processes, which could plant a config file there that the tool would then read.
 */
export function cleanEnv(home: string = tmpdir()): Record<string, string> {
  const tmp = home;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: tmp,
    TMPDIR: tmp,
    LANG: "C",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    XDG_CONFIG_HOME: tmp,
    DOCKER_CONFIG: tmp,
    npm_config_userconfig: join(tmp, ".npmrc"),
    npm_config_globalconfig: join(tmp, "npmrc-global"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "windir", "ComSpec", "PATHEXT"]) {
      const val = process.env[k];
      if (val) env[k] = val;
    }
    env.TEMP = tmp;
    env.TMP = tmp;
    env.USERPROFILE = tmp;
    env.APPDATA = tmp;
    env.LOCALAPPDATA = tmp;
  }
  return env;
}

export interface CliHelpResult {
  tool: string;
  command: string;
  exitCode: number | string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

export async function runCliHelp(req: CliRequest, runner: CliRunner = defaultRunner): Promise<CliHelpResult> {
  const { tool, argv } = validateCliRequest(req);
  let file: string = tool;
  let fullArgv = argv;
  if (tool === "npm" && process.platform === "win32") {
    // npm is a .cmd shim on Windows, which cannot be started without a shell: run its JavaScript entry point with node.
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) throw new Error("npm was not found next to the node executable");
    file = process.execPath;
    fullArgv = [cli, ...argv];
  }
  const home = mkdtempSync(join(tmpdir(), "docs-cli-")); // mode 0700: private to this call
  let started: RunOutcome;
  try {
    started = await runner(file, fullArgv, cleanEnv(home), home);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (started.code === "ENOENT") throw new Error(`${tool} is not installed or not on PATH`);
  let output = started.stdout + (started.stderr ? (started.stdout && !started.stdout.endsWith("\n") ? "\n" : "") + started.stderr : "");
  let truncated = started.overflow;
  if (Buffer.byteLength(output) > CLI_MAX_OUTPUT) {
    output = Buffer.from(output).subarray(0, CLI_MAX_OUTPUT).toString("utf8");
    truncated = true;
  }
  return {
    tool,
    command: `${tool} ${argv.join(" ")}`,
    exitCode: started.code,
    output,
    truncated,
    timedOut: started.timedOut,
  };
}
