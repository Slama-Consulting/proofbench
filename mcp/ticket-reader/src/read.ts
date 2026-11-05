import { githubConfig, gitlabConfig, gitlabHost, jiraBase, jiraConfig, linearConfig, secretsOf, type Env } from "./config.js";
import { Http, type FetchFn, type Limiter } from "./http.js";
import { browserSessionProvider } from "./jira-browser.js";
import { sessionFor, type SessionProvider } from "./jira-session.js";
import { readGithub, RATE_LIMIT_HINT } from "./providers/github.js";
import { readGitlab } from "./providers/gitlab.js";
import { readJira } from "./providers/jira.js";
import { readLinear } from "./providers/linear.js";
import { parseRef, type RefContext } from "./refs.js";
import type { Provider, ReadParams, Ticket } from "./types.js";

export interface ReadDeps {
  env: Env;
  fetchFn: FetchFn;
  limiter: Limiter;
  /** Reserved for tests: allows http:// to localhost. */
  allowHttpLocalhost?: boolean;
  timeoutMs?: number;
  /** Where the Jira session cookies come from. Defaults to the Chromium profile; tests inject a fake. */
  sessionProvider?: SessionProvider;
}

export function refContext(env: Env, allowHttpLocalhost = false): RefContext {
  const base = jiraBase(env, allowHttpLocalhost);
  const host = gitlabHost(env);
  return {
    ...(base ? { jira: base } : {}),
    jiraConfigured: jiraConfig(env, allowHttpLocalhost).ok,
    linearConfigured: linearConfig(env).ok,
    gitlabHost: host.ok ? host.host : "gitlab.com",
    allowHttpLocalhost,
  };
}

function notConfigured(label: string, problems: string[]): Error {
  return new Error(`${label} is not configured: ${problems.join("; ")}. Run ticket_providers to see the variables to set.`);
}

/**
 * Reads one ticket and returns it normalised. Throws an Error with a message safe to show (no secret);
 * the server turns it into `{ "untrusted": true, "error": ... }`.
 */
export async function readTicket(input: { ref: string; provider?: Provider }, params: ReadParams, deps: ReadDeps): Promise<Ticket> {
  const { env, allowHttpLocalhost } = deps;
  const parsed = parseRef(input.ref, input.provider, refContext(env, allowHttpLocalhost));
  const secrets = secretsOf(env);
  const http = (service: string, rateLimitHint?: string, extraSecrets: readonly string[] = []) =>
    new Http({
      fetchFn: deps.fetchFn,
      limiter: deps.limiter,
      service,
      secrets: [...secrets, ...extraSecrets],
      ...(allowHttpLocalhost !== undefined ? { allowHttpLocalhost } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(rateLimitHint !== undefined ? { rateLimitHint } : {}),
    });

  switch (parsed.provider) {
    case "jira": {
      const cfg = jiraConfig(env, allowHttpLocalhost);
      if (!cfg.ok) throw notConfigured("Jira", cfg.problems);
      const handle = sessionFor(deps.sessionProvider ?? browserSessionProvider, cfg.value.baseUrl);
      const acquired = await handle.acquire(cfg.value.loginTimeoutMs);
      if (!acquired.ok) throw new Error(acquired.miss);
      return readJira(parsed, cfg.value, { http: http("Jira", undefined, acquired.secrets), params }, { handle, cookie: acquired.header });
    }
    case "github": {
      const cfg = githubConfig(env);
      return readGithub(parsed, cfg, { http: http("GitHub", cfg.token ? undefined : RATE_LIMIT_HINT), params });
    }
    case "gitlab": {
      const cfg = gitlabConfig(env, allowHttpLocalhost);
      if (!cfg.ok) throw notConfigured("GitLab", cfg.problems);
      return readGitlab(parsed, cfg.value, { http: http("GitLab"), params });
    }
    case "linear": {
      const cfg = linearConfig(env);
      if (!cfg.ok) throw notConfigured("Linear", cfg.problems);
      return readLinear(parsed, cfg.value, { http: http("Linear"), params });
    }
  }
}
