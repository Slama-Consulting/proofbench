import { asString, asTable, parseToml, type TomlTable } from "./toml.js";
import { dirOf, isExactVersion, join, type Dependency, type FileAccess } from "./types.js";

/** Strips line and block comments (keeps strings intact enough for dependency scanning). */
function stripGradleComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** `libs.androidx.core.ktx` accessor for a catalog alias such as `androidx-core-ktx`. */
export function accessorOf(alias: string): string {
  return alias.replace(/[-_]/g, ".");
}

export interface Catalog {
  versions: Record<string, string>;
  libraries: Map<string, { group: string; name: string; versionSpec: string; resolved?: string }>;
  plugins: Map<string, { id: string; versionSpec: string; resolved?: string }>;
}

function versionOf(v: unknown, versions: Record<string, string>): { spec: string; resolved?: string } {
  if (typeof v === "string") return { spec: v, ...(isExactVersion(v) ? { resolved: v } : {}) };
  const t = asTable(v as never);
  if (!t) return { spec: "" };
  const ref = asString(t.ref);
  if (ref) {
    const r = versions[ref];
    return { spec: `ref:${ref}`, ...(r && isExactVersion(r) ? { resolved: r } : {}) };
  }
  const direct = asString(t.require) ?? asString(t.strictly) ?? asString(t.prefer);
  if (direct) return { spec: direct, ...(isExactVersion(direct) ? { resolved: direct } : {}) };
  return { spec: "" };
}

export function parseCatalog(content: string): Catalog {
  const doc = parseToml(content);
  const versions: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.versions ?? {})) {
    const s = asString(v) ?? asString(asTable(v)?.require) ?? asString(asTable(v)?.strictly) ?? asString(asTable(v)?.prefer);
    if (s) versions[k] = s;
  }
  const libraries: Catalog["libraries"] = new Map();
  for (const [alias, v] of Object.entries(doc.libraries ?? {})) {
    if (typeof v === "string") {
      const [g, n, ver] = v.split(":");
      if (g && n) libraries.set(alias, { group: g, name: n, versionSpec: ver ?? "", ...(ver && isExactVersion(ver) ? { resolved: ver } : {}) });
      continue;
    }
    const t = asTable(v);
    if (!t) continue;
    let group = asString(t.group);
    let name = asString(t.name);
    const module = asString(t.module);
    if (module) [group, name] = module.split(":");
    if (!group || !name) continue;
    const ver = versionOf(t.version, versions);
    libraries.set(alias, { group, name, versionSpec: ver.spec, ...(ver.resolved ? { resolved: ver.resolved } : {}) });
  }
  const plugins: Catalog["plugins"] = new Map();
  for (const [alias, v] of Object.entries(doc.plugins ?? {})) {
    if (typeof v === "string") {
      const [id, ver] = v.split(":");
      if (id) plugins.set(alias, { id, versionSpec: ver ?? "", ...(ver && isExactVersion(ver) ? { resolved: ver } : {}) });
      continue;
    }
    const t = asTable(v);
    const id = t && asString(t.id);
    if (!t || !id) continue;
    const ver = versionOf(t.version, versions);
    plugins.set(alias, { id, versionSpec: ver.spec, ...(ver.resolved ? { resolved: ver.resolved } : {}) });
  }
  return { versions, libraries, plugins };
}

export function parseCatalogDeps(content: string, rel: string): Dependency[] {
  const cat = parseCatalog(content);
  const out: Dependency[] = [];
  for (const l of cat.libraries.values()) {
    out.push({
      ecosystem: "maven",
      name: `${l.group}:${l.name}`,
      versionSpec: l.versionSpec,
      ...(l.resolved ? { resolvedVersion: l.resolved } : {}),
      sourceFile: rel,
      scope: "catalog",
      kind: "library",
    });
  }
  for (const p of cat.plugins.values()) {
    out.push({
      ecosystem: "maven",
      name: p.id,
      versionSpec: p.versionSpec,
      ...(p.resolved ? { resolvedVersion: p.resolved } : {}),
      sourceFile: rel,
      scope: "catalog",
      kind: "plugin",
    });
  }
  return out;
}

export function parseGradleWrapper(content: string, rel: string): Dependency[] {
  const m = /^distributionUrl\s*=\s*(.+)$/m.exec(content.replace(/\r\n?/g, "\n"));
  if (!m) return [];
  const url = m[1]!.replace(/\\:/g, ":").trim();
  const v = /gradle-([0-9][0-9A-Za-z.+-]*?)-(?:bin|all)\.zip/.exec(url);
  if (!v) return [];
  return [{ ecosystem: "tool", name: "gradle", versionSpec: v[1]!, resolvedVersion: v[1]!, sourceFile: rel, scope: "wrapper", kind: "tool" }];
}

function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Variables declared in the build file (`val x = "1"`, `def x = '1'`, `ext.x = "1"`, `extra["x"] = "1"`) plus gradle.properties. */
function collectVars(src: string, rel: string, files: FileAccess): Record<string, string> {
  const vars: Record<string, string> = {};
  const dir = dirOf(rel);
  for (const f of [join("", "gradle.properties"), join(dir, "gradle.properties")]) {
    if (files.has(f)) Object.assign(vars, parseProperties(files.read(f) ?? ""));
  }
  for (const m of src.matchAll(/(?:\b(?:val|var|def|String)\s+|\bext\.|\bextra\[\s*["'])([A-Za-z_][\w.]*)["']?\]?\s*=\s*["']([^"'$]+)["']/g)) {
    vars[m[1]!] = m[2]!;
  }
  for (const m of src.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*["']([^"'$]+)["']/gm)) vars[m[1]!] ??= m[2]!;
  for (const m of src.matchAll(/\bset\(\s*["']([\w.]+)["']\s*,\s*["']([^"'$]+)["']\s*\)/g)) vars[m[1]!] = m[2]!;
  return vars;
}

function substitute(v: string, vars: Record<string, string>): string | undefined {
  if (!v.includes("$")) return v;
  let ok = true;
  const out = v.replace(/\$\{([\w.]+)\}|\$([A-Za-z_]\w*)/g, (_all, a: string | undefined, b: string | undefined) => {
    const val = vars[(a ?? b)!];
    if (val === undefined) ok = false;
    return val ?? "";
  });
  return ok ? out : undefined;
}

const COORD = /^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^:@\s]+))?(?::[A-Za-z0-9_.-]+)?(?:@[A-Za-z0-9]+)?$/;
const NOT_CONFIG = new Set(["id", "version", "kotlin", "apply", "plugin", "from", "url", "maven", "mavenCentral", "group", "name", "classpath_"]);

function scopeKind(config: string): { scope: string; kind: Dependency["kind"] } {
  return { scope: config, kind: config === "classpath" ? "plugin" : "library" };
}

/** Parses one build.gradle / build.gradle.kts (Groovy or Kotlin DSL). */
export function parseGradleBuild(content: string, rel: string, files: FileAccess, catalog: Catalog | undefined): Dependency[] {
  const src = stripGradleComments(content);
  const vars = collectVars(src, rel, files);
  const out: Dependency[] = [];

  const push = (
    ecosystem: Dependency["ecosystem"],
    name: string,
    versionRaw: string,
    scope: string,
    kind: Dependency["kind"],
  ): void => {
    const sub = versionRaw ? substitute(versionRaw, vars) : "";
    const dep: Dependency = { ecosystem, name, versionSpec: versionRaw, sourceFile: rel, scope, kind };
    if (sub && isExactVersion(sub)) dep.resolvedVersion = sub;
    out.push(dep);
  };

  // String notation: implementation("g:a:v"), api 'g:a:v', classpath "g:a:v", platform("g:a:v")
  for (const m of src.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(?:(?:enforcedPlatform|platform)\s*\(\s*)?["']([^"'\s]+)["']/g)) {
    const config = m[1]!;
    if (NOT_CONFIG.has(config)) continue;
    const c = COORD.exec(m[2]!);
    if (!c) continue;
    const { scope, kind } = scopeKind(config);
    push("maven", `${c[1]}:${c[2]}`, c[3] ?? "", scope, kind);
  }

  // Map notation: group: 'g', name: 'a', version: 'v'   |   group = "g", name = "a", version = "v"
  for (const m of src.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*\(?\s*group\s*[:=]\s*["']([^"']+)["']\s*,\s*name\s*[:=]\s*["']([^"']+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?/g)) {
    const { scope, kind } = scopeKind(m[1]!);
    push("maven", `${m[2]}:${m[3]}`, m[4] ?? "", scope, kind);
  }

  // Plugins: id("x") version "y" | id 'x' version 'y' | kotlin("jvm") version "1.9" | alias(libs.plugins.x)
  for (const m of src.matchAll(/\bid\s*\(?\s*["']([^"']+)["']\s*\)?(?:\s*version\s+\(?\s*["']([^"']+)["'])?/g)) {
    const id = m[1]!;
    if (!id.includes(".") || id.startsWith("org.gradle.")) continue;
    push("maven", id, m[2] ?? "", "plugin", "plugin");
  }
  for (const m of src.matchAll(/\bkotlin\s*\(\s*["']([^"']+)["']\s*\)(?:\s*version\s+\(?\s*["']([^"']+)["'])?/g)) {
    push("maven", `org.jetbrains.kotlin.${m[1]}`, m[2] ?? "", "plugin", "plugin");
  }
  if (catalog) {
    for (const m of src.matchAll(/\balias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/g)) {
      const hit = [...catalog.plugins.entries()].find(([alias]) => accessorOf(alias) === m[1]);
      if (hit) {
        const p = hit[1];
        const dep: Dependency = { ecosystem: "maven", name: p.id, versionSpec: p.versionSpec, sourceFile: rel, scope: "plugin", kind: "plugin" };
        if (p.resolved) dep.resolvedVersion = p.resolved;
        out.push(dep);
      }
    }
  }
  // Plugins applied the legacy way: apply plugin: 'com.diffplug.spotless'
  for (const m of src.matchAll(/\bapply\s+plugin\s*:\s*["']([^"']+)["']/g)) {
    const id = m[1]!;
    if (id.includes(".") && !id.startsWith("org.gradle.")) push("maven", id, "", "plugin", "plugin");
  }
  return out;
}

/**
 * Cross-file clean-up: plugins applied without a version take it from the same id elsewhere in the repo, the Android Gradle
 * plugin ids take it from the `com.android.tools.build:gradle` classpath, and a `kotlin` tool entry is derived from Kotlin plugins.
 */
export function finishGradle(deps: Dependency[]): Dependency[] {
  const versioned = new Map<string, Dependency>();
  for (const d of deps) {
    if (d.ecosystem === "maven" && d.kind === "plugin" && d.resolvedVersion && !versioned.has(d.name)) versioned.set(d.name, d);
  }
  const agp = deps.find((d) => d.name === "com.android.tools.build:gradle" && d.resolvedVersion);
  for (const d of deps) {
    if (d.ecosystem !== "maven" || d.kind !== "plugin" || d.resolvedVersion) continue;
    const v = versioned.get(d.name);
    if (v) {
      d.versionSpec = d.versionSpec || v.versionSpec;
      d.resolvedVersion = v.resolvedVersion;
    } else if (agp && /^com\.android\.(application|library|dynamic-feature|test)$/.test(d.name)) {
      d.versionSpec = d.versionSpec || agp.versionSpec;
      d.resolvedVersion = agp.resolvedVersion;
    }
  }
  const kotlin = deps.find((d) => d.ecosystem === "maven" && d.name.startsWith("org.jetbrains.kotlin.") && d.kind === "plugin" && d.resolvedVersion);
  if (kotlin) {
    deps.push({ ecosystem: "tool", name: "kotlin", versionSpec: kotlin.versionSpec, resolvedVersion: kotlin.resolvedVersion!, sourceFile: kotlin.sourceFile, scope: "plugin", kind: "tool" });
  }
  return deps;
}

export type { TomlTable };
