import { isLocalHostname } from "./http.js";
import type { Provider } from "./types.js";

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d{1,9}$/;
const LINEAR_KEY_RE = /^[A-Z][A-Z0-9]*-\d{1,9}$/;
const NUMBER_RE = /^\d{1,9}$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_REF_LENGTH = 2048;
const MAX_PROJECT_DEPTH = 20;

export type ParsedRef =
  | { provider: "jira"; key: string }
  | { provider: "linear"; key: string }
  | { provider: "github"; owner: string; repo: string; number: number; hint: "issue" | "pull" | "any" }
  | { provider: "gitlab"; project: string; number: number; type: "issue" | "mr" };

export interface RefContext {
  /** Host and context path of JIRA_BASE_URL when it is valid. */
  jira?: { host: string; basePath: string };
  jiraConfigured: boolean;
  linearConfigured: boolean;
  gitlabHost: string;
  allowHttpLocalhost?: boolean;
}

function okSegment(s: string): boolean {
  return SEGMENT_RE.test(s) && s !== "." && s !== "..";
}

function parseNumber(s: string): number {
  if (!NUMBER_RE.test(s)) throw new Error("ticket number must be 1 to 9 digits");
  return Number(s);
}

function parseUrl(ref: string, hint: Provider | undefined, ctx: RefContext): ParsedRef {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error("ref is not a valid URL");
  }
  if (url.username || url.password) throw new Error("ref refused: URLs with credentials (user@host) are not accepted");
  const local = ctx.allowHttpLocalhost === true && url.protocol === "http:" && isLocalHostname(url.hostname);
  if (url.protocol !== "https:" && !local) throw new Error("ref refused: only HTTPS URLs are accepted");

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((s) => s !== "");
  let provider: Provider;
  if (ctx.jira && url.host.toLowerCase() === ctx.jira.host.toLowerCase()) provider = "jira";
  else if (url.port === "" && (host === "github.com" || host === "www.github.com")) provider = "github";
  else if (url.port === "" && host === "linear.app") provider = "linear";
  else if (url.port === "" && host === ctx.gitlabHost) provider = "gitlab";
  else throw new Error(`ref refused: host "${url.host.slice(0, 100)}" is not a configured tracker host (Jira: JIRA_BASE_URL, GitLab: GITLAB_HOST, or github.com / linear.app)`);
  if (hint !== undefined && hint !== provider) throw new Error(`ref is a ${provider} URL but provider "${hint}" was requested`);

  if (provider === "jira") {
    const base = (ctx.jira?.basePath ?? "").split("/").filter((s) => s !== "");
    const rest = segments.slice(0, base.length).join("/") === base.join("/") ? segments.slice(base.length) : null;
    if (!rest || rest.length !== 2 || rest[0] !== "browse" || !JIRA_KEY_RE.test(rest[1] ?? "")) throw new Error("Jira URL must look like <JIRA_BASE_URL>/browse/KEY-123");
    return { provider, key: rest[1] as string };
  }
  if (provider === "github") {
    const [owner, repo, kind, n] = segments;
    if (segments.length < 4 || !owner || !repo || !okSegment(owner) || !okSegment(repo) || (kind !== "issues" && kind !== "pull") || n === undefined) {
      throw new Error("GitHub URL must look like https://github.com/{owner}/{repo}/issues/{n} or /pull/{n}");
    }
    return { provider, owner, repo, number: parseNumber(n), hint: kind === "pull" ? "pull" : "issue" };
  }
  if (provider === "gitlab") {
    const at = segments.indexOf("-");
    const kind = segments[at + 1];
    const n = segments[at + 2];
    const project = segments.slice(0, at);
    if (at < 2 || project.length > MAX_PROJECT_DEPTH || !project.every(okSegment) || (kind !== "issues" && kind !== "merge_requests") || n === undefined) {
      throw new Error("GitLab URL must look like https://<GITLAB_HOST>/{group}/{project}/-/issues/{n} or /-/merge_requests/{n}");
    }
    return { provider, project: project.join("/"), number: parseNumber(n), type: kind === "issues" ? "issue" : "mr" };
  }
  const [, issue, key] = segments;
  if (segments.length < 3 || issue !== "issue" || !key || !LINEAR_KEY_RE.test(key)) throw new Error("Linear URL must look like https://linear.app/{workspace}/issue/ENG-12");
  return { provider: "linear", key };
}

/**
 * Turns a ticket URL or key into a structured reference. Pure: no network, no environment.
 * A URL is accepted only when its host is the configured host of its provider (or github.com / linear.app),
 * which blocks SSRF and token exfiltration through look-alike hosts.
 */
export function parseRef(input: string, hint: Provider | undefined, ctx: RefContext): ParsedRef {
  const ref = input.trim();
  if (ref === "") throw new Error("ref is empty");
  if (ref.length > MAX_REF_LENGTH) throw new Error("ref is too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(ref)) throw new Error("ref must not contain whitespace or control characters");

  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return parseUrl(ref, hint, ctx);

  if (JIRA_KEY_RE.test(ref) || LINEAR_KEY_RE.test(ref)) {
    if (hint === "github" || hint === "gitlab") throw new Error(`"${ref}" is a ticket key, not a ${hint} reference`);
    if (hint === "jira") {
      if (!JIRA_KEY_RE.test(ref)) throw new Error("not a valid Jira key");
      return { provider: "jira", key: ref };
    }
    if (hint === "linear") return { provider: "linear", key: ref };
    if (ctx.jiraConfigured && ctx.linearConfigured) throw new Error('key is ambiguous (Jira and Linear are both configured): pass provider "jira" or "linear"');
    if (ctx.jiraConfigured && JIRA_KEY_RE.test(ref)) return { provider: "jira", key: ref };
    if (ctx.linearConfigured) return { provider: "linear", key: ref };
    throw new Error('key needs a configured Jira or Linear: pass provider "jira" or "linear" and set the environment variables (see ticket_providers)');
  }

  const shorthand = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)([#!])(\d{1,9})$/.exec(ref);
  if (shorthand) {
    const path = (shorthand[1] as string).split("/");
    const sep = shorthand[2] as string;
    const n = parseNumber(shorthand[3] as string);
    if (!path.every(okSegment) || path.length > MAX_PROJECT_DEPTH) throw new Error("invalid repository or project path");
    if (hint === "jira" || hint === "linear") throw new Error(`"${ref}" is not a ${hint} reference`);
    const gitlab = hint === "gitlab" || (hint === undefined && (path.length > 2 || sep === "!"));
    if (gitlab) return { provider: "gitlab", project: path.join("/"), number: n, type: sep === "!" ? "mr" : "issue" };
    if (path.length !== 2) throw new Error("GitHub reference must be owner/repo#number");
    return { provider: "github", owner: path[0] as string, repo: path[1] as string, number: n, hint: "any" };
  }
  throw new Error("ref is not a ticket URL, a Jira/Linear key (PROJ-123), owner/repo#42 or group/project#7");
}
