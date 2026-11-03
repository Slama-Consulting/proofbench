import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { latestTag } from "./fix.js";
import { git } from "./git.js";
import { addEvidence } from "./investigation.js";
import type { Investigation } from "./investigation.js";

export interface VersionResult {
  mode: "exact_version" | "from_logs";
  version?: string;
  tags: string[];
  /** Without an exact version: the latest version tag, the one `check_fix` reads. Absent if the repository has none. */
  latestTag?: string;
  needsInput?: string;
  evidenceIds: string[];
}

const MAX_FILES = 2000;
const MAX_LISTED = 10;
const PACKAGE_RE = /^\s*Package \[([^\]]+)\]/;
const VERSION_RE = /^\s*versionName=(\S+)/;
/** Package name taken from an untrusted log: strict Java/Android form, otherwise the block is ignored. */
const SAFE_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
/** The version comes from an untrusted log: only the characters of a version number get through. */
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function listed(names: string[]): string {
  const more = names.length > MAX_LISTED ? ` (+${names.length - MAX_LISTED} more)` : "";
  return `${names.slice(0, MAX_LISTED).join(", ")}${more}`;
}

async function isZip(path: string): Promise<boolean> {
  if (extname(path).toLowerCase() === ".zip") return true;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    // PK followed by 03 04 (entry), 05 06 (empty archive) or 07 08 (split archive): a text log "PKG..." does not match.
    return bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && [[3, 4], [5, 6], [7, 8]].some(([a, b]) => buf[2] === a && buf[3] === b);
  } finally {
    await fh.close();
  }
}

/** .txt and .log files in a folder, recursively, without following symbolic links. */
async function collectFiles(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, out);
    else if (entry.isFile() && [".txt", ".log"].includes(extname(entry.name).toLowerCase())) out.push(full);
  }
}

async function scanFile(path: string, found: Map<string, Set<string>>): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let current: string | null = null;
  for await (const line of rl) {
    const pkg = PACKAGE_RE.exec(line);
    if (pkg) {
      current = pkg[1].length <= 255 && SAFE_PACKAGE_RE.test(pkg[1]) ? pkg[1] : null;
      continue;
    }
    if (current === null) continue;
    const ver = VERSION_RE.exec(line);
    if (ver && SAFE_VERSION_RE.test(ver[1])) {
      let set = found.get(current);
      if (!set) found.set(current, (set = new Set()));
      set.add(ver[1]);
    }
  }
}

async function matchingTags(repoPath: string, version: string): Promise<string[]> {
  const r = await git(repoPath, ["tag", "--list"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t === version || t.replace(/^[vV]/, "") === version);
}

/**
 * Looks up the installed version in a bugreport (file, folder) or in logs, as a stream,
 * then the matching git tags (exact comparison). Sets `inv.startMode`.
 */
export async function locateVersion(
  inv: Investigation,
  repoId: string,
  logPath: string,
  packageName?: string,
): Promise<VersionResult> {
  const repo = inv.repos.find((r) => r.repoId === repoId);
  if (!repo) throw new Error(`Unknown repository: ${repoId}`);

  let info;
  try {
    info = await stat(logPath);
  } catch {
    throw new Error(`Log path not found: ${logPath}`);
  }

  const fromLogs = async (needsInput?: string): Promise<VersionResult> => {
    inv.startMode = "from_logs";
    const { tag } = await latestTag(repo.path);
    return { mode: "from_logs", tags: [], ...(tag === undefined ? {} : { latestTag: tag }), needsInput, evidenceIds: [] };
  };

  const files: string[] = [];
  if (info.isDirectory()) {
    await collectFiles(logPath, files);
  } else {
    if (await isZip(logPath)) {
      return fromLogs("The bugreport is a zip archive: please extract it into a folder, then give that folder.");
    }
    files.push(logPath);
  }

  const found = new Map<string, Set<string>>();
  for (const f of files) await scanFile(f, found);

  const names = [...found.keys()];
  if (packageName && !found.has(packageName)) {
    const known = names.length > 0 ? `Packages found: ${listed(names)}.` : "No package with a readable version.";
    return fromLogs(`Package ${packageName} not found in the logs, or without a readable version. ${known}`);
  }
  if (!packageName && names.length > 1) {
    return fromLogs(`Several packages found in the bugreport: ${listed(names)}. Give the package name (packageName).`);
  }

  const pkg = packageName || names[0];
  const versions = pkg ? [...(found.get(pkg) ?? [])] : [];
  if (!pkg || versions.length === 0) return fromLogs();
  if (versions.length > 1) {
    return fromLogs(`Several versions found for ${pkg}: ${listed(versions)}. Say which one was installed, and the tag or commit to use.`);
  }

  const version = versions[0];
  const evidence = addEvidence(inv, {
    kind: "claim",
    summary: `Version ${version} declared for ${pkg} in the logs`,
    source: logPath,
    data: { package: pkg, version },
    untrusted: true,
  });
  inv.startMode = "exact_version";

  const tags = await matchingTags(repo.path, version);
  const result: VersionResult = { mode: "exact_version", version, tags, evidenceIds: [evidence.id] };
  if (tags.length === 0) {
    result.needsInput = `No git tag matches version ${version}: give the commit or tag to use.`;
  } else if (tags.length > 1) {
    result.needsInput = `Several tags match version ${version}: ${listed(tags)}. Say which one to use.`;
  }
  return result;
}
