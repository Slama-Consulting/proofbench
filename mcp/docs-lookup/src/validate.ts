/** Strict validation of every value that ends up in a URL path. Nothing is "sanitised": it is accepted or refused. */

export class InputError extends Error {}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAVEN_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const GO_MODULE = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/;
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+~ -]{1,200}$/;

function check(ok: boolean, what: string, value: string): void {
  if (!ok) throw new InputError(`invalid ${what}: ${JSON.stringify(value.slice(0, 80))}`);
}

export function npmName(v: string): string {
  check(v.length <= 214 && NPM_NAME.test(v), "npm package name", v);
  return v;
}
export function pypiName(v: string): string {
  check(PYPI_NAME.test(v), "PyPI project name", v);
  return v;
}
export function crateName(v: string): string {
  check(CRATE_NAME.test(v), "crate name", v);
  return v;
}
export function mavenPart(v: string, what = "Maven coordinate"): string {
  check(MAVEN_PART.test(v) && !v.includes(".."), what, v);
  return v;
}
export function goModule(v: string): string {
  check(v.length <= 300 && GO_MODULE.test(v) && !v.split("/").some((s) => s === "." || s === ".."), "Go module path", v);
  return v;
}
export function version(v: string): string {
  check(VERSION.test(v) && !v.includes(".."), "version", v);
  return v;
}
export function gitRef(v: string): string {
  check(GIT_REF.test(v) && !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".lock"), "git ref", v);
  return v;
}
export function ghOwner(v: string): string {
  check(GH_OWNER.test(v), "GitHub owner", v);
  return v;
}
export function ghRepo(v: string): string {
  check(GH_REPO.test(v) && v !== "." && v !== "..", "GitHub repository", v);
  return v;
}
/** A repo-relative file or directory path, e.g. `docs/guide/intro.md`. No empty, `.` or `..` segment. */
export function repoPath(v: string): string {
  const parts = v.split("/");
  check(v.length <= 500 && parts.every((s) => s !== "." && s !== ".." && PATH_SEGMENT.test(s)), "repository path", v);
  return v;
}

/** Go proxy case encoding: an upper-case letter becomes `!` + lower-case letter. */
export function goEscape(module: string): string {
  return module.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

/** Encodes each segment of a slash-separated path. */
export function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Normalises any GitHub URL form to `https://github.com/owner/repo`; null if it is not GitHub. */
export function normalizeGithubUrl(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/^git\+/, "").replace(/^scm:git:/, "").replace(/^scm:/, "");
  s = s.replace(/^git@github\.com:/i, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  s = s.replace(/^(git|ssh|http):\/\/(?:git@)?github\.com\//i, "https://github.com/");
  s = s.replace(/^github:/i, "https://github.com/");
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s)) s = "https://github.com/" + s;
  const m = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(s);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (!GH_OWNER.test(owner) || !GH_REPO.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}

export function splitGithub(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
