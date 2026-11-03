import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CommitSpec {
  /** Relative path -> content; `null` deletes the file. */
  files: Record<string, string | null>;
  message: string;
  tag?: string;
  /** If given, switch to this branch (created from HEAD if needed) before the commit. */
  branch?: string;
}

export interface RepoSpec {
  commits: CommitSpec[];
  dirName?: string;
}

const roots: string[] = [];

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function makeRepo(spec: RepoSpec): Promise<{ path: string; shas: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "rt-"));
  roots.push(root);
  const path = join(root, spec.dirName ?? "repo");
  await mkdir(path, { recursive: true });
  await g(path, ["init", "-q", "-b", "main"]);
  await g(path, ["config", "user.name", "Test"]);
  await g(path, ["config", "user.email", "test@example.com"]);
  await g(path, ["config", "core.autocrlf", "false"]);
  await g(path, ["config", "commit.gpgsign", "false"]);

  const shas: string[] = [];
  for (const c of spec.commits) {
    if (c.branch) {
      const exists = await run("git", ["rev-parse", "--verify", "-q", `refs/heads/${c.branch}`], { cwd: path })
        .then(() => true, () => false);
      await g(path, exists ? ["checkout", "-q", c.branch] : ["checkout", "-q", "-b", c.branch]);
    }
    for (const [file, content] of Object.entries(c.files)) {
      const full = join(path, file);
      if (content === null) {
        await rm(full, { force: true });
      } else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      }
    }
    await g(path, ["add", "-A"]);
    await g(path, ["commit", "-q", "--allow-empty", "-m", c.message]);
    shas.push(await g(path, ["rev-parse", "HEAD"]));
    if (c.tag) await g(path, ["tag", c.tag]);
  }
  return { path, shas };
}

/** To call in afterEach/afterAll: deletes all the temporary repositories created. */
export async function cleanupRepos(): Promise<void> {
  const todo = roots.splice(0);
  await Promise.all(todo.map((r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
}
