export type Ecosystem = "npm" | "maven" | "pypi" | "crates" | "go" | "tool";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** The version expression exactly as written in the manifest (may be empty when it is managed elsewhere). */
  versionSpec: string;
  /** The exact version when it can be known (lock file, catalog, pinned requirement). */
  resolvedVersion?: string;
  /** Repo-relative path, forward slashes. */
  sourceFile: string;
  scope: string;
  kind: "library" | "plugin" | "tool";
}

/** Read-only view of the files the scanner found. */
export interface FileAccess {
  /** Text of a repo-relative file, or undefined if missing/unreadable/too large. */
  read(rel: string): string | undefined;
  has(rel: string): boolean;
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** True when the string looks like one exact version (no range operators, no variables). */
export function isExactVersion(v: string): boolean {
  return /^[0-9][0-9A-Za-z.+_-]*$/.test(v);
}
