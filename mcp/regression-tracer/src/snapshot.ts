import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./git.js";
import { isInvestigationId, type Investigation, type Snapshot } from "./investigation.js";

export type { Snapshot };

export function defaultWorktreesDir(): string {
  return join(homedir(), ".proofbench", "worktrees");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Length of the investigation folder: on Windows, every character of the path counts against the 260 limit. */
const SHORT_ID_LENGTH = 8;

/** The investigation file is not trusted: an id that is not a UUID composes no path. */
function investigationDir(inv: Investigation, baseDir: string): string {
  if (!isInvestigationId(inv.id)) throw new Error(`Invalid investigation id: ${JSON.stringify(inv.id)}`);
  return join(baseDir, inv.id.slice(0, SHORT_ID_LENGTH));
}

function repoPath(inv: Investigation, repoId: string): string {
  const repo = inv.repos.find((r) => r.repoId === repoId);
  if (!repo) {
    const known = inv.repos.map((r) => r.repoId).join(", ") || "none";
    throw new Error(`Unknown repository: ${repoId} (repositories of the investigation: ${known})`);
  }
  return repo.path;
}

/** Rejects any absolute path, Windows drive, or path containing `..`: nothing outside the repository, nothing outside the copy. */
function checkCopyEntry(entry: string): void {
  const bad =
    typeof entry !== "string" ||
    entry === "" ||
    entry.split(/[\\/]/).includes("..") ||
    entry.includes("\0") ||
    isAbsolute(entry) ||
    /^[A-Za-z]:/.test(entry) ||
    entry.startsWith("\\") ||
    entry.startsWith("/");
  if (bad) {
    throw new Error(`copyFiles: path refused (must be relative, without ".."): ${JSON.stringify(entry)}`);
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep);
}

/** The real path, links resolved, including when its end does not exist or no longer exists. */
function realEvenIfGone(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    const parent = dirname(path);
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw e;
    return join(realEvenIfGone(parent), basename(path));
  }
}

function isInWorktrees(path: string, baseDir: string): boolean {
  try {
    return inside(realEvenIfGone(resolve(baseDir)), realEvenIfGone(resolve(path)));
  } catch {
    return false; // unreadable or malformed: nothing says it is inside
  }
}

/** Why this copy is refused, once links are resolved. `null` if it and its files are inside. */
function refusal(snapshot: Snapshot, baseDir: string): string | null {
  const paths = [snapshot.path, ...(snapshot.filesDir === undefined ? [] : [snapshot.filesDir])];
  const outside = paths.filter((path) => !isInWorktrees(path, baseDir));
  return outside.length === 0 ? null : `Working copy refused, outside ${baseDir}: ${JSON.stringify(outside)}`;
}

/**
 * The investigation file can be tampered with: before anything that deletes or cleans up, the copy and its kept files
 * must really be inside the copies folder.
 */
export function assertInWorktrees(snapshot: Snapshot, baseDir: string = defaultWorktreesDir()): void {
  const refused = refusal(snapshot, baseDir);
  if (refused !== null) throw new Error(refused);
}

/**
 * Prepares the destination in the working copy. A commit can contain a symbolic link at
 * the target location or in a parent folder: any link is refused (created by us or already present)
 * and we check that the real folder stays inside the copy. Returns false if the copy must be refused.
 */
function prepareDestination(root: string, rel: string): boolean {
  const rootReal = realpathSync(root);
  const parts = rel.split(/[\\/]/).filter((p) => p !== "" && p !== ".");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  const dst = join(cur, parts[parts.length - 1]!);
  const parentReal = realpathSync(cur);
  if (parentReal !== rootReal && !inside(rootReal, parentReal)) return false;
  try {
    const st = lstatSync(dst);
    if (!st.isFile()) return false; // symbolic link, folder or other: refused
    unlinkSync(dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return true;
}

/**
 * Creates a working copy detached at `ref` for the repository `repoId`, without touching the user's
 * repository (HEAD, branch, index and files stay intact). The `copyFiles` files
 * (untracked, needed for the build) are copied; missing ones are listed in `misses`.
 */
export async function openSnapshot(
  inv: Investigation,
  repoId: string,
  ref: string,
  copyFiles: string[] = [],
  baseDir: string = defaultWorktreesDir(),
): Promise<Snapshot & { misses: string[] }> {
  const repo = repoPath(inv, repoId);
  if (typeof ref !== "string" || ref === "") throw new Error("Empty git reference");
  if (ref.startsWith("-")) throw new Error(`Reference refused (starts with "-"): ${JSON.stringify(ref)}`);
  for (const f of copyFiles) checkCopyEntry(f);

  const verified = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const sha = verified.stdout.trim();
  if (verified.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Unknown reference in ${repoId}: ${ref} (${verified.stderr.trim() || "not found"})`);
  }

  // Two investigations with the same prefix share this folder: the free number keeps their copies separate.
  const invDir = investigationDir(inv, baseDir);
  mkdirSync(invDir, { recursive: true });
  let n = inv.snapshots.length + 1;
  while (existsSync(join(invDir, String(n))) || existsSync(join(invDir, `${n}.files`))) n++;
  const path = join(invDir, String(n));

  const added = await git(repo, ["worktree", "add", "--detach", path, sha]);
  if (added.code !== 0) {
    await git(repo, ["worktree", "prune"]);
    throw new Error(`Cannot create the working copy for ${ref}: ${added.stderr.trim()}`);
  }

  const misses: string[] = [];
  const copied: string[] = [];
  const filesDir = `${path}.files`;
  const repoReal = realpathSync(repo);
  for (const f of copyFiles) {
    const src = resolve(repo, f);
    const dst = resolve(path, f);
    try {
      const st = lstatSync(src);
      if (!st.isFile() || !inside(repoReal, realpathSync(src))) {
        misses.push(f);
        continue;
      }
      if (!prepareDestination(path, f)) {
        misses.push(f);
        continue;
      }
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      // From the copy, not the source: the repository may have changed between the two reads.
      const kept = resolve(filesDir, f);
      mkdirSync(dirname(kept), { recursive: true });
      copyFileSync(dst, kept);
      copied.push(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") {
        misses.push(f);
      } else {
        await removeWorktree(repo, path);
        await rm(filesDir, { recursive: true, force: true });
        throw new Error(`Cannot copy ${f}: ${(e as Error).message}`);
      }
    }
  }

  const stored: Snapshot = { path, repoId, ref, ...(copied.length ? { copyFiles: copied, filesDir } : {}) };
  inv.snapshots.push(stored);
  return { ...stored, misses };
}

/**
 * Restores the `copyFiles` files after a cleanup. A path that still exists is tracked by the
 * current commit: it stays as is, otherwise the test would no longer be about that commit.
 */
export function restoreCopyFiles(snapshot: Snapshot): void {
  if (!snapshot.filesDir) return;
  for (const f of snapshot.copyFiles ?? []) {
    checkCopyEntry(f);
    const dst = resolve(snapshot.path, f);
    if (lstatSync(dst, { throwIfNoEntry: false })) continue;
    if (!prepareDestination(snapshot.path, f)) {
      throw new Error(`Copied file not restored, destination refused: ${f}`);
    }
    copyFileSync(resolve(snapshot.filesDir, f), dst, constants.COPYFILE_EXCL);
  }
}

async function removeWorktree(repo: string, path: string): Promise<string | null> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await git(repo, ["worktree", "remove", "--force", "--force", path]);
    if (r.code === 0 || !existsSync(path)) {
      last = "";
      break;
    }
    last = r.stderr.trim();
    await sleep(200 * (attempt + 1));
  }
  if (existsSync(path)) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      last = `${last} ${(e as Error).message}`.trim();
    }
  }
  await git(repo, ["worktree", "prune"]);
  return existsSync(path) ? last || "folder still present" : null;
}

/**
 * Deletes all the working copies of the investigation. A copy outside the copies folder is refused, and nothing
 * of it is touched. Throws a clear error if one resists.
 */
export async function closeSnapshots(inv: Investigation, baseDir: string = defaultWorktreesDir()): Promise<void> {
  const invDir = investigationDir(inv, baseDir);
  const failures: string[] = [];
  const remaining = [];
  for (const snap of inv.snapshots) {
    const repo = inv.repos.find((r) => r.repoId === snap.repoId)?.path;
    if (!repo) {
      failures.push(`${snap.path}: repository ${snap.repoId} unknown`);
      remaining.push(snap);
      continue;
    }
    const refused = refusal(snap, baseDir);
    if (refused !== null) {
      failures.push(refused);
      remaining.push(snap);
      continue;
    }
    const err = await removeWorktree(repo, snap.path);
    if (err) {
      failures.push(`${snap.path}: ${err}`);
      remaining.push(snap);
    } else if (snap.filesDir) {
      await rm(snap.filesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  inv.snapshots = remaining;
  await rmdir(invDir).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") throw e;
  });
  if (failures.length) {
    throw new Error(`Working copies not deleted:\n${failures.join("\n")}`);
  }
}
