import { Http } from "./http.js";
import { htmlToText } from "./html.js";
import { findOverride, OVERRIDES } from "./overrides.js";
import * as v from "./validate.js";

export const ECOSYSTEMS = ["npm", "maven", "pypi", "crates", "go", "tool"] as const;
export type ResolveEcosystem = (typeof ECOSYSTEMS)[number];

export interface ResolveInput {
  ecosystem: ResolveEcosystem;
  name: string;
  version?: string | undefined;
}

export interface ResolveResult {
  ecosystem: ResolveEcosystem;
  name: string;
  requestedVersion?: string;
  found: boolean;
  latestVersion?: string;
  /** true/false when the registry can tell; null when it cannot (tools). */
  versionExists?: boolean | null;
  homepage?: string;
  /** Normalised to https://github.com/owner/repo when it is a GitHub repository. */
  repository?: string;
  documentationUrl?: string;
  license?: string;
  deprecated: boolean;
  deprecationMessage?: string;
  registry: string;
  notes: string[];
}

/** Internal result: also carries the README text some registries ship with the metadata. */
export interface Resolved extends ResolveResult {
  readme?: string;
  /** Sub-directory of the repository that holds this package (monorepos), when the registry says so. */
  repoDirectory?: string;
  /** The version the metadata describes. */
  metadataVersion?: string;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);

function httpsUrl(x: unknown): string | undefined {
  const s = str(x);
  return s && /^https:\/\/[^\s]+$/.test(s) ? s : undefined;
}

function base(input: ResolveInput, registry: string): Resolved {
  return {
    ecosystem: input.ecosystem,
    name: input.name,
    ...(input.version ? { requestedVersion: input.version } : {}),
    found: false,
    deprecated: false,
    registry,
    notes: [],
  };
}

function fail(what: string, e: { error: string }): never {
  throw new Error(`${what}: ${e.error}`);
}

export async function resolvePackage(http: Http, input: ResolveInput): Promise<Resolved> {
  if (input.version) v.version(input.version);
  switch (input.ecosystem) {
    case "npm": return resolveNpm(http, input);
    case "pypi": return resolvePypi(http, input);
    case "crates": return resolveCrate(http, input);
    case "go": return resolveGo(http, input);
    case "maven": return resolveMaven(http, input);
    case "tool": return resolveTool(http, input);
  }
}

// ---------------------------------------------------------------- npm

async function resolveNpm(http: Http, input: ResolveInput): Promise<Resolved> {
  const name = v.npmName(input.name);
  const out = base(input, "registry.npmjs.org");
  const enc = name.replace("/", "%2F");
  const latest = await http.getJson<Obj>(`https://registry.npmjs.org/${enc}/latest`);
  if (!latest.ok) {
    if (latest.status === 404) return out;
    fail("npm registry", latest);
  }
  out.found = true;
  const latestVersion = str(latest.data.version);
  if (latestVersion) out.latestVersion = latestVersion;
  let doc: Obj = latest.data;
  if (input.version) {
    if (input.version === latestVersion) out.versionExists = true;
    else {
      const exact = await http.getJson<Obj>(`https://registry.npmjs.org/${enc}/${encodeURIComponent(input.version)}`);
      if (exact.ok) {
        out.versionExists = true;
        doc = exact.data;
      } else if (exact.status === 404) out.versionExists = false;
      else fail("npm registry", exact);
    }
  }
  out.metadataVersion = str(doc.version) ?? latestVersion ?? "";
  const repo = doc.repository;
  const repoUrl = typeof repo === "string" ? repo : isObj(repo) ? str(repo.url) : undefined;
  const gh = v.normalizeGithubUrl(repoUrl) ?? v.normalizeGithubUrl(str(doc.homepage));
  if (gh) out.repository = gh;
  else if (httpsUrl(repoUrl?.replace(/^git\+/, ""))) out.repository = repoUrl!.replace(/^git\+/, "");
  if (isObj(repo) && str(repo.directory)) out.repoDirectory = str(repo.directory)!;
  const homepage = httpsUrl(doc.homepage);
  if (homepage) {
    out.homepage = homepage;
    if (!v.normalizeGithubUrl(homepage)) out.documentationUrl = homepage;
  }
  const lic = doc.license;
  const license = typeof lic === "string" ? lic : isObj(lic) ? str(lic.type) : undefined;
  if (license) out.license = license;
  const dep = str(doc.deprecated);
  if (dep) {
    out.deprecated = true;
    out.deprecationMessage = dep.slice(0, 300);
  }
  const readme = str(doc.readme);
  if (readme) out.readme = readme;
  return out;
}

// ---------------------------------------------------------------- PyPI

async function resolvePypi(http: Http, input: ResolveInput): Promise<Resolved> {
  const name = v.pypiName(input.name);
  const out = base(input, "pypi.org");
  const main = await http.getJson<Obj>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (!main.ok) {
    if (main.status === 404) return out;
    fail("PyPI", main);
  }
  out.found = true;
  let info = isObj(main.data.info) ? main.data.info : {};
  const latestVersion = str(info.version);
  if (latestVersion) out.latestVersion = latestVersion;
  if (input.version) {
    const releases = isObj(main.data.releases) ? main.data.releases : undefined;
    const exists = input.version === latestVersion || (releases !== undefined && input.version in releases);
    out.versionExists = exists;
    if (exists && input.version !== latestVersion) {
      const exact = await http.getJson<Obj>(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(input.version)}/json`);
      if (exact.ok && isObj(exact.data.info)) info = exact.data.info;
    }
  }
  out.metadataVersion = str(info.version) ?? latestVersion ?? "";
  const urls = isObj(info.project_urls) ? (info.project_urls as Record<string, unknown>) : {};
  const entries = Object.entries(urls).map(([k, val]) => [k.toLowerCase(), str(val)] as const);
  const find = (re: RegExp): string | undefined => entries.find(([k, val]) => re.test(k) && val)?.[1];
  const gh =
    v.normalizeGithubUrl(find(/source|repo|code|github/)) ??
    v.normalizeGithubUrl(find(/home/)) ??
    v.normalizeGithubUrl(str(info.home_page)) ??
    entries.map(([, val]) => v.normalizeGithubUrl(val)).find(Boolean) ??
    null;
  if (gh) out.repository = gh;
  const home = httpsUrl(find(/home/) ?? info.home_page);
  if (home) out.homepage = home;
  const docs = httpsUrl(find(/doc/));
  if (docs) out.documentationUrl = docs;
  const license = str(info.license_expression) ?? (str(info.license) && str(info.license)!.length <= 100 ? str(info.license) : undefined);
  if (license) out.license = license;
  const classifiers = Array.isArray(info.classifiers) ? info.classifiers : [];
  if (info.yanked === true) {
    out.deprecated = true;
    out.deprecationMessage = str(info.yanked_reason) ?? "this release was yanked";
  } else if (classifiers.includes("Development Status :: 7 - Inactive")) {
    out.deprecated = true;
    out.deprecationMessage = "classified as Inactive";
  }
  const desc = str(info.description);
  if (desc) out.readme = desc;
  return out;
}

// ---------------------------------------------------------------- crates.io

async function resolveCrate(http: Http, input: ResolveInput): Promise<Resolved> {
  const name = v.crateName(input.name);
  const out = base(input, "crates.io");
  const main = await http.getJson<Obj>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (!main.ok) {
    if (main.status === 404) return out;
    fail("crates.io", main);
  }
  out.found = true;
  const crate = isObj(main.data.crate) ? main.data.crate : {};
  const versions = (Array.isArray(main.data.versions) ? main.data.versions : []).filter(isObj);
  const latest = str(crate.max_stable_version) ?? str(crate.max_version) ?? str(crate.newest_version);
  if (latest) out.latestVersion = latest;
  const target = input.version ?? latest;
  const entry = versions.find((x) => x.num === target);
  if (input.version) out.versionExists = entry !== undefined;
  out.metadataVersion = target ?? "";
  const gh = v.normalizeGithubUrl(str(crate.repository)) ?? v.normalizeGithubUrl(str(crate.homepage));
  if (gh) out.repository = gh;
  const homepage = httpsUrl(crate.homepage);
  if (homepage) out.homepage = homepage;
  const docs = httpsUrl(crate.documentation);
  if (docs) out.documentationUrl = docs;
  const license = entry ? str(entry.license) : undefined;
  if (license) out.license = license;
  if (entry?.yanked === true) {
    out.deprecated = true;
    out.deprecationMessage = "this version was yanked";
  }
  return out;
}

/** README of a crate version: crates.io redirects to a rendered HTML page on static.crates.io. */
export async function fetchCrateReadme(http: Http, name: string, version: string): Promise<string | undefined> {
  const r = await http.get(`https://crates.io/api/v1/crates/${encodeURIComponent(v.crateName(name))}/${encodeURIComponent(v.version(version))}/readme`, "text/html");
  return r.ok ? htmlToText(r.text) : undefined;
}

// ---------------------------------------------------------------- Go

async function resolveGo(http: Http, input: ResolveInput): Promise<Resolved> {
  const mod = v.goModule(input.name);
  const out = base(input, "proxy.golang.org");
  const esc = v.encodePath(v.goEscape(mod));
  const latest = await http.getJson<Obj>(`https://proxy.golang.org/${esc}/@latest`);
  if (!latest.ok) {
    if (latest.status === 404 || latest.status === 410) return out;
    fail("Go module proxy", latest);
  }
  out.found = true;
  const latestVersion = str(latest.data.Version);
  if (latestVersion) out.latestVersion = latestVersion;
  const target = input.version ?? latestVersion;
  if (input.version) {
    if (input.version === latestVersion) out.versionExists = true;
    else {
      const info = await http.get(`https://proxy.golang.org/${esc}/@v/${encodeURIComponent(input.version)}.info`, "application/json");
      if (info.ok) out.versionExists = true;
      else if (info.status === 404 || info.status === 410) out.versionExists = false;
      else fail("Go module proxy", info);
    }
  }
  out.metadataVersion = target ?? "";
  const gh = /^github\.com\/([^/]+)\/([^/]+)/.exec(mod);
  if (gh) out.repository = v.normalizeGithubUrl(`https://github.com/${gh[1]}/${gh[2]}`) ?? undefined;
  if (!out.repository) delete out.repository;
  out.documentationUrl = `https://pkg.go.dev/${mod}`;
  if (target && out.versionExists !== false) {
    const gomod = await http.get(`https://proxy.golang.org/${esc}/@v/${encodeURIComponent(target)}.mod`, "text/plain");
    if (gomod.ok) {
      const d = /^\s*\/\/\s*Deprecated:\s*(.*)$/m.exec(gomod.text);
      if (d) {
        out.deprecated = true;
        out.deprecationMessage = d[1]!.trim().slice(0, 300);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Maven

const MAVEN_REPOS = {
  central: "https://repo1.maven.org/maven2",
  google: "https://dl.google.com/android/maven2",
  portal: "https://plugins.gradle.org/m2",
} as const;

export function mavenCoordinates(name: string): { group: string; artifact: string; marker: boolean } {
  if (!name.includes(":")) {
    // A bare Gradle plugin id maps to its marker artifact.
    v.mavenPart(name, "Gradle plugin id");
    return { group: name, artifact: `${name}.gradle.plugin`, marker: true };
  }
  const parts = name.split(":");
  if (parts.length !== 2) throw new v.InputError(`invalid Maven name (expected group:artifact): ${JSON.stringify(name.slice(0, 80))}`);
  const group = v.mavenPart(parts[0]!, "Maven group");
  const artifact = v.mavenPart(parts[1]!, "Maven artifact");
  return { group, artifact, marker: artifact.endsWith(".gradle.plugin") };
}

function artifactBase(repo: string, group: string, artifact: string): string {
  return `${repo}/${group.split(".").map(encodeURIComponent).join("/")}/${encodeURIComponent(artifact)}`;
}

function xmlTag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(block);
  return m ? m[1]!.replace(/<!\[CDATA\[|\]\]>/g, "").trim() : undefined;
}

interface PomInfo {
  url?: string;
  scm?: string;
  license?: string;
  relocation?: string;
  parent?: { group: string; artifact: string; version: string };
  firstDependency?: { group: string; artifact: string; version?: string };
}

function parsePomInfo(xml: string, coords: { group: string; artifact: string; version: string }): PomInfo {
  const text = xml.replace(/<!--[\s\S]*?-->/g, "");
  const props: Record<string, string> = { "project.groupId": coords.group, "project.artifactId": coords.artifact, "project.version": coords.version, "pom.groupId": coords.group };
  for (const m of (xmlTag(text, "properties") ?? "").matchAll(/<([A-Za-z][\w.-]*)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]!] = m[2]!;
  const sub = (s: string | undefined): string | undefined => (s ? s.replace(/\$\{([^}]+)\}/g, (_m, k: string) => props[k] ?? "") : undefined);
  const info: PomInfo = {};
  const parentBlock = xmlTag(text, "parent");
  const parentG = parentBlock && xmlTag(parentBlock, "groupId");
  const parentA = parentBlock && xmlTag(parentBlock, "artifactId");
  const parentV = parentBlock && xmlTag(parentBlock, "version");
  if (parentG && parentA && parentV) info.parent = { group: parentG, artifact: parentA, version: parentV };
  const rest = text.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const scmBlock = xmlTag(rest, "scm");
  if (scmBlock) {
    const s = sub(xmlTag(scmBlock, "url")) ?? sub(xmlTag(scmBlock, "connection")) ?? sub(xmlTag(scmBlock, "developerConnection"));
    if (s) info.scm = s;
  }
  const stripped = rest.replace(/<(scm|licenses|dependencies|build|dependencyManagement|profiles|developers|distributionManagement|properties|organization)>[\s\S]*?<\/\1>/g, "");
  const url = sub(xmlTag(stripped, "url"));
  if (url) info.url = url;
  const lic = xmlTag(rest, "licenses");
  const licName = lic && xmlTag(lic, "name");
  if (licName) info.license = licName;
  const dm = xmlTag(rest, "distributionManagement");
  const reloc = dm && xmlTag(dm, "relocation");
  if (reloc !== undefined) {
    const g = xmlTag(reloc, "groupId") ?? coords.group;
    const a = xmlTag(reloc, "artifactId") ?? coords.artifact;
    info.relocation = `relocated to ${g}:${a}`;
  }
  const depsBlock = xmlTag(rest.replace(/<build>[\s\S]*?<\/build>/, ""), "dependencies");
  const firstDep = depsBlock && xmlTag(depsBlock, "dependency");
  if (firstDep) {
    const g = sub(xmlTag(firstDep, "groupId"));
    const a = sub(xmlTag(firstDep, "artifactId"));
    const ver = sub(xmlTag(firstDep, "version"));
    if (g && a) info.firstDependency = { group: g, artifact: a, ...(ver ? { version: ver } : {}) };
  }
  return info;
}

/** Fetches a POM from the given repositories, in order. */
async function fetchPom(http: Http, repos: string[], group: string, artifact: string, version: string): Promise<string | undefined> {
  for (const repo of repos) {
    const r = await http.get(`${artifactBase(repo, group, artifact)}/${encodeURIComponent(version)}/${encodeURIComponent(artifact)}-${encodeURIComponent(version)}.pom`, "application/xml");
    if (r.ok) return r.text;
    if (r.status !== 404) break;
  }
  return undefined;
}

async function resolveMaven(http: Http, input: ResolveInput): Promise<Resolved> {
  const { group, artifact, marker } = mavenCoordinates(input.name);
  const out = base(input, "repo1.maven.org");
  const bare = !input.name.includes(":");
  const order = bare || marker ? [MAVEN_REPOS.portal, MAVEN_REPOS.central] : [MAVEN_REPOS.central, MAVEN_REPOS.google, MAVEN_REPOS.portal];
  let repoUsed: string | undefined;
  let versions: string[] = [];
  let latest: string | undefined;
  for (const repo of order) {
    const r = await http.get(`${artifactBase(repo, group, artifact)}/maven-metadata.xml`, "application/xml");
    if (!r.ok) {
      if (r.status === 404) continue;
      fail(`Maven repository ${new URL(repo).hostname}`, r);
    }
    versions = [...r.text.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((m) => m[1]!);
    latest = xmlTag(r.text, "release") ?? xmlTag(r.text, "latest") ?? versions[versions.length - 1];
    if (versions.length || latest) {
      repoUsed = repo;
      break;
    }
  }
  if (!repoUsed) return out;
  out.found = true;
  out.registry = new URL(repoUsed).hostname;
  if (latest) out.latestVersion = latest;
  let pomVersion = latest;
  if (input.version) {
    out.versionExists = versions.includes(input.version);
    if (out.versionExists) pomVersion = input.version;
  }
  out.metadataVersion = pomVersion ?? "";
  if (!pomVersion) return out;
  v.version(pomVersion);

  const repos = [repoUsed, ...order.filter((r) => r !== repoUsed), ...Object.values(MAVEN_REPOS).filter((r) => !order.includes(r))];
  const merged: PomInfo = {};
  let coords = { group, artifact, version: pomVersion };
  let xml = await fetchPom(http, repos, coords.group, coords.artifact, coords.version);
  for (let level = 0; xml && level < 4; level++) {
    const info = parsePomInfo(xml, coords);
    merged.url ??= info.url;
    merged.scm ??= info.scm;
    merged.license ??= info.license;
    merged.relocation ??= info.relocation;
    if (level === 0 && marker) merged.firstDependency = info.firstDependency;
    const hasGithub = v.normalizeGithubUrl(merged.scm) ?? v.normalizeGithubUrl(merged.url);
    if (hasGithub || !info.parent || level === 3) break;
    coords = { group: info.parent.group, artifact: info.parent.artifact, version: info.parent.version };
    try {
      v.mavenPart(coords.group);
      v.mavenPart(coords.artifact);
      v.version(coords.version);
    } catch {
      break;
    }
    xml = await fetchPom(http, repos, coords.group, coords.artifact, coords.version);
  }
  // A Gradle plugin marker has no SCM of its own: its only dependency is the implementation artifact.
  if (marker && !(v.normalizeGithubUrl(merged.scm) ?? v.normalizeGithubUrl(merged.url)) && merged.firstDependency?.version) {
    const d = merged.firstDependency;
    try {
      v.mavenPart(d.group);
      v.mavenPart(d.artifact);
      v.version(d.version!);
      const implXml = await fetchPom(http, repos, d.group, d.artifact, d.version!);
      if (implXml) {
        const info = parsePomInfo(implXml, { group: d.group, artifact: d.artifact, version: d.version! });
        merged.url ??= info.url;
        merged.scm ??= info.scm;
        merged.license ??= info.license;
        if (!(v.normalizeGithubUrl(merged.scm) ?? v.normalizeGithubUrl(merged.url)) && info.parent) {
          const px = await fetchPom(http, repos, info.parent.group, info.parent.artifact, info.parent.version);
          if (px) {
            const pi = parsePomInfo(px, info.parent);
            merged.url ??= pi.url;
            merged.scm ??= pi.scm;
          }
        }
        out.notes.push(`repository taken from the plugin implementation artifact ${d.group}:${d.artifact}:${d.version}`);
      }
    } catch {
      // invalid coordinates in the POM: ignore
    }
  }
  const gh = v.normalizeGithubUrl(merged.scm) ?? v.normalizeGithubUrl(merged.url);
  if (gh) out.repository = gh;
  else if (httpsUrl(merged.scm?.replace(/^scm:git:/, "").replace(/^git\+/, ""))) out.repository = merged.scm!.replace(/^scm:git:/, "").replace(/^git\+/, "");
  const home = httpsUrl(merged.url);
  if (home) {
    out.homepage = home;
    if (!v.normalizeGithubUrl(home)) out.documentationUrl = home;
  }
  if (merged.license) out.license = merged.license;
  if (merged.relocation) {
    out.deprecated = true;
    out.deprecationMessage = merged.relocation;
  }
  return out;
}

// ---------------------------------------------------------------- tools (built-in overrides)

async function resolveTool(http: Http, input: ResolveInput): Promise<Resolved> {
  const out = base(input, "api.github.com");
  const entry = findOverride("tool", input.name);
  if (!entry) {
    out.notes.push(`unknown tool; known tools: ${OVERRIDES.map((e) => e.match.names[0]).join(", ")}`);
    return out;
  }
  out.found = true;
  out.repository = entry.repository;
  out.homepage = entry.homepage;
  out.documentationUrl = entry.documentationUrl;
  out.versionExists = null;
  const gh = v.splitGithub(entry.repository)!;
  const rel = await http.getJson<Obj>(`https://api.github.com/repos/${v.ghOwner(gh.owner)}/${v.ghRepo(gh.repo)}/releases/latest`);
  if (rel.ok) {
    const tag = str(rel.data.tag_name);
    if (tag) {
      out.latestVersion = tag.replace(/^v/, "");
      out.notes.push("latest version = tag of the latest GitHub release of the tool's repository");
    }
  } else out.notes.push(`latest version unavailable: ${rel.error}`);
  return out;
}
