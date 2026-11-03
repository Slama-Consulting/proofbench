/**
 * Jira session of a browser: cookies kept in memory only, by this process, for a single host.
 * No Playwright loading here: this file is also used for masking.
 */

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Seconds since the epoch; -1 or absent for a session cookie. */
  expires?: number;
}

export interface SessionRequest {
  baseUrl: string;
  loginTimeoutMs: number;
  /** False: only a headless check is allowed. */
  allowWindow: boolean;
}

/** `windowOpened` says a window was shown to the user: that is what consumes the right to open one. */
export type SessionOutcome =
  | { ok: true; cookies: BrowserCookie[]; windowOpened?: boolean }
  | { ok: false; miss: string; windowOpened?: boolean };

export type SessionProvider = (req: SessionRequest) => Promise<SessionOutcome>;

export type SessionHeader = { ok: true; header: string; secrets: string[] } | { ok: false; miss: string };

const DEFAULT_LOGIN_TIMEOUT_S = 120;
/** Any shorter and masking would erase unrelated text: a cookie set to `true` would make results unreadable. */
const MIN_SECRET_LENGTH = 8;
const NO_COOKIE_MISS = "Jira: no session cookie for this host, links not verified";
const WINDOW_SPENT_MISS =
  "Jira: a login window has already been opened by this server and it will not reopen, links not verified. To retry: restart the MCP server";

const liveSecrets = new Set<string>();

/** Session values to mask like tokens. Empty as soon as no session is alive. */
export function sessionSecrets(): string[] {
  return [...liveSecrets];
}

/** True if the `/rest/api/2/myself` response names someone: the only sign that a session is authenticated. */
export function namesUser(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  return [o.displayName, o.name, o.emailAddress].some((v) => typeof v === "string" && v !== "");
}

export function loginTimeoutMs(env: Record<string, string | undefined>): number {
  const seconds = Number(env.JIRA_LOGIN_TIMEOUT_S?.trim() || DEFAULT_LOGIN_TIMEOUT_S);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LOGIN_TIMEOUT_S) * 1000;
}

function isIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
}

/** RFC 6265: without a leading dot, the domain is exact; with one, only a parent domain of two or more labels passes. */
function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.toLowerCase();
  if (!domain.startsWith(".")) return domain === host;
  const parent = domain.slice(1);
  if (isIp(host) || !parent.includes(".")) return false;
  return host === parent || host.endsWith(domain);
}

function pathMatches(cookiePath: string | undefined, urlPath: string): boolean {
  if (!cookiePath || cookiePath === "/") return true;
  const path = urlPath === "" ? "/" : urlPath;
  return path === cookiePath || path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function eligible(cookies: readonly BrowserCookie[], baseUrl: string): BrowserCookie[] {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") return [];
  const nowS = Date.now() / 1000;
  return cookies.filter(
    (c) =>
      domainMatches(c.domain, url.hostname.toLowerCase()) &&
      pathMatches(c.path, url.pathname) &&
      !(typeof c.expires === "number" && c.expires >= 0 && c.expires < nowS) &&
      /^[\x21-\x7e]+$/.test(c.name) &&
      !/[=;]/.test(c.name) &&
      /^[\x20-\x7e]*$/.test(c.value) &&
      !c.value.includes(";"),
  );
}

/** `Cookie` header for this URL: only the cookies of its host, over HTTPS. Empty otherwise. */
export function cookieHeader(cookies: readonly BrowserCookie[], baseUrl: string): string {
  return eligible(cookies, baseUrl)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * One session per host and per provider. It keeps only that host's header, and it limits windows:
 * one per outage. The outage is over only once a Jira read has succeeded with these cookies, otherwise a loop
 * of calls would reopen a window each time round. After a window without success, nothing launches any more.
 */
export class JiraSession {
  private current: { header: string; secrets: string[] } | null = null;
  private pending: Promise<SessionHeader> | null = null;
  private windowSpent = false;
  private blocked: string | null = null;

  constructor(
    private readonly provider: SessionProvider,
    private readonly baseUrl: string,
  ) {}

  acquire(timeoutMs: number): Promise<SessionHeader> {
    if (this.current) return Promise.resolve({ ok: true, ...this.current });
    if (this.blocked) return Promise.resolve({ ok: false, miss: this.blocked });
    this.pending ??= this.open(timeoutMs).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async open(timeoutMs: number): Promise<SessionHeader> {
    const allowWindow = !this.windowSpent;
    const outcome = await this.provider({ baseUrl: this.baseUrl, loginTimeoutMs: timeoutMs, allowWindow });
    if (outcome.windowOpened) this.windowSpent = true;
    const kept = outcome.ok ? eligible(outcome.cookies, this.baseUrl) : [];
    if (kept.length === 0) {
      if (this.windowSpent) this.blocked = WINDOW_SPENT_MISS;
      if (!allowWindow) return { ok: false, miss: WINDOW_SPENT_MISS };
      return { ok: false, miss: outcome.ok ? NO_COOKIE_MISS : outcome.miss };
    }
    const header = kept.map((c) => `${c.name}=${c.value}`).join("; ");
    const secrets = [header, ...kept.map((c) => c.value).filter((v) => v.length >= MIN_SECRET_LENGTH)];
    this.current = { header, secrets };
    for (const s of secrets) liveSecrets.add(s);
    return { ok: true, ...this.current };
  }

  /** A Jira read succeeded with these cookies: the outage is over, the next one gets its window. */
  confirmed(): void {
    this.windowSpent = false;
  }

  /** Forgets the cookies. The next `acquire` redoes the check. */
  drop(): void {
    if (this.current) for (const s of this.current.secrets) liveSecrets.delete(s);
    this.current = null;
  }
}

const sessions = new WeakMap<SessionProvider, Map<string, JiraSession>>();

/** The same session for a provider and a host: the default provider lives as long as the process. */
export function sessionFor(provider: SessionProvider, baseUrl: string): JiraSession {
  let byBase = sessions.get(provider);
  if (!byBase) sessions.set(provider, (byBase = new Map()));
  let session = byBase.get(baseUrl);
  if (!session) byBase.set(baseUrl, (session = new JiraSession(provider, baseUrl)));
  return session;
}
