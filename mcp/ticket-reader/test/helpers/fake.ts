import { createLimiter } from "../../src/http.js";
import type { ReadDeps } from "../../src/read.js";

export interface Reply {
  status?: number;
  body?: unknown;
  /** Raw body text, sent as is. */
  raw?: string;
  headers?: Record<string, string>;
}
export type Handler = Reply | Error | ((url: string, init: RequestInit | undefined) => Reply | Error);
export type Route = [string | RegExp, Handler];

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake `fetch`: the first route whose URL prefix (or regex) matches answers. No network. */
export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([m]) => (typeof m === "string" ? url.startsWith(m) : m.test(url)));
    if (!route) throw new Error(`unexpected request: ${url}`);
    const h = route[1];
    const r = typeof h === "function" ? h(url, init) : h;
    if (r instanceof Error) throw r;
    const body = r.raw ?? JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function deps(env: Record<string, string>, routes: Route[], extra: Partial<ReadDeps> = {}) {
  const f = fakeFetch(routes);
  const d: ReadDeps = { env, fetchFn: f.fetchFn, limiter: createLimiter(0), ...extra };
  return { deps: d, calls: f.calls };
}

export const PARAMS = { commentLimit: 20, descriptionMaxChars: 8000 };

export const JIRA_CLOUD = { JIRA_BASE_URL: "https://jira.example.com", JIRA_EMAIL: "dev@example.com", JIRA_API_TOKEN: "jira-secret-token" };
export const JIRA_PAT = { JIRA_BASE_URL: "https://jira.example.com/jira", JIRA_PAT: "pat-secret-value" };
export const GITLAB_ENV = { GITLAB_TOKEN: "glpat-secret-token-value", GITLAB_HOST: "gitlab.example.com" };
export const LINEAR_ENV = { LINEAR_API_KEY: "lin_api_secret_key" };
export const GITHUB_ENV = { GITHUB_TOKEN: "ghp_secret_token_value" };
