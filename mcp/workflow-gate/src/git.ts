import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const IS_WIN = process.platform === "win32";
const NULL_DEVICE = IS_WIN ? "NUL" : "/dev/null";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function sameDir(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Looks for an executable in the absolute PATH folders only (never the cwd, never
 * empty or relative entries). `override` (absolute) takes priority. `base` has no extension.
 */
export function findOnPath(base: string, override?: string): string | null {
  if (override && isAbsolute(override) && isFile(override)) return override;
  const name = IS_WIN ? `${base}.exe` : base;
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  const here = process.cwd();
  for (const entry of pathVar.split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir) || sameDir(dir, here)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate) && isFile(candidate)) return candidate;
  }
  return null;
}

function findGit(): string | null {
  return findOnPath("git", process.env.GIT_PATH);
}

let resolved: string | null | undefined;
function gitPath(): string | null {
  if (resolved === undefined) resolved = findGit();
  return resolved;
}

const SAFE_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", `core.hooksPath=${NULL_DEVICE}`,
];

const STRIPPED_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (STRIPPED_ENV.has(key) || key === "GIT_OPTIONAL_LOCKS" || key === "LC_ALL" || key === "GIT_TERMINAL_PROMPT") continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  return env;
}

/**
 * Runs git without a shell (execFile) using an absolute path resolved outside the cwd. Never throws:
 * the exit code is returned; git not found, launch failure or timeout give
 * code -1 with the reason in stderr.
 *
 * Note for callers: the repo's config must not execute code. Neutralised here are
 * core.fsmonitor, core.hooksPath and diff.external (empty: a `git diff` without --no-ext-diff fails instead of
 * running the repo's command). textconv is NOT neutralised globally: any diff/show/log -p style command must receive --no-ext-diff and --no-textconv.
 */
export function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  const exe = gitPath();
  if (!exe) {
    return Promise.resolve({ stdout: "", stderr: "git not found in PATH (or GIT_PATH invalid)", code: -1 });
  }
  if (sameDir(dirname(exe), cwd)) {
    return Promise.resolve({ stdout: "", stderr: "git resolved inside the analysed repo: refused", code: -1 });
  }
  return new Promise((resolvePromise) => {
    const child = execFile(
      exe,
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...buildEnv(), ...opts.env },
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, code: 0 });
        } else if (typeof error.code === "number") {
          resolvePromise({ stdout, stderr, code: error.code });
        } else {
          resolvePromise({ stdout, stderr: `${stderr}${error.message}`, code: -1 });
        }
      },
    );
    if (opts.input !== undefined) {
      // A git that exits early closes stdin: the write error must not kill the server.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.input);
    }
  });
}

/**
 * Like `git`, line by line: `git log -p` on a real repo overflows any buffer. Code -1 if the timeout is exceeded,
 * so that an incomplete walk never passes for a walk with no result.
 */
export function gitLines(cwd: string, args: string[], onLine: (line: string) => void, timeoutMs: number): Promise<GitResult> {
  const exe = gitPath();
  if (!exe) return Promise.resolve({ stdout: "", stderr: "git not found in PATH (or GIT_PATH invalid)", code: -1 });
  if (sameDir(dirname(exe), cwd)) return Promise.resolve({ stdout: "", stderr: "git resolved inside the analysed repo: refused", code: -1 });
  return new Promise((done) => {
    const child = spawn(exe, [...SAFE_CONFIG, ...args], { cwd, env: buildEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", onLine);
    const closed = new Promise((r) => lines.once("close", r));
    child.on("error", (e) => done({ stdout: "", stderr: e.message, code: -1 }));
    child.on("close", (code, signal) => {
      void closed.then(() => done({ stdout: "", stderr, code: signal || code === null ? -1 : code }));
    });
  });
}
