import { afterEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { git } from "../src/git.js";
import { createInvestigation, type Investigation, type Snapshot } from "../src/investigation.js";
import { closeSnapshots, openSnapshot, restoreCopyFiles } from "../src/snapshot.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(async () => {
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-snap-"));
  dirs.push(d);
  return d;
}

async function setup(): Promise<{ inv: Investigation; path: string; shas: string[]; base: string }> {
  const { path, shas } = await makeRepo({
    commits: [
      { files: { "a.txt": "one\n" }, message: "one" },
      { files: { "a.txt": "two\n" }, message: "two" },
    ],
  });
  const inv = createInvestigation(await tmp());
  inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
  return { inv, path, shas, base: await tmp() };
}

describe("snapshot", () => {
  it("copy_files_are_kept_restored_and_removed_on_close", async () => {
    const { inv, path, shas, base } = await setup();
    await writeFile(join(path, "local.env"), "kept\n");
    const snap = await openSnapshot(inv, "r1", shas[0]!, ["local.env", "absent.txt"], base);
    expect(snap.misses).toEqual(["absent.txt"]);
    const stored = JSON.parse(JSON.stringify(inv.snapshots[0]!)) as Snapshot;
    expect(stored.copyFiles).toEqual(["local.env"]);

    await writeFile(join(path, "local.env"), "changed later\n");
    await rm(join(snap.path, "local.env"));
    restoreCopyFiles(stored);
    expect(await readFile(join(snap.path, "local.env"), "utf8")).toBe("kept\n");

    await closeSnapshots(inv, base);
    expect(existsSync(stored.filesDir!)).toBe(false);
    expect(existsSync(dirname(snap.path))).toBe(false);
  });

  it("restore_leaves_a_file_tracked_by_the_current_commit", async () => {
    const { inv, path, shas, base } = await setup();
    await writeFile(join(path, "a.txt"), "local\n");
    const snap = await openSnapshot(inv, "r1", shas[0]!, ["a.txt"], base);
    await git(snap.path, ["checkout", "--", "a.txt"]);
    restoreCopyFiles(inv.snapshots[0]!);
    expect(await readFile(join(snap.path, "a.txt"), "utf8")).toBe("one\n");
    await closeSnapshots(inv, base);
  });

  it("snapshot_is_at_ref", async () => {
    const { inv, shas, base } = await setup();
    const snap = await openSnapshot(inv, "r1", shas[0]!, [], base);
    expect(snap.path.startsWith(base)).toBe(true);
    expect((await git(snap.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(shas[0]);
    expect(await readFile(join(snap.path, "a.txt"), "utf8")).toBe("one\n");
    expect(inv.snapshots).toContainEqual(expect.objectContaining({ path: snap.path, repoId: "r1" }));
    expect(snap.misses).toEqual([]);
  });

  it("does_not_change_user_head_or_status", async () => {
    const { inv, path, shas, base } = await setup();
    await writeFile(join(path, "untracked.txt"), "x");
    const headBefore = (await git(path, ["rev-parse", "HEAD"])).stdout;
    const branchBefore = (await git(path, ["symbolic-ref", "HEAD"])).stdout;
    const statusBefore = (await git(path, ["status", "--porcelain"])).stdout;
    await openSnapshot(inv, "r1", shas[0]!, [], base);
    expect((await git(path, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
    expect((await git(path, ["symbolic-ref", "HEAD"])).stdout).toBe(branchBefore);
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe(statusBefore);
    await closeSnapshots(inv, base);
    expect((await git(path, ["status", "--porcelain"])).stdout).toBe(statusBefore);
  });

  it("copies_local_properties", async () => {
    const { inv, path, shas, base } = await setup();
    await writeFile(join(path, "local.properties"), "sdk.dir=/x\n");
    const snap = await openSnapshot(inv, "r1", shas[0]!, ["local.properties", "absent.txt"], base);
    expect(await readFile(join(snap.path, "local.properties"), "utf8")).toBe("sdk.dir=/x\n");
    expect(snap.misses).toEqual(["absent.txt"]);
  });

  it("copy_files_refuse_escape", async () => {
    const { inv, shas, base } = await setup();
    for (const bad of ["../secret", "a/../../secret", "/etc/passwd", "C:\\Windows\\win.ini", "..\\x"]) {
      await expect(openSnapshot(inv, "r1", shas[0]!, [bad], base)).rejects.toThrow(/copyFiles/);
    }
    expect(inv.snapshots).toEqual([]);
  });

  it("close_removes_worktree_and_metadata", async () => {
    const { inv, path, shas, base } = await setup();
    const a = await openSnapshot(inv, "r1", shas[0]!, [], base);
    const b = await openSnapshot(inv, "r1", shas[1]!, [], base);
    expect(a.path).not.toBe(b.path);
    expect((await git(path, ["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(3);
    await closeSnapshots(inv, base);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    const list = (await git(path, ["worktree", "list", "--porcelain"])).stdout;
    expect(list.match(/^worktree /gm)).toHaveLength(1);
    expect(inv.snapshots).toEqual([]);
    expect(existsSync(join(path, ".git", "worktrees", "1")) || existsSync(join(path, ".git", "worktrees", "2"))).toBe(false);
    expect(existsSync(dirname(a.path))).toBe(false);
  });

  it("unknown_ref_clear_error", async () => {
    const { inv, shas, base } = await setup();
    await expect(openSnapshot(inv, "r1", "no-such-ref", [], base)).rejects.toThrow(/no-such-ref/);
    await expect(openSnapshot(inv, "r1", "--output=x", [], base)).rejects.toThrow(/starts with/);
    await expect(openSnapshot(inv, "nope", shas[0]!, [], base)).rejects.toThrow(/nope/);
    expect(inv.snapshots).toEqual([]);
  });

  it("copy_files_never_writes_through_committed_symlinks", async (ctx) => {
    const { inv, path, base } = await setup();
    const outside = await tmp();
    await writeFile(join(outside, "target.txt"), "ORIGINAL");
    // Commit two symbolic links (target = file outside the repository, and folder outside the repository) via git plumbing.
    const mk = async (name: string, target: string) => {
      const { execFile } = await import("node:child_process");
      const hash: string = await new Promise((res, rej) => {
        const c = execFile("git", ["hash-object", "-w", "--stdin"], { cwd: path }, (e, out) => (e ? rej(e) : res(out.trim())));
        c.stdin!.end(target);
      });
      await git(path, ["update-index", "--add", "--cacheinfo", `120000,${hash},${name}`]);
    };
    await mk("local.properties", join(outside, "target.txt"));
    await mk("sub", outside);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "-m", "links"]);
    const linkSha = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
    // The user's HEAD removes the links and has real untracked files.
    await git(path, ["rm", "-q", "--cached", "local.properties", "sub"]);
    await git(path, ["-c", "user.name=T", "-c", "user.email=t@e.x", "commit", "-q", "-m", "unlink"]);
    await rm(join(path, "local.properties"), { force: true });
    await rm(join(path, "sub"), { force: true, recursive: true });
    await writeFile(join(path, "local.properties"), "REAL");
    await mkdir(join(path, "sub"));
    await writeFile(join(path, "sub", "f.txt"), "REAL");

    // Force core.symlinks=true for git (some Windows configs disable it); restored afterwards.
    const saved = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((k) => [k, process.env[k]] as const);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.symlinks";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    let snap;
    try {
      snap = await openSnapshot(inv, "r1", linkSha, ["local.properties", "sub/f.txt"], base);
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    if (!lstatSync(join(snap.path, "sub")).isSymbolicLink()) {
      ctx.skip(); // the OS did not create symbolic links on checkout (core.symlinks=false)
      return;
    }
    expect(snap.misses.sort()).toEqual(["local.properties", "sub/f.txt"]);
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("ORIGINAL");
    expect(existsSync(join(outside, "f.txt"))).toBe(false);
  });

  it("worktree_directory_uses_the_first_8_characters_of_the_id", async () => {
    const { inv, shas, base } = await setup();
    const snap = await openSnapshot(inv, "r1", shas[0]!, [], base);
    expect(basename(dirname(snap.path))).toBe(inv.id.slice(0, 8));
    expect(dirname(dirname(snap.path))).toBe(base);
    await closeSnapshots(inv, base);
  });

  it("two_investigations_sharing_8_characters_never_share_a_copy", async () => {
    const { inv, path, shas, base } = await setup();
    const twin = createInvestigation(await tmp());
    twin.id = `${inv.id.slice(0, 8)}${twin.id.slice(8)}`;
    twin.repos.push(...inv.repos);
    await writeFile(join(path, "local.env"), "kept\n");
    const first = await openSnapshot(inv, "r1", shas[0]!, ["local.env"], base);
    const second = await openSnapshot(twin, "r1", shas[1]!, ["local.env"], base);
    expect(second.path).not.toBe(first.path);
    expect(second.filesDir).not.toBe(first.filesDir);
    await closeSnapshots(inv, base);
    expect(existsSync(first.path)).toBe(false);
    expect(await readFile(join(second.path, "a.txt"), "utf8")).toBe("two\n");
    await closeSnapshots(twin, base);
    expect(existsSync(dirname(second.path))).toBe(false);
  });

  it("an_investigation_id_that_is_not_a_uuid_is_refused", async () => {
    const { inv, shas, base } = await setup();
    inv.id = "../../evil";
    await expect(openSnapshot(inv, "r1", shas[0]!, [], base)).rejects.toThrow(/Invalid investigation id/);
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/Invalid investigation id/);
  });
});

describe("a copy stays inside the copies folder", () => {
  it("close_refuses_a_real_repo_and_deletes_nothing", async () => {
    const { inv, path, base } = await setup();
    const forged: Snapshot = { path, repoId: "r1", ref: "main" };
    inv.snapshots.push(forged);
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("two\n");
    expect(inv.snapshots).toEqual([forged]);
  });

  it("close_refuses_a_sibling_sharing_the_prefix", async () => {
    const { inv, base } = await setup();
    const sibling = `${base}-sibling`;
    dirs.push(sibling);
    await mkdir(join(sibling, "1"), { recursive: true });
    await writeFile(join(sibling, "1", "keep.txt"), "x");
    const forged: Snapshot = { path: join(sibling, "1"), repoId: "r1", ref: "main" };
    inv.snapshots.push(forged);
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(existsSync(join(sibling, "1", "keep.txt"))).toBe(true);
    expect(inv.snapshots).toEqual([forged]);
  });

  it("close_refuses_a_files_dir_outside_and_keeps_the_copy", async () => {
    const { inv, shas, base } = await setup();
    const snap = await openSnapshot(inv, "r1", shas[0]!, [], base);
    const outside = await tmp();
    await writeFile(join(outside, "keep.txt"), "x");
    inv.snapshots[0]!.filesDir = outside;
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(snap.path)).toBe(true);
    expect(inv.snapshots).toHaveLength(1);
    delete inv.snapshots[0]!.filesDir;
    await closeSnapshots(inv, base);
  });

  it("close_refuses_a_link_that_leaves_the_folder", async () => {
    const { inv, base } = await setup();
    const outside = await tmp();
    await writeFile(join(outside, "keep.txt"), "x");
    const link = join(base, "link");
    symlinkSync(outside, link, "junction");
    inv.snapshots.push({ path: link, repoId: "r1", ref: "main" });
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("close_refuses_the_folder_itself", async () => {
    const { inv, base } = await setup();
    await writeFile(join(base, "keep.txt"), "x");
    inv.snapshots.push({ path: base, repoId: "r1", ref: "main" });
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(existsSync(join(base, "keep.txt"))).toBe(true);
  });

  it("close_refuses_a_path_that_is_not_a_string", async () => {
    const { inv, base } = await setup();
    inv.snapshots.push({ path: null as unknown as string, repoId: "r1", ref: "main" });
    await expect(closeSnapshots(inv, base)).rejects.toThrow(/refused/);
    expect(inv.snapshots).toHaveLength(1);
  });

  it("a_copy_already_gone_still_closes", async () => {
    const { inv, shas, base } = await setup();
    const snap = await openSnapshot(inv, "r1", shas[0]!, [], base);
    await git(inv.repos[0]!.path, ["worktree", "remove", "--force", snap.path]);
    await closeSnapshots(inv, base);
    expect(inv.snapshots).toEqual([]);
  });
});
