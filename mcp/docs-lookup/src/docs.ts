import { chunkText, rank, tokenize, type Chunk } from "./chunk.js";
import { Http } from "./http.js";
import { findOverride, type OverrideSource } from "./overrides.js";
import { fetchCrateReadme, resolvePackage, type ResolveEcosystem } from "./resolve.js";
import * as v from "./validate.js";

export const DEFAULT_MAX_CHARS = 6000;
export const MAX_MAX_CHARS = 20000;
const MAX_DOC_FILES = 8;
const DOC_DIRS = ["docs", "doc", "documentation"];
const DOC_EXT = /\.(md|mdx|markdown|adoc)$/i;

export type VersionMatch = "exact" | "fallback_default_branch" | "unknown";

export interface FetchInput {
  ecosystem: ResolveEcosystem;
  name: string;
  version?: string | undefined;
  query: string;
  maxChars?: number | undefined;
}

export interface DocChunk {
  source: string;
  ref?: string;
  versionMatch: VersionMatch;
  heading: string;
  text: string;
  score: number;
  truncated: boolean;
}

export interface FetchResult {
  ecosystem: ResolveEcosystem;
  name: string;
  requestedVersion?: string;
  versionUsed?: string;
  query: string;
  versionMatch: VersionMatch;
  maxChars: number;
  totalChars: number;
  truncated: boolean;
  omittedChunks: number;
  sources: { source: string; ref?: string; versionMatch: VersionMatch }[];
  chunks: DocChunk[];
  notes: string[];
}

interface Doc {
  source: string;
  ref?: string;
  versionMatch: VersionMatch;
  text: string;
  adoc: boolean;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface Tree {
  sha: string;
  tree: TreeEntry[];
  truncated?: boolean;
}

const GENERIC_REF_TEMPLATES = ["v{version}", "{version}", "{name}-{version}", "release/{version}"];

function substitute(template: string, version: string, shortName: string): string {
  return template.replaceAll("{version}", version).replaceAll("{name}", shortName);
}

function shortNameOf(name: string): string {
  const last = name.split(/[/:]/).pop() ?? name;
  return last;
}

function rawUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${v.encodePath(ref)}/${v.encodePath(path)}`;
}

async function getTree(http: Http, owner: string, repo: string, ref: string, recursive: boolean): Promise<{ ok: true; tree: Tree } | { ok: false; status?: number; error: string }> {
  const r = await http.getJson<Tree>(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`);
  if (!r.ok) return r;
  if (!r.data || !Array.isArray(r.data.tree)) return { ok: false, error: "unexpected tree response" };
  return { ok: true, tree: r.data };
}

/** Scores a file path against the query tokens (file name counts double). */
function pathScore(path: string, queryTokens: Set<string>): number {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  let s = 0;
  for (const t of tokenize(file.replace(/\.[^.]+$/, ""))) if (queryTokens.has(t)) s += 2;
  for (const t of tokenize(parts.join(" "))) if (queryTokens.has(t)) s += 1;
  return s;
}

interface RepoGather {
  docs: Doc[];
  notes: string[];
}

/**
 * Finds the git ref for a version, lists the documentation files at that ref and downloads the most relevant ones.
 * Falls back to the default branch (and says so) when no ref matches the version.
 */
async function gatherFromRepo(
  http: Http,
  repoUrl: string,
  opts: { version?: string | undefined; refTemplates: string[]; shortName: string; files: string[]; dirs: string[] | "auto"; extraReadmeDir?: string | undefined; query: string },
): Promise<RepoGather> {
  const gh = v.splitGithub(repoUrl);
  const out: RepoGather = { docs: [], notes: [] };
  if (!gh) {
    out.notes.push(`not a GitHub repository: ${repoUrl}`);
    return out;
  }
  const owner = v.ghOwner(gh.owner);
  const repo = v.ghRepo(gh.repo);
  const label = `${owner}/${repo}`;
  const queryTokens = new Set(tokenize(opts.query));

  // 1. the ref for the version
  let ref: string | undefined;
  let match: VersionMatch = "unknown";
  let root: Tree | undefined;
  let apiFailure: string | undefined;
  if (opts.version) {
    for (const tpl of opts.refTemplates) {
      let candidate: string;
      try {
        candidate = v.gitRef(substitute(tpl, opts.version, opts.shortName));
      } catch {
        continue;
      }
      const t = await getTree(http, owner, repo, candidate, false);
      if (t.ok) {
        ref = candidate;
        root = t.tree;
        match = "exact";
        break;
      }
      if (t.status !== 404) {
        apiFailure = t.error;
        break;
      }
    }
  }
  if (!ref && !apiFailure) {
    const info = await http.getJson<{ default_branch?: string }>(`https://api.github.com/repos/${owner}/${repo}`);
    if (info.ok && typeof info.data.default_branch === "string") {
      try {
        const branch = v.gitRef(info.data.default_branch);
        const t = await getTree(http, owner, repo, branch, false);
        if (t.ok) {
          ref = branch;
          root = t.tree;
          match = opts.version ? "fallback_default_branch" : "unknown";
          out.notes.push(
            opts.version
              ? `${label}: no git ref matches version ${opts.version} (tried ${opts.refTemplates.map((t2) => substitute(t2, opts.version!, opts.shortName)).join(", ") || "none"}); using default branch "${branch}", content may differ from that version`
              : `${label}: no version requested; using default branch "${branch}"`,
          );
        } else apiFailure = t.error;
      } catch {
        apiFailure = "invalid default branch name";
      }
    } else if (!info.ok) apiFailure = info.error;
  }

  // 2. GitHub API unavailable (rate limit, size): try the raw README directly
  if (!ref || !root) {
    out.notes.push(`${label}: GitHub API unavailable (${apiFailure ?? "no ref found"}); trying raw files only. Set GITHUB_TOKEN for a higher rate limit.`);
    const candidates: { ref: string; match: VersionMatch }[] = [];
    if (opts.version) {
      for (const tpl of opts.refTemplates) {
        try {
          candidates.push({ ref: v.gitRef(substitute(tpl, opts.version, opts.shortName)), match: "exact" });
        } catch {
          // skip invalid candidate
        }
      }
    }
    candidates.push({ ref: "HEAD", match: opts.version ? "fallback_default_branch" : "unknown" });
    const paths = opts.files.length ? opts.files : ["README.md"];
    for (const c of candidates.slice(0, 5)) {
      const first = await http.get(rawUrl(owner, repo, c.ref, paths[0]!), "text/plain");
      if (!first.ok) continue;
      out.docs.push({ source: rawUrl(owner, repo, c.ref, paths[0]!), ref: c.ref, versionMatch: c.match, text: first.text, adoc: false });
      break;
    }
    return out;
  }

  const addFile = async (path: string, followLinks = 1): Promise<boolean> => {
    let safe: string;
    try {
      safe = v.repoPath(path);
    } catch {
      return false;
    }
    const url = rawUrl(owner, repo, ref!, safe);
    const r = await http.get(url, "text/plain");
    if (!r.ok) return false;
    // A git symlink is served as a one-line file holding its target path (e.g. README.md -> packages/lib/README.md).
    const target = r.text.trim();
    if (followLinks > 0 && target.length < 200 && /^[A-Za-z0-9._@+~/-]+$/.test(target) && /\.(md|mdx|markdown|adoc)$/i.test(target)) {
      const parts = safe.split("/").slice(0, -1);
      for (const seg of target.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      return addFile(parts.join("/"), followLinks - 1);
    }
    out.docs.push({ source: url, ref, versionMatch: match, text: r.text, adoc: /\.adoc$/i.test(safe) });
    return true;
  };

  // 3. explicit files / README
  let fetched = 0;
  if (opts.extraReadmeDir) {
    if (await addFile(`${opts.extraReadmeDir}/README.md`)) fetched++;
  }
  if (opts.files.length) {
    for (const f of opts.files) if (await addFile(f)) fetched++;
  } else {
    const readme = pickReadme(root.tree);
    if (readme && (await addFile(readme))) fetched++;
  }

  // 4. documentation directories
  const dirPaths =
    opts.dirs === "auto"
      ? root.tree.filter((e) => e.type === "tree" && DOC_DIRS.includes(e.path.toLowerCase())).map((e) => e.path)
      : opts.dirs;
  const candidates: string[] = [];
  for (const dir of dirPaths) {
    const listed = await listDir(http, owner, repo, root, dir);
    if (listed.note) out.notes.push(`${label}: ${listed.note}`);
    for (const e of listed.files) candidates.push(`${dir}/${e}`);
  }
  const scored = candidates
    .map((p) => ({ p, s: pathScore(p, queryTokens) }))
    .sort((a, b) => b.s - a.s || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));
  const wanted = scored.some((x) => x.s > 0) ? scored.filter((x) => x.s > 0) : scored.slice(0, 3);
  for (const { p } of wanted) {
    if (fetched >= MAX_DOC_FILES) break;
    if (await addFile(p)) fetched++;
  }
  if (!out.docs.length) out.notes.push(`${label}: no documentation files found at ref ${ref}`);
  return out;
}

function pickReadme(tree: TreeEntry[]): string | undefined {
  const cands = tree.filter((e) => e.type === "blob" && /^readme(\.[a-z]+)?$/i.test(e.path));
  const rank2 = (p: string): number => (/\.md$/i.test(p) ? 0 : /\.(markdown|mdx|adoc)$/i.test(p) ? 1 : 2);
  return cands.sort((a, b) => rank2(a.path) - rank2(b.path))[0]?.path;
}

/** Lists the documentation files (relative to `dir`) under a directory, walking down from the root tree one level at a time. */
async function listDir(http: Http, owner: string, repo: string, root: Tree, dir: string): Promise<{ files: string[]; note?: string }> {
  let segments: string[];
  try {
    segments = v.repoPath(dir).split("/");
  } catch {
    return { files: [], note: `invalid directory ${JSON.stringify(dir)}` };
  }
  let entries = root.tree;
  let sha: string | undefined;
  for (const seg of segments) {
    const hit = entries.find((e) => e.type === "tree" && e.path === seg);
    if (!hit) return { files: [], note: `directory ${dir} not found at this ref` };
    sha = hit.sha;
    if (seg !== segments[segments.length - 1]) {
      const t = await getTree(http, owner, repo, hit.sha, false);
      if (!t.ok) return { files: [], note: `cannot list ${dir}: ${t.error}` };
      entries = t.tree.tree;
    }
  }
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return { files: [], note: `unexpected tree id for ${dir}` };
  const t = await getTree(http, owner, repo, sha, true);
  if (!t.ok) return { files: [], note: `cannot list ${dir}: ${t.error}` };
  const files = t.tree.tree
    .filter((e) => e.type === "blob" && DOC_EXT.test(e.path) && (e.size ?? 0) <= 1024 * 1024 && !/(^|\/)(node_modules|\.git)\//.test(e.path))
    .map((e) => e.path);
  return { files, ...(t.tree.truncated ? { note: `listing of ${dir} was truncated by GitHub` } : {}) };
}

function npmReadmeSource(name: string, version: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`;
}

export async function fetchDocs(http: Http, input: FetchInput): Promise<FetchResult> {
  const query = input.query.trim();
  if (!query) throw new v.InputError("query must not be empty");
  if (query.length > 500) throw new v.InputError("query is too long (max 500 characters)");
  const maxChars = Math.min(Math.max(Math.trunc(input.maxChars ?? DEFAULT_MAX_CHARS), 200), MAX_MAX_CHARS);
  if (input.version) v.version(input.version);

  const result: FetchResult = {
    ecosystem: input.ecosystem,
    name: input.name,
    ...(input.version ? { requestedVersion: input.version } : {}),
    query,
    versionMatch: "unknown",
    maxChars,
    totalChars: 0,
    truncated: false,
    omittedChunks: 0,
    sources: [],
    chunks: [],
    notes: [],
  };
  const docs: Doc[] = [];
  const shortName = shortNameOf(input.name);
  let version = input.version;

  const override = findOverride(input.ecosystem, input.name);
  if (override) {
    result.notes.push(`using the built-in documentation map entry "${override.id}"`);
    if (!version) result.notes.push("no version given: documentation comes from the default branch");
    for (const src of override.sources as OverrideSource[]) {
      const g = await gatherFromRepo(http, src.repository, { version, refTemplates: src.refTemplates, shortName, files: src.files, dirs: src.dirs, query });
      docs.push(...g.docs);
      result.notes.push(...g.notes);
    }
  } else {
    const resolved = await resolvePackage(http, { ecosystem: input.ecosystem, name: input.name, version });
    if (!resolved.found) {
      throw new Error(
        input.ecosystem === "tool"
          ? `unknown tool ${JSON.stringify(input.name)}: ${resolved.notes.join("; ")}`
          : `package ${JSON.stringify(input.name)} not found in the ${input.ecosystem} registry`,
      );
    }
    result.notes.push(...resolved.notes);
    let registryExact = true;
    if (version && resolved.versionExists === false) {
      result.notes.push(`version ${version} does not exist in the registry; latest is ${resolved.latestVersion ?? "unknown"}. Documentation below is for the latest version, not the requested one.`);
      version = resolved.latestVersion;
      registryExact = false;
    } else if (!version) {
      version = resolved.latestVersion;
      result.notes.push(`no version given: using the latest version ${version ?? "(unknown)"}`);
    }
    if (version) result.versionUsed = version;

    // registry README (npm / PyPI: shipped with the metadata; crates.io: rendered page)
    let readme = resolved.readme;
    let readmeSource: string | undefined;
    if (input.ecosystem === "npm" && readme && resolved.metadataVersion) readmeSource = npmReadmeSource(input.name, resolved.metadataVersion);
    else if (input.ecosystem === "pypi" && readme && resolved.metadataVersion) {
      readmeSource = `https://pypi.org/project/${encodeURIComponent(input.name)}/${encodeURIComponent(resolved.metadataVersion)}/`;
    } else if (input.ecosystem === "crates" && resolved.metadataVersion) {
      readme = await fetchCrateReadme(http, input.name, resolved.metadataVersion);
      readmeSource = `https://crates.io/crates/${encodeURIComponent(input.name)}/${encodeURIComponent(resolved.metadataVersion)}`;
    }
    if (readme && readmeSource) {
      docs.push({ source: readmeSource, ref: resolved.metadataVersion, versionMatch: registryExact ? "exact" : "unknown", text: readme, adoc: false });
    }

    if (resolved.repository && v.splitGithub(resolved.repository)) {
      const g = await gatherFromRepo(http, resolved.repository, {
        version,
        refTemplates: GENERIC_REF_TEMPLATES,
        shortName,
        files: [],
        dirs: "auto",
        extraReadmeDir: resolved.repoDirectory && /^[A-Za-z0-9._@+~ /-]+$/.test(resolved.repoDirectory) ? resolved.repoDirectory.replace(/^\.?\/+|\/+$/g, "") : undefined,
        query,
      });
      docs.push(...g.docs);
      result.notes.push(...g.notes);
    } else {
      result.notes.push(
        resolved.documentationUrl
          ? `no GitHub repository known; documentation site ${resolved.documentationUrl} is not fetched (only GitHub-hosted docs and registry READMEs are supported)`
          : "no GitHub repository known for this package",
      );
    }
  }

  if (!docs.length) {
    throw new Error(`no documentation reachable for ${input.ecosystem}:${input.name}${version ? "@" + version : ""}. ${result.notes.join(" ")}`);
  }

  // chunk, rank, assemble
  const all: (Chunk & { doc: Doc })[] = [];
  let order = 0;
  for (const doc of docs) {
    for (const c of chunkText(doc.text, { adoc: doc.adoc })) all.push({ ...c, order: order++, doc });
  }
  const ranked = rank(all, query);
  let picked = ranked.filter((r) => r.score > 0);
  if (!picked.length) {
    result.notes.push("no chunk matched the query terms; returning the start of the documentation");
    picked = ranked.slice().sort((a, b) => a.chunk.order - b.chunk.order);
  }
  let used = 0;
  for (let i = 0; i < picked.length; i++) {
    const { chunk, score } = picked[i]!;
    const remaining = maxChars - used;
    let text = chunk.text;
    let cut = false;
    if (text.length > remaining) {
      if (remaining < 200) {
        result.omittedChunks = picked.length - i;
        break;
      }
      const slice = text.slice(0, remaining);
      const nl = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
      text = (nl > remaining * 0.6 ? slice.slice(0, nl) : slice).trimEnd();
      cut = true;
    }
    used += text.length;
    result.chunks.push({
      source: chunk.doc.source,
      ...(chunk.doc.ref ? { ref: chunk.doc.ref } : {}),
      versionMatch: chunk.doc.versionMatch,
      heading: chunk.heading,
      text,
      score: Math.round(score * 1000) / 1000,
      truncated: cut,
    });
    if (cut) {
      result.omittedChunks = picked.length - i - 1;
      break;
    }
  }
  result.totalChars = used;
  result.truncated = result.omittedChunks > 0 || result.chunks.some((c) => c.truncated);
  const seen = new Set<string>();
  for (const c of result.chunks) {
    if (seen.has(c.source)) continue;
    seen.add(c.source);
    result.sources.push({ source: c.source, ...(c.ref ? { ref: c.ref } : {}), versionMatch: c.versionMatch });
  }
  const matches = new Set(result.chunks.map((c) => c.versionMatch));
  result.versionMatch = matches.size === 1 ? [...matches][0]! : matches.has("fallback_default_branch") ? "fallback_default_branch" : "unknown";
  if (result.chunks.length && matches.size > 1) result.notes.push("sources have different version matches; check each chunk");
  if (version && !result.versionUsed) result.versionUsed = version;
  return result;
}
