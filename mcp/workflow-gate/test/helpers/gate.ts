import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, type Connected } from "./mcp.js";

export const NODE = process.execPath;
export const COMMANDS = {
  test: [NODE, "test.js"],
  lint: [NODE, "lint.js"],
  build: [NODE, "build.js"],
};

/** Ends like `node --test`, so that the server reads a test count. */
export const TEST_JS = "const ok = require('./lib.js') === 'ok';\nconsole.log(`ℹ tests 1\\nℹ pass ${ok ? 1 : 0}\\nℹ fail ${ok ? 0 : 1}\\nℹ skipped 0`);\nprocess.exit(ok ? 0 : 1);\n";

/** `test.js` fails until lib.js says `ok`; `lint.js` echoes lint.txt. */
export const FILES: Record<string, string> = {
  "lib.js": "module.exports = 'ko';\n",
  "test.js": TEST_JS,
  "lint.js": "console.log(require('node:fs').readFileSync('lint.txt', 'utf8'));\n",
  "lint.txt": "a.kt:1: Warning: x [Y]\nb.kt:2: Warning: z [Y]\n0 errors, 2 warnings\n",
  "build.js": "process.exit(0);\n",
  "hang.js": "setTimeout(() => undefined, 60000);\n",
};

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function write(repo: string, file: string, text: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}

export function commit(repo: string, message: string): string {
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", message);
  return sh(repo, "rev-parse", "HEAD");
}

export interface Env {
  tmp: string;
  gatesDir: string;
  worktreesDir: string;
  configPath: string;
  s: Connected;
  done(): Promise<void>;
}

export async function env(): Promise<Env> {
  const tmp = mkdtempSync(join(tmpdir(), "wgs-"));
  const paths = {
    gatesDir: join(tmp, "gates"),
    worktreesDir: join(tmp, "wt"),
    configPath: join(tmp, "config.json"),
  };
  const s = await connect(paths);
  return {
    tmp,
    ...paths,
    s,
    async done() {
      await s.close();
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function start(s: Connected, workflow: string, repoPath: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await s.call("gate_start", { workflow, repoPath, commands: COMMANDS, ...extra });
  if (r.isError) throw new Error(r.text);
  return r.data.gateId as string;
}
