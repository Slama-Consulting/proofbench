import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join as pjoin } from "node:path";
import { finishGradle, parseCatalog, parseCatalogDeps, parseGradleBuild, parseGradleWrapper, type Catalog } from "./gradle.js";
import { parsePom } from "./maven.js";
import { parseCargoToml, parseGoMod } from "./native.js";
import { NpmLocks, parsePackageJson } from "./npm.js";
import { parsePyproject, parseRequirementsTxt } from "./python.js";
import { dirOf, join, type Dependency, type FileAccess } from "./types.js";

export const MAX_MANIFESTS = 400;
export const MAX_DEPENDENCIES = 1000;
const MAX_FILES_VISITED = 200_000;
const MAX_DEPTH = 20;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const LOCK_MAX_BYTES = 16 * 1024 * 1024;

export const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "build", ".git", "dist", ".gradle", "Pods", ".venv", "target", "__pycache__"]);

const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".kt": "Kotlin", ".kts": "Kotlin", ".java": "Java", ".py": "Python", ".go": "Go", ".rs": "Rust",
  ".swift": "Swift", ".dart": "Dart", ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".scala": "Scala",
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".m": "Objective-C", ".mm": "Objective-C",
};

type ManifestKind = "package.json" | "gradle" | "pom" | "requirements" | "pyproject" | "gomod" | "cargo" | "wrapper" | "catalog";

function manifestKind(rel: string, name: string): ManifestKind | null {
  if (name === "package.json") return "package.json";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle";
  if (name === "pom.xml") return "pom";
  if (/^requirements.*\.txt$/i.test(name)) return "requirements";
  if (name === "pyproject.toml") return "pyproject";
  if (name === "go.mod") return "gomod";
  if (name === "Cargo.toml") return "cargo";
  if (name === "gradle-wrapper.properties" && rel.endsWith("gradle/wrapper/gradle-wrapper.properties")) return "wrapper";
  if (name.endsWith(".versions.toml")) return "catalog";
  return null;
}

const AUX_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "gradle.properties", "settings.gradle", "settings.gradle.kts"]);

export interface DetectResult {
  repoPath: string;
  languages: { language: string; files: number }[];
  buildSystems: string[];
  manifests: string[];
  dependencies: Dependency[];
  limits: { manifestsTruncated: boolean; dependenciesTruncated: boolean; filesTruncated: boolean; skippedSymlinks: number };
}

export function detectProject(repoPath: string): DetectResult {
  let root: string;
  try {
    root = realpathSync(repoPath);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`repoPath is not an accessible directory: ${JSON.stringify(repoPath)}`);
  }

  const found = new Map<string, number>(); // rel -> max bytes allowed
  const manifests: { rel: string; kind: ManifestKind }[] = [];
  const extCounts = new Map<string, number>();
  let manifestsTruncated = false;
  let filesTruncated = false;
  let skippedSymlinks = 0;
  let visited = 0;

  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  while (stack.length) {
    const { abs, rel, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        skippedSymlinks++;
        continue;
      }
      const childRel = join(rel, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && depth < MAX_DEPTH) stack.push({ abs: pjoin(abs, e.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (++visited > MAX_FILES_VISITED) {
        filesTruncated = true;
        stack.length = 0;
        break;
      }
      const dot = e.name.lastIndexOf(".");
      if (dot > 0) {
        const lang = /^(build|settings)\.gradle\.kts$/.test(e.name) ? undefined : LANGUAGES[e.name.slice(dot).toLowerCase()];
        if (lang) extCounts.set(lang, (extCounts.get(lang) ?? 0) + 1);
      }
      const kind = manifestKind(childRel, e.name);
      if (kind) {
        if (manifests.length >= MAX_MANIFESTS) manifestsTruncated = true;
        else {
          manifests.push({ rel: childRel, kind });
          found.set(childRel, MANIFEST_MAX_BYTES);
        }
      } else if (AUX_FILES.has(e.name)) {
        found.set(childRel, LOCK_MAX_BYTES);
      }
    }
  }
  manifests.sort((a, b) => (a.rel < b.rel ? -1 : 1));

  const cache = new Map<string, string | undefined>();
  const files: FileAccess = {
    has: (rel) => found.has(rel),
    read(rel) {
      if (cache.has(rel)) return cache.get(rel);
      let text: string | undefined;
      const limit = found.get(rel);
      if (limit !== undefined) {
        try {
          const abs = pjoin(root, ...rel.split("/"));
          // Never follow a link: the walk skipped symlinks, and this re-checks the leaf right before reading.
          const st = lstatSync(abs);
          if (st.isFile() && !st.isSymbolicLink() && st.size <= limit) text = readFileSync(abs, "utf8");
        } catch {
          text = undefined;
        }
      }
      cache.set(rel, text);
      return text;
    },
  };

  const locks = new NpmLocks(files);
  const catalogs = new Map<string, Catalog | undefined>();
  const catalogFor = (rel: string): Catalog | undefined => {
    for (let dir = dirOf(rel); ; dir = dirOf(dir)) {
      const f = join(dir, "gradle/libs.versions.toml");
      if (files.has(f)) {
        if (!catalogs.has(f)) catalogs.set(f, parseCatalog(files.read(f) ?? ""));
        return catalogs.get(f);
      }
      if (!dir) return undefined;
    }
  };

  let deps: Dependency[] = [];
  for (const m of manifests) {
    const text = files.read(m.rel);
    if (text === undefined) continue;
    try {
      switch (m.kind) {
        case "package.json": deps.push(...parsePackageJson(text, m.rel, locks)); break;
        case "gradle": deps.push(...parseGradleBuild(text, m.rel, files, catalogFor(m.rel))); break;
        case "catalog": deps.push(...parseCatalogDeps(text, m.rel)); break;
        case "wrapper": deps.push(...parseGradleWrapper(text, m.rel)); break;
        case "pom": deps.push(...parsePom(text, m.rel)); break;
        case "requirements": deps.push(...parseRequirementsTxt(text, m.rel)); break;
        case "pyproject": deps.push(...parsePyproject(text, m.rel)); break;
        case "gomod": deps.push(...parseGoMod(text, m.rel)); break;
        case "cargo": deps.push(...parseCargoToml(text, m.rel, files)); break;
      }
    } catch {
      // a malformed manifest never fails the scan
    }
  }
  deps = finishGradle(deps);

  const seen = new Set<string>();
  deps = deps.filter((d) => {
    const key = [d.ecosystem, d.name, d.versionSpec, d.sourceFile, d.scope, d.kind].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dependenciesTruncated = deps.length > MAX_DEPENDENCIES;
  if (dependenciesTruncated) deps = deps.slice(0, MAX_DEPENDENCIES);

  const names = new Set([...found.keys()].map((r) => r.slice(r.lastIndexOf("/") + 1)));
  const kinds = new Set(manifests.map((m) => m.kind));
  const build = new Set<string>();
  if (kinds.has("package.json")) build.add(names.has("pnpm-lock.yaml") ? "pnpm" : names.has("yarn.lock") ? "yarn" : "npm");
  if (kinds.has("gradle") || kinds.has("wrapper") || names.has("settings.gradle") || names.has("settings.gradle.kts")) build.add("gradle");
  if (kinds.has("pom")) build.add("maven");
  if (kinds.has("requirements")) build.add("pip");
  if (kinds.has("pyproject")) build.add(names.has("poetry.lock") ? "poetry" : "pyproject");
  if (kinds.has("gomod")) build.add("go");
  if (kinds.has("cargo")) build.add("cargo");

  return {
    repoPath: root,
    languages: [...extCounts.entries()].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files || (a.language < b.language ? -1 : 1)),
    buildSystems: [...build],
    manifests: manifests.map((m) => m.rel),
    dependencies: deps,
    limits: { manifestsTruncated, dependenciesTruncated, filesTruncated, skippedSymlinks },
  };
}
