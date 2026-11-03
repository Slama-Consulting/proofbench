import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findOnPath } from "./git.js";
import { isSecretEnv, redact } from "./secrets.js";

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const OUTPUT_CAP = 20_000;
/** After the kill, time allowed for the output to close before giving up and returning anyway. */
const KILL_GRACE_MS = 3_000;
const STRIPPED_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);
const IS_WIN = process.platform === "win32";
const SHELL_META_RE = /[&|<>^%!"\r\n]/;
const BATCH_RE = /\.(bat|cmd)[\s.]*$/i;
const STRICT_BATCH_RE = /\.(bat|cmd)$/i;
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh"]);

export interface RunResult {
  /** `null`: no usable code (launch failure, signal, timeout, output too long). */
  exitCode: number | null;
  failure?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface ResolvedCommand {
  file: string;
  args: string[];
  verbatim: boolean;
}

/** The code under test receives neither the server's credentials nor its caller's git settings. */
export function commandEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !STRIPPED_ENV.has(k.toUpperCase()) && !isSecretEnv(k, v)),
  );
}

function refuse(why: string): never {
  throw new Error(`Command refused: ${why}`);
}

/**
 * A .bat or .cmd cannot run without cmd.exe. Only a file inside the repo qualifies, and no argument may
 * carry a metacharacter. The returned path is relative: the repo's own path never enters the cmd.exe line.
 */
function resolveBatch(command: string[], root: string): ResolvedCommand {
  const [script] = command as [string];
  if (!STRICT_BATCH_RE.test(script)) refuse(`ambiguous extension: ${JSON.stringify(script)}`);
  for (const arg of command) {
    if (SHELL_META_RE.test(arg)) refuse(`metacharacter in ${JSON.stringify(arg)}`);
  }
  const real = realpathSync(root);
  const full = resolve(root, script);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st?.isFile() || st.isSymbolicLink()) refuse(`${JSON.stringify(script)} is not a file in the repo`);
  const rel = relative(real, realpathSync(full));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) refuse(`${JSON.stringify(script)} is outside the repo`);
  if (SHELL_META_RE.test(rel)) refuse(`metacharacter in ${JSON.stringify(rel)}`);
  const line = [`.\\${rel.split("/").join("\\")}`, ...command.slice(1)].map((a) => `"${a}"`).join(" ");
  const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  return { file: cmd, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

export function resolveCommand(command: string[], root: string, platform: string = process.platform): ResolvedCommand {
  const [file, ...args] = command;
  if (!file) refuse("empty command");
  // Otherwise a single argument would bring back the shell that everything else avoids.
  if (SHELLS.has(baseName(file))) refuse(`no shell at the head of a command: ${JSON.stringify(file)}`);
  if (platform === "win32" && BATCH_RE.test(file)) return resolveBatch(command, root);
  return { file, args, verbatim: false };
}

export const baseName = (file: string) => file.split(/[\\/]/).at(-1)?.toLowerCase().replace(/[\s.]+$/, "").replace(/\.exe$/, "") ?? "";

function isInsideLexically(path: string, root: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function insideRepo(path: string, root: string): boolean {
  const full = resolve(root, path);
  if (!existsSync(full)) return false;
  const rel = relative(realpathSync(root), realpathSync(full));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Two forms only: `node --test [repo-relative paths]`, or `node <repo script> [arguments]`.
 * No other option exists. This filter stops a mistake, not a hostile command: the script does what it wants.
 */
function checkNode(command: string[], root: string, allowMissing: boolean): void {
  const present = (path: string) => insideRepo(path, root) || (allowMissing && !existsSync(resolve(root, path)) && isInsideLexically(path, root));
  const [first, ...rest] = command.slice(1);
  if (first === undefined) refuse("node without a repo script");
  if (first === "--test") {
    for (const path of rest) {
      if (path.startsWith("-") || isAbsolute(path) || !present(path)) refuse(`test path: ${JSON.stringify(path)}`);
    }
    return;
  }
  const notFile = existsSync(resolve(root, first)) && !lstatSync(resolve(root, first)).isFile();
  if (first.startsWith("-") || !present(first) || notFile) refuse(`node requires a repo script first: ${JSON.stringify(first)}`);
}

/** Two spellings of the same command have the same key. */
export function commandKey(command: string[], root: string): string {
  const normal = command.slice(1).map((arg) => {
    const full = resolve(root, arg);
    return !arg.startsWith("-") && existsSync(full) ? relative(realpathSync(root), realpathSync(full)) : arg;
  });
  return JSON.stringify([baseName(command[0] as string), ...normal]);
}

/** A name that does not resolve would fail at every step, and a launch failure is not a failing test. */
function checkResolvable(file: string, root: string): void {
  const found = /[\\/]/.test(file) ? existsSync(resolve(root, file)) : findOnPath(file.replace(/\.exe$/i, "")) !== null;
  if (found) return;
  throw new Error(`Command not found: ${JSON.stringify(file)}. On Windows, npm, npx and gradle are .cmd files outside the repo: call node with the tool's path, or gradlew.bat.`);
}

/** Up-front check. Commands are arrays; the first element is the executable. */
export function checkCommand(command: string[], root: string, allowMissing = false): void {
  const { file } = resolveCommand(command, root);
  if (baseName(command[0] as string) === "node") checkNode(command, root, allowMissing);
  if (file === command[0]) checkResolvable(file, root);
}

/** Also kills descendants: a surviving grandchild would keep the output open, and the copy busy. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WIN) {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function resultOf(error: ExecFileException | null, stdout: string, stderr: string, timedOut: boolean): RunResult {
  // On Windows, killing a process gives exit code 1: a timeout must not pass for a failing test.
  if (timedOut) return { exitCode: null, failure: "timed out", timedOut, stdout, stderr };
  if (!error) return { exitCode: 0, timedOut, stdout, stderr };
  if (typeof error.code === "number" && !error.signal) return { exitCode: error.code, timedOut, stdout, stderr };
  return { exitCode: null, failure: error.signal ? `signal ${error.signal}` : error.message, timedOut, stdout, stderr };
}

/** No shell. Never throws for a command failure; a refused .bat throws. */
export function runCommand(command: string[], cwd: string, limitMs: number): Promise<RunResult> {
  const { file, args, verbatim } = resolveCommand(command, cwd);
  return new Promise((done) => {
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      done(result);
    };
    const options = {
      cwd,
      env: commandEnv(),
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      // `detached` creates the process group that killTree targets outside Windows.
      detached: !IS_WIN,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8" as const,
    };
    let child: ChildProcess;
    try {
      child = execFile(file, args, options, (error, stdout, stderr) => settle(resultOf(error, stdout, stderr, timedOut)));
    } catch (e) {
      settle({ exitCode: null, failure: (e as Error).message, timedOut, stdout: "", stderr: "" });
      return;
    }
    child.stdin?.end();
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree(child);
        timers.push(setTimeout(() => settle({ exitCode: null, failure: "forced stop", timedOut, stdout: "", stderr: "" }), KILL_GRACE_MS));
      }, limitMs),
    );
  });
}

/** Redact before cutting: a secret straddling the limit must not leak half of itself. The tail carries the failure. */
export function storedOutput(text: string, cap: number = OUTPUT_CAP): string {
  const clean = redact(text);
  return clean.length > cap ? `[truncated]\n${clean.slice(-cap)}` : clean;
}
