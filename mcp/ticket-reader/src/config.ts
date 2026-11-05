import { isLocalHostname } from "./http.js";
import { loginTimeoutMs } from "./jira-session.js";
import type { Provider } from "./types.js";

/** Configuration comes from environment variables only: never from a repository, a ticket or a ref. */
export type Env = Readonly<Record<string, string | undefined>>;

export type Cfg<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export interface JiraConfig {
  /** Origin plus optional context path, no trailing slash. */
  baseUrl: string;
  /** `host[:port]`, compared with the host of a pasted URL. */
  host: string;
  /** Context path (`""` or `/jira`). */
  basePath: string;
  /** How long a first browser login may take. */
  loginTimeoutMs: number;
}

export interface GithubConfig {
  token?: string;
}

export interface GitlabConfig {
  host: string;
  baseUrl: string;
  token: string;
}

export interface LinearConfig {
  apiKey: string;
}

function val(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Host and context path of a valid, safe JIRA_BASE_URL, even when the credentials are missing. */
export function jiraBase(env: Env, allowHttpLocalhost = false): { host: string; basePath: string } | null {
  const raw = val(env, "JIRA_BASE_URL");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const localOk = allowHttpLocalhost && u.protocol === "http:" && isLocalHostname(u.hostname);
    if ((u.protocol !== "https:" && !localOk) || u.username || u.password) return null;
    return { host: u.host, basePath: u.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export function jiraConfig(env: Env, allowHttpLocalhost = false): Cfg<JiraConfig> {
  const problems: string[] = [];
  const raw = val(env, "JIRA_BASE_URL");
  let base: URL | undefined;
  if (!raw) problems.push("JIRA_BASE_URL is not set (HTTPS URL of your Jira, for example https://jira.example.com)");
  else {
    try {
      base = new URL(raw);
    } catch {
      problems.push("JIRA_BASE_URL is not a valid URL");
    }
    if (base) {
      const localOk = allowHttpLocalhost && base.protocol === "http:" && isLocalHostname(base.hostname);
      if (base.protocol !== "https:" && !localOk) {
        problems.push("JIRA_BASE_URL must use HTTPS");
        base = undefined;
      } else if (base.username || base.password) {
        problems.push("JIRA_BASE_URL must not contain credentials");
        base = undefined;
      }
    }
  }
  if (problems.length > 0 || !base) return { ok: false, problems };
  const basePath = base.pathname.replace(/\/+$/, "");
  return { ok: true, value: { baseUrl: `${base.protocol}//${base.host}${basePath}`, host: base.host, basePath, loginTimeoutMs: loginTimeoutMs(env) } };
}

export function githubConfig(env: Env): GithubConfig {
  const token = val(env, "GITHUB_TOKEN");
  return token ? { token } : {};
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** `GITLAB_HOST`: a bare host name (default `gitlab.com`), no scheme, no port, no path. */
export function gitlabHost(env: Env): { ok: true; host: string } | { ok: false; problem: string } {
  const raw = val(env, "GITLAB_HOST");
  if (raw === undefined) return { ok: true, host: "gitlab.com" };
  const host = raw.toLowerCase();
  if (!HOST_RE.test(host) || host.includes("..")) return { ok: false, problem: "GITLAB_HOST must be a bare host name (no scheme, port or path), for example gitlab.example.com" };
  return { ok: true, host };
}

export function gitlabConfig(env: Env, allowHttpLocalhost = false): Cfg<GitlabConfig> {
  const problems: string[] = [];
  const h = gitlabHost(env);
  if (!h.ok) problems.push(h.problem);
  const token = val(env, "GITLAB_TOKEN");
  if (!token) problems.push("GITLAB_TOKEN is not set (a personal access token with the read_api scope)");
  if (problems.length > 0 || !h.ok || !token) return { ok: false, problems };
  const scheme = allowHttpLocalhost && isLocalHostname(h.host) ? "http" : "https";
  return { ok: true, value: { host: h.host, baseUrl: `${scheme}://${h.host}`, token } };
}

export function linearConfig(env: Env): Cfg<LinearConfig> {
  const apiKey = val(env, "LINEAR_API_KEY");
  return apiKey ? { ok: true, value: { apiKey } } : { ok: false, problems: ["LINEAR_API_KEY is not set (a personal API key from Linear settings)"] };
}

/** Every secret value in the environment, for redaction. */
export function secretsOf(env: Env): string[] {
  const out: string[] = [];
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "LINEAR_API_KEY"]) {
    const v = val(env, name);
    if (v) out.push(v);
  }
  return out;
}

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  /** Public, non-secret facts about the configuration. */
  details: Record<string, string | boolean>;
  /** For an unconfigured provider: the exact variables to set. */
  setEnv?: string[];
  /** Variables that are optional but useful. */
  optionalEnv?: string[];
  problems?: string[];
}

/** Which providers are configured. Never contains a secret value and makes no network call. */
export function providerStatuses(env: Env, allowHttpLocalhost = false): ProviderStatus[] {
  const out: ProviderStatus[] = [];

  const jira = jiraConfig(env, allowHttpLocalhost);
  out.push(
    jira.ok
      ? { provider: "jira", configured: true, details: { host: jira.value.host, auth: "browser session (SSO login in a Chromium window, no token)" }, optionalEnv: ["JIRA_LOGIN_TIMEOUT_S"] }
      : {
          provider: "jira",
          configured: false,
          details: {},
          setEnv: ["JIRA_BASE_URL"],
          optionalEnv: ["JIRA_LOGIN_TIMEOUT_S"],
          problems: jira.problems,
        },
  );

  const github = githubConfig(env);
  out.push({
    provider: "github",
    configured: true,
    details: { host: "github.com", authenticated: github.token !== undefined },
    ...(github.token === undefined ? { optionalEnv: ["GITHUB_TOKEN"] } : {}),
  });

  const gitlab = gitlabConfig(env, allowHttpLocalhost);
  out.push(
    gitlab.ok
      ? { provider: "gitlab", configured: true, details: { host: gitlab.value.host } }
      : { provider: "gitlab", configured: false, details: {}, setEnv: ["GITLAB_TOKEN"], optionalEnv: ["GITLAB_HOST"], problems: gitlab.problems },
  );

  const linear = linearConfig(env);
  out.push(linear.ok ? { provider: "linear", configured: true, details: { host: "linear.app" } } : { provider: "linear", configured: false, details: {}, setEnv: ["LINEAR_API_KEY"], problems: linear.problems });

  return out;
}
