import { asString, asStringArray, asTable, parseToml, type TomlValue } from "./toml.js";
import type { Dependency } from "./types.js";

/** PyPI name normalisation (PEP 503). */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Parses one PEP 508 requirement ("requests[security]>=2.0,<3 ; python_version>'3'"). Null for options, URLs and paths. */
export function parseRequirement(line: string): { name: string; spec: string } | null {
  const s = line.split(/\s#/)[0]!.split(/\s--/)[0]!.split(";")[0]!.trim();
  if (!s || s.startsWith("-") || s.startsWith("#") || /^(https?|git\+|file):/.test(s) || s.startsWith(".") || s.includes("/")) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:@\s*\S+|\(?\s*([<>=!~][^()]*?)\s*\)?)?$/.exec(s);
  if (!m) return null;
  return { name: normalizePyName(m[1]!), spec: (m[2] ?? "").replace(/\s+/g, "") };
}

function pinned(spec: string): string | undefined {
  const m = /^===?([0-9][0-9A-Za-z.+!_-]*)$/.exec(spec);
  return m ? m[1] : undefined;
}

function dep(name: string, spec: string, rel: string, scope: string, kind: Dependency["kind"] = "library"): Dependency {
  const d: Dependency = { ecosystem: kind === "tool" ? "tool" : "pypi", name, versionSpec: spec, sourceFile: rel, scope, kind };
  const p = pinned(spec);
  if (p) d.resolvedVersion = p;
  return d;
}

export function parseRequirementsTxt(content: string, rel: string): Dependency[] {
  const out: Dependency[] = [];
  const scope = /dev|test|lint|doc/i.test(rel) ? "dev" : "runtime";
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const r = parseRequirement(line);
    if (r) out.push(dep(r.name, r.spec, rel, scope));
  }
  return out;
}

function fromList(list: string[], rel: string, scope: string): Dependency[] {
  const out: Dependency[] = [];
  for (const item of list) {
    const r = parseRequirement(item);
    if (r) out.push(dep(r.name, r.spec, rel, scope));
  }
  return out;
}

/** Poetry: `name = "^1.2"` or `name = { version = "^1.2", ... }`. */
function fromPoetryTable(table: Record<string, TomlValue> | undefined, rel: string, scope: string): Dependency[] {
  const out: Dependency[] = [];
  for (const [name, v] of Object.entries(table ?? {})) {
    const spec = typeof v === "string" ? v : asString(asTable(v)?.version) ?? (Array.isArray(v) ? asString(asTable(v[0])?.version) : undefined);
    if (name.toLowerCase() === "python") {
      if (spec) out.push({ ecosystem: "tool", name: "python", versionSpec: spec, sourceFile: rel, scope, kind: "tool" });
      continue;
    }
    if (spec === undefined) continue;
    out.push(dep(normalizePyName(name), spec.replace(/\s+/g, ""), rel, scope));
  }
  return out;
}

export function parsePyproject(content: string, rel: string): Dependency[] {
  const doc = parseToml(content);
  const out: Dependency[] = [];
  out.push(...fromList(asStringArray(doc.project?.dependencies), rel, "runtime"));
  for (const [group, list] of Object.entries(doc["project.optional-dependencies"] ?? {})) out.push(...fromList(asStringArray(list), rel, `optional:${group}`));
  for (const [group, list] of Object.entries(doc["dependency-groups"] ?? {})) out.push(...fromList(asStringArray(list), rel, `group:${group}`));
  out.push(...fromList(asStringArray(doc["build-system"]?.requires), rel, "build"));
  const rp = asString(doc.project?.["requires-python"]);
  if (rp) out.push({ ecosystem: "tool", name: "python", versionSpec: rp, sourceFile: rel, scope: "requires-python", kind: "tool" });

  out.push(...fromPoetryTable(doc["tool.poetry.dependencies"], rel, "runtime"));
  out.push(...fromPoetryTable(doc["tool.poetry.dev-dependencies"], rel, "dev"));
  for (const [section, table] of Object.entries(doc)) {
    const g = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(section);
    if (g) out.push(...fromPoetryTable(table, rel, `group:${g[1]}`));
  }
  return out;
}
