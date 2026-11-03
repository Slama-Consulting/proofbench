import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.js";
import type { Forge, Investigation, RepoRef } from "./investigation.js";

export interface Config {
  forge?: Forge;
  gitlabHost?: string;
  jiraProjects?: string[];
  retracePath?: string;
}

const FORGES: readonly Forge[] = ["gitlab", "github", "bitbucket", "azure", "unknown"];
const UNSUPPORTED: readonly Forge[] = ["github", "bitbucket", "azure"];

export function defaultConfigPath(): string {
  return join(homedir(), ".proofbench", "config.json");
}

/** Repository key: absolute path, `/` separators, no trailing `/`, lowercase on Windows. */
export function normalizeRepoPath(p: string): string {
  let abs = resolve(p);
  try {
    abs = realpathSync.native(abs);
  } catch {
    // non-existent path: keep the resolved form
  }
  let out = abs.split("\\").join("/").replace(/\/+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out || "/";
}

function parseEntry(o: Record<string, unknown>): Config {
  const config: Config = {};
  if (typeof o.forge === "string" && (FORGES as readonly string[]).includes(o.forge)) config.forge = o.forge as Forge;
  if (typeof o.gitlabHost === "string" && o.gitlabHost.trim()) config.gitlabHost = o.gitlabHost.trim();
  if (Array.isArray(o.jiraProjects)) {
    config.jiraProjects = o.jiraProjects.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  }
  if (typeof o.retracePath === "string" && o.retracePath.trim()) config.retracePath = o.retracePath;
  return config;
}

/**
 * Reads the repository config from the user file `~/.proofbench/config.json`
 * (`{ repos: { "<absolute path>": {...} } }`). A file inside the analysed repository is NEVER read:
 * it is untrusted (token host, replay command). Missing file or entry: empty config.
 * Invalid JSON or unexpected shape: clear error. Fields of the wrong type are ignored.
 */
export function readConfig(repoPath: string, configPath: string = defaultConfigPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Unreadable user config (${configPath}): ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`User config ${configPath}: invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`User config ${configPath}: a JSON object is expected`);
  }
  const repos = (parsed as Record<string, unknown>).repos;
  if (repos === undefined) return {};
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) {
    throw new Error(`User config ${configPath}: \`repos\` must be an object`);
  }
  const wanted = normalizeRepoPath(repoPath);
  for (const [key, value] of Object.entries(repos)) {
    if (normalizeRepoPath(key) !== wanted) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`User config ${configPath}: the repository entry must be an object`);
    }
    return parseEntry(value as Record<string, unknown>);
  }
  return {};
}

/** Host name of a remote URL (scp-like or with a scheme), without credentials or port. */
export function remoteHost(url: string): string | null {
  const u = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(u);
  if (scheme) return scheme[1].toLowerCase();
  const scp = /^(?:[^/@:]+@)?([^/:]+):/.exec(u);
  return scp ? scp[1].toLowerCase() : null;
}

/** Project path of a remote URL (`group/sub/proj`, without `.git`), or null. */
export function remoteProjectPath(url: string): string | null {
  const u = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(?:\[[^\]]+\]|[^/]+)\/(.+)$/i.exec(u);
  const scp = /^(?:[^/@:]+@)?[^/:]+:(?!\/\/)(.+)$/.exec(u);
  const raw = scheme ? scheme[1] : scp ? scp[1] : null;
  if (!raw) return null;
  const path = raw.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return path.includes("/") ? path : null;
}

function forgeFromHost(host: string, config: Config): Forge {
  if (config.gitlabHost && host === config.gitlabHost.toLowerCase()) return "gitlab";
  if (host === "gitlab.com") return "gitlab";
  if (host === "github.com") return "github";
  if (host === "bitbucket.org") return "bitbucket";
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")) return "azure";
  return "unknown";
}

export async function remoteUrl(top: string): Promise<string | null> {
  const origin = await git(top, ["remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim();
  const list = await git(top, ["remote"]);
  const first = list.code === 0 ? list.stdout.split("\n").map((s) => s.trim()).find(Boolean) : undefined;
  if (!first) return null;
  const r = await git(top, ["remote", "get-url", first]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Identifies the repository and its platform, then registers it in `inv.repos`.
 * Priority order: `override`, `forge` from the user config, remote host. Throws only if
 * `path` is not inside a git repository; everything else degrades to `misses`.
 */
export async function resolveRepo(
  inv: Investigation,
  path: string,
  override?: Forge,
  configPath?: string,
): Promise<RepoRef> {
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || !top.stdout.trim()) {
    throw new Error(`The path is not inside a git repository: ${path}`);
  }
  const root = top.stdout.trim();
  const misses: string[] = [];

  let config: Config = {};
  try {
    config = readConfig(root, configPath);
  } catch (e) {
    misses.push(`Config ignored (user config): ${(e as Error).message}`);
  }

  const url = await remoteUrl(root);
  const host = url ? remoteHost(url) : null;
  let forge: Forge;
  if (override) forge = override;
  else if (config.forge) forge = config.forge;
  else if (host) forge = forgeFromHost(host, config);
  else forge = "unknown";

  if (!url) misses.push("No remote configured: unknown platform");
  else if (forge === "unknown") misses.push("Platform not recognised: MR search unavailable");
  if ((UNSUPPORTED as readonly Forge[]).includes(forge)) {
    misses.push(`Platform ${forge} detected but not supported in this version`);
  }

  const ref: RepoRef = {
    repoId: `R${inv.repos.length + 1}`,
    path: root,
    forge,
    capabilities: { mrLookup: forge === "gitlab", tickets: (config.jiraProjects?.length ?? 0) > 0 },
    misses,
  };
  inv.repos.push(ref);
  return ref;
}
