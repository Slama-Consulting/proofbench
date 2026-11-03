import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

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
 * Looks up an executable only in the absolute directories of PATH (never the cwd, never
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
 * Runs git without a shell (execFile) with an absolute path resolved outside the cwd. Never throws:
 * the exit code is returned; git not found, a launch failure or a timeout give
 * code -1 with the reason in stderr.
 *
 * Note for callers: the repository config must not execute code. Neutralised here:
 * core.fsmonitor, core.hooksPath and diff.external (empty: a `git diff` without --no-ext-diff fails instead of
 * running the repository's command). textconv is NOT neutralised globally: any diff/show/log -p style command must receive --no-ext-diff and --no-textconv.
 */
export function git(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<GitResult> {
  const exe = gitPath();
  if (!exe) {
    return Promise.resolve({ stdout: "", stderr: "git not found in PATH (or invalid GIT_PATH)", code: -1 });
  }
  if (sameDir(dirname(exe), cwd)) {
    return Promise.resolve({ stdout: "", stderr: "git resolved inside the analysed repository: refused", code: -1 });
  }
  return new Promise((resolvePromise) => {
    const child = execFile(
      exe,
      [
        "-c", "core.quotePath=false",
        "-c", "core.fsmonitor=false",
        "-c", "diff.external=",
        "-c", `core.hooksPath=${NULL_DEVICE}`,
        ...args,
      ],
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: buildEnv(),
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
