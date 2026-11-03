import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";
import { resolveRepo, readConfig } from "../src/repo.js";
import { createInvestigation } from "../src/investigation.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(async () => {
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-repo-"));
  dirs.push(d);
  return d;
}

async function repoWithRemote(url?: string): Promise<string> {
  const { path } = await makeRepo({ commits: [{ files: { "a.txt": "x" }, message: "one" }] });
  if (url) await git(path, ["remote", "add", "origin", url]);
  return path;
}

/** Writes a temporary user config; `key` is the repository key (by default the path itself). */
async function userConfig(path: string, entry: unknown, key: string = path): Promise<string> {
  const file = join(await tmp(), "config.json");
  await writeFile(file, JSON.stringify({ repos: { [key]: entry } }));
  return file;
}

async function inv() {
  return createInvestigation(await tmp());
}

describe("resolveRepo", () => {
  it("detects_gitlab_from_ssh_remote", async () => {
    const i = await inv();
    const ref = await resolveRepo(i, await repoWithRemote("git@gitlab.com:a/b.git"));
    expect(ref.forge).toBe("gitlab");
    expect(ref.capabilities.mrLookup).toBe(true);
    expect(ref.repoId).toBe("R1");
    expect(i.repos).toEqual([ref]);
  });

  it("github_is_detected_but_unsupported", async () => {
    const i = await inv();
    const ref = await resolveRepo(i, await repoWithRemote("https://github.com/a/b"));
    expect(ref.forge).toBe("github");
    expect(ref.capabilities.mrLookup).toBe(false);
    expect(ref.misses.join(" ")).toContain("not supported");
  });

  it("detects_bitbucket_and_azure_as_unsupported", async () => {
    const i = await inv();
    const b = await resolveRepo(i, await repoWithRemote("git@bitbucket.org:a/b.git"));
    const a = await resolveRepo(i, await repoWithRemote("https://dev.azure.com/org/proj/_git/r"));
    expect(b.forge).toBe("bitbucket");
    expect(a.forge).toBe("azure");
    expect(a.repoId).toBe("R2");
    expect(a.misses.join(" ")).toContain("not supported");
  });

  it("unknown_host_is_unknown_without_error", async () => {
    const ref = await resolveRepo(await inv(), await repoWithRemote("git@git.acme.corp:a/b.git"));
    expect(ref.forge).toBe("unknown");
    expect(ref.capabilities.mrLookup).toBe(false);
    expect(ref.misses.length).toBeGreaterThan(0);
  });

  it("config_gitlab_host_makes_it_gitlab", async () => {
    const path = await repoWithRemote("git@git.acme.corp:a/b.git");
    const cfg = await userConfig(path, { forge: "gitlab", gitlabHost: "git.acme.corp" });
    const ref = await resolveRepo(await inv(), path, undefined, cfg);
    expect(ref.forge).toBe("gitlab");
    expect(ref.capabilities.mrLookup).toBe(true);
  });

  it("gitlab_host_alone_matches_remote_host", async () => {
    const path = await repoWithRemote("https://user:secret@git.acme.corp:8443/a/b.git");
    const cfg = await userConfig(path, { gitlabHost: "git.acme.corp" });
    const ref = await resolveRepo(await inv(), path, undefined, cfg);
    expect(ref.forge).toBe("gitlab");
    expect(JSON.stringify(ref)).not.toContain("secret");
  });

  it("override_wins", async () => {
    const ref = await resolveRepo(await inv(), await repoWithRemote("https://github.com/a/b"), "gitlab");
    expect(ref.forge).toBe("gitlab");
  });

  it("no_remote_is_unknown_with_misses", async () => {
    const ref = await resolveRepo(await inv(), await repoWithRemote());
    expect(ref.forge).toBe("unknown");
    expect(ref.misses.join(" ")).toContain("remote");
  });

  it("tickets_capability_follows_jira_projects", async () => {
    const path = await repoWithRemote("git@gitlab.com:a/b.git");
    const cfg = await userConfig(path, { jiraProjects: ["ACME"] });
    expect((await resolveRepo(await inv(), path, undefined, cfg)).capabilities.tickets).toBe(true);
  });

  it("config_inside_the_analyzed_repo_has_no_effect", async () => {
    const path = await repoWithRemote("git@git.acme.corp:a/b.git");
    await mkdir(join(path, ".proofbench"), { recursive: true });
    await writeFile(
      join(path, ".proofbench", "config.json"),
      JSON.stringify({ forge: "gitlab", gitlabHost: "git.acme.corp", jiraProjects: ["X"], retracePath: "evil" }),
    );
    const none = join(await tmp(), "absent.json");
    const ref = await resolveRepo(await inv(), path, undefined, none);
    expect(ref.forge).toBe("unknown");
    expect(ref.capabilities.tickets).toBe(false);
    expect(readConfig(path, none)).toEqual({});
  });

  it("path_outside_git_repo_gives_clear_error", async () => {
    await expect(resolveRepo(await inv(), await tmp())).rejects.toThrow(/git repository/);
  });

  it("invalid_config_is_reported_in_misses_not_thrown", async () => {
    const path = await repoWithRemote("git@gitlab.com:a/b.git");
    const cfg = join(await tmp(), "config.json");
    await writeFile(cfg, "{ nope");
    const ref = await resolveRepo(await inv(), path, undefined, cfg);
    expect(ref.forge).toBe("gitlab");
    expect(ref.misses.join(" ")).toContain("invalid JSON");
  });
});

describe("readConfig", () => {
  it("missing_file_gives_empty_config", async () => {
    expect(readConfig(await tmp(), join(await tmp(), "nope.json"))).toEqual({});
  });

  it("repo_without_entry_gives_empty_config", async () => {
    const path = await repoWithRemote();
    expect(readConfig(path, await userConfig(path, { forge: "gitlab" }, join(path, "other")))).toEqual({});
  });

  it("ignores_wrongly_typed_fields", async () => {
    const path = await repoWithRemote();
    const cfg = await userConfig(path, { forge: "nope", gitlabHost: 3, jiraProjects: ["A", 1], retracePath: "r" });
    expect(readConfig(path, cfg)).toEqual({ jiraProjects: ["A"], retracePath: "r" });
  });

  it("key_matches_despite_separators_trailing_slash_and_case", async () => {
    const path = await repoWithRemote();
    const variant = process.platform === "win32" ? path.toUpperCase().split("\\").join("/") + "/" : path + "/";
    expect(readConfig(path, await userConfig(path, { forge: "gitlab" }, variant))).toEqual({ forge: "gitlab" });
  });

  it("malformed_shapes_give_clear_errors", async () => {
    const path = await repoWithRemote();
    const d = await tmp();
    const bad = join(d, "bad.json");
    await writeFile(bad, JSON.stringify({ repos: [] }));
    expect(() => readConfig(path, bad)).toThrow(/repos/);
    await writeFile(bad, "[]");
    expect(() => readConfig(path, bad)).toThrow(/JSON object/);
    await writeFile(bad, "{ nope");
    expect(() => readConfig(path, bad)).toThrow(/invalid JSON/);
  });
});
