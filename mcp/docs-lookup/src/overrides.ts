import data from "./data/overrides.json" with { type: "json" };
import { normalizeGithubUrl } from "./validate.js";

export interface OverrideSource {
  repository: string;
  /** Candidate git refs; `{version}` is replaced. An empty list means "default branch only". */
  refTemplates: string[];
  /** Repo-relative files fetched as they are. */
  files: string[];
  /** Repo-relative directories whose Markdown/AsciiDoc files are indexed. */
  dirs: string[];
}

export interface OverrideEntry {
  id: string;
  title: string;
  match: { ecosystems: string[]; names: string[]; namePrefixes: string[] };
  repository: string;
  homepage: string;
  documentationUrl: string;
  sources: OverrideSource[];
}

export const OVERRIDES: readonly OverrideEntry[] = (data as { entries: OverrideEntry[] }).entries;

/** `group:group.gradle.plugin` (a Gradle plugin marker) -> the plugin id. */
export function canonicalName(name: string): string {
  const m = /^([^:]+):([^:]+)\.gradle\.plugin$/.exec(name);
  return m && m[1] === m[2] ? m[1]! : name;
}

export function findOverride(ecosystem: string, name: string, entries: readonly OverrideEntry[] = OVERRIDES): OverrideEntry | undefined {
  const lower = name.toLowerCase();
  const canon = canonicalName(lower);
  return entries.find(
    (e) =>
      e.match.ecosystems.includes(ecosystem) &&
      (e.match.names.some((n) => n.toLowerCase() === lower || n.toLowerCase() === canon) ||
        e.match.namePrefixes.some((p) => lower.startsWith(p.toLowerCase()) || canon.startsWith(p.toLowerCase()))),
  );
}

/** Structural check used by the unit tests (and cheap enough to run on load in a debugger). */
export function overrideProblems(entries: readonly OverrideEntry[] = OVERRIDES): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) problems.push(`duplicate id ${e.id}`);
    ids.add(e.id);
    if (!normalizeGithubUrl(e.repository)) problems.push(`${e.id}: repository is not a GitHub URL`);
    if (!e.match.names.length && !e.match.namePrefixes.length) problems.push(`${e.id}: no match rule`);
    if (!e.sources.length) problems.push(`${e.id}: no sources`);
    for (const s of e.sources) {
      if (!normalizeGithubUrl(s.repository)) problems.push(`${e.id}: source repository is not a GitHub URL`);
      if (!s.files.length && !s.dirs.length) problems.push(`${e.id}: source without files or dirs`);
    }
  }
  return problems;
}
