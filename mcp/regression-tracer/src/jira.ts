import { getJson, isLocalHostname, redact, statusMiss, type ClientOptions, type FetchFn, type HttpOutcome } from "./http.js";
import { namesUser, sessionFor, type JiraSession, type SessionProvider } from "./jira-session.js";

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d{1,9}$/;

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
}

function parseBase(baseUrl: string, opts: ClientOptions): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("JIRA_BASE_URL is invalid");
  }
  const localOk = opts.allowHttpLocalhost === true && u.protocol === "http:" && isLocalHostname(u.hostname);
  if (u.protocol !== "https:" && !localOk) throw new Error("JIRA_BASE_URL must use HTTPS");
  if (u.username || u.password) throw new Error("JIRA_BASE_URL must not contain credentials");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

function issueFields(body: unknown): { summary: string; status: string } {
  const o = body as { fields?: { summary?: unknown; status?: { name?: unknown } } } | null;
  const summary = o?.fields?.summary;
  const status = o?.fields?.status?.name;
  return { summary: typeof summary === "string" ? summary : "", status: typeof status === "string" ? status : "" };
}

/**
 * Read-only Jira client. The base URL comes only from JIRA_BASE_URL (supplied by the caller),
 * over HTTPS. The key is validated then encoded in the path. Failures do not throw: they go into
 * `misses`, which never contain the token. 404: `null` without a miss (key unknown or invisible).
 */
export class JiraClient {
  readonly misses: string[] = [];
  private readonly base: string;
  private readonly auth: string;

  constructor(
    baseUrl: string,
    private readonly email: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly opts: ClientOptions = {},
  ) {
    this.base = parseBase(baseUrl, opts);
    this.auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  /** URL of the ticket page, for display. Invalid key: null. */
  browseUrl(key: string): string | null {
    return JIRA_KEY_RE.test(key) ? `${this.base}/browse/${encodeURIComponent(key)}` : null;
  }

  async getIssue(key: string): Promise<JiraIssue | null> {
    if (!JIRA_KEY_RE.test(key)) return null;
    const url = `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`;
    const r = await getJson(this.fetchFn, url, { Authorization: this.auth }, [this.token, this.auth], this.opts.timeoutMs);
    if (!r.ok) {
      this.misses.push(`Jira: request failed (${r.error})`);
      return null;
    }
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) {
      this.misses.push(statusMiss("Jira", r.status));
      return null;
    }
    return { key, ...issueFields(r.body) };
  }
}

/** The server rejects the session: 401, or a redirect to a login page. A 403 is settled by `/myself`. */
function sessionRejected(r: HttpOutcome): boolean {
  return r.ok ? r.status === 401 || (r.status >= 300 && r.status < 400) : r.redirected === true;
}

/**
 * Jira client per browser session, on REST v2. Same guarantees as `JiraClient`, over HTTPS with no exception,
 * and never writing a cookie into a miss or a rendered field. A rejection abandons the session and redoes the
 * check, once per client: each `link_change` has its own, and the session limits windows. A 404 or
 * a 403 counts as an answer about the ticket only if `/myself` confirms the session.
 */
export class JiraBrowserClient {
  readonly misses: string[] = [];
  private readonly base: string;
  private readonly session: JiraSession;
  private retried = false;
  private unavailable: string | null = null;
  private probed: "authenticated" | "rejected" | "failed" | null = null;

  constructor(
    baseUrl: string,
    provider: SessionProvider,
    private readonly loginTimeoutMs: number,
    private readonly fetchFn: FetchFn = fetch,
    private readonly opts: ClientOptions = {},
  ) {
    // Without `opts`: the tests' local http exception does not apply to cookies.
    this.base = parseBase(baseUrl, {});
    this.session = sessionFor(provider, this.base);
  }

  browseUrl(key: string): string | null {
    return JIRA_KEY_RE.test(key) ? `${this.base}/browse/${encodeURIComponent(key)}` : null;
  }

  /** Once per client, with the cookies in hand, through the API only: no window can come out of it. */
  private async probe(header: string, secrets: string[]): Promise<"authenticated" | "rejected" | "failed"> {
    if (this.probed) return this.probed;
    const r = await getJson(this.fetchFn, `${this.base}/rest/api/2/myself`, { Cookie: header }, secrets, this.opts.timeoutMs);
    const refused = sessionRejected(r) || r.status === 403 || (r.status !== undefined && r.status >= 200 && r.status < 300);
    if (r.ok && r.status >= 200 && r.status < 300 && namesUser(r.body)) this.probed = "authenticated";
    else this.probed = refused ? "rejected" : "failed";
    return this.probed;
  }

  async getIssue(key: string): Promise<JiraIssue | null> {
    if (!JIRA_KEY_RE.test(key)) return null;
    const url = `${this.base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status`;
    for (;;) {
      const s = this.unavailable ? { ok: false as const, miss: this.unavailable } : await this.session.acquire(this.loginTimeoutMs);
      if (!s.ok) {
        // Repeated for each ticket: without a miss, `link_change` would read a ticket unknown to Jira.
        this.unavailable = s.miss;
        this.misses.push(s.miss);
        return null;
      }
      const r = await getJson(this.fetchFn, url, { Cookie: s.header }, s.secrets, this.opts.timeoutMs);
      // A 404 or a 403 may come from a call handled anonymously: only `/myself` says whether the session is still alive.
      const ambiguous = r.ok && (r.status === 404 || r.status === 403);
      const probe = ambiguous ? await this.probe(s.header, s.secrets) : null;
      if (sessionRejected(r) || probe === "rejected") {
        if (!this.retried) {
          this.retried = true;
          this.session.drop();
          continue;
        }
        this.misses.push(`Jira: session rejected (${r.ok ? `HTTP ${r.status}` : "redirect"}), links not verified`);
        return null;
      }
      if (!r.ok) {
        this.misses.push(`Jira: request failed (${r.error})`);
        return null;
      }
      if (probe === "failed") {
        this.misses.push(`Jira: session not checked after an HTTP ${r.status}, links not verified`);
        return null;
      }
      if (probe === "authenticated") this.session.confirmed();
      if (r.status === 404) return null;
      if (r.status === 403) {
        this.misses.push("Jira: read permission denied on this ticket (HTTP 403)");
        return null;
      }
      if (r.status < 200 || r.status >= 300) {
        this.misses.push(statusMiss("Jira", r.status));
        return null;
      }
      this.session.confirmed();
      const { summary, status } = issueFields(r.body);
      return { key, summary: redact(summary, s.secrets), status: redact(status, s.secrets) };
    }
  }
}
