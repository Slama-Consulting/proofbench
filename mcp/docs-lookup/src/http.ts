import { DiskCache } from "./cache.js";

export type FetchFn = typeof fetch;

/** Exact hostnames, no wildcard and no suffix match. Anything else is refused, wherever the URL came from. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "registry.npmjs.org",
  "pypi.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "repo1.maven.org",
  "dl.google.com",
  "plugins.gradle.org",
  "api.github.com",
  "raw.githubusercontent.com",
]);

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REQUESTS_PER_CALL = 30;
const MAX_REDIRECTS = 3;
const USER_AGENT = "docs-lookup/0.1.0";

export interface HttpOptions {
  fetchFn?: FetchFn;
  /** Reserved for tests: allows http:// to localhost / 127.0.0.1 / [::1]. False by default. */
  allowHttpLocalhost?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRequests?: number;
  /** Optional GitHub token. Sent only to api.github.com, only in a header. */
  githubToken?: string;
  cache?: DiskCache;
  /** Bypass the cache for reads (the fresh response is still stored). */
  refresh?: boolean;
  limiter?: RateLimiter;
}

export type HttpResult =
  | { ok: true; status: number; text: string; fromCache: boolean }
  | { ok: false; status?: number; error: string };

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/**
 * Returns the parsed URL if it may be fetched, otherwise a refusal message.
 * Refused: non-HTTPS, credentials in the URL, a non-default port, any host not exactly on the allowlist.
 */
export function checkUrl(raw: string, allowHttpLocalhost = false): { url: URL } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: "invalid URL" };
  }
  if (u.username || u.password) return { error: "URL with credentials refused" };
  if (allowHttpLocalhost && isLocalHostname(u.hostname) && (u.protocol === "http:" || u.protocol === "https:")) return { url: u };
  if (u.protocol !== "https:") return { error: "only HTTPS is allowed" };
  if (u.port) return { error: "non-default port refused" };
  if (!ALLOWED_HOSTS.has(u.hostname)) return { error: `host not on the allowlist: ${u.hostname}` };
  return { url: u };
}

/** Per-host minimum interval between two real requests. */
export class RateLimiter {
  private readonly last = new Map<string, number>();
  constructor(private readonly minIntervalMs = 100) {}
  async wait(host: string): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, (this.last.get(host) ?? 0) + this.minIntervalMs);
    this.last.set(host, slot);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

/** Reads the body, stopping as soon as the cap is exceeded (null then). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class Http {
  private requests = 0;
  private readonly fetchFn: FetchFn;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: HttpOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.limiter = opts.limiter ?? new RateLimiter(0);
  }

  get requestCount(): number {
    return this.requests;
  }

  private redact(text: string): string {
    const t = this.opts.githubToken;
    return t && t.length >= 3 ? text.split(t).join("***") : text;
  }

  /** GET with cache, allowlist, manual (re-validated) redirects, size cap and timeout. Never throws. */
  async get(rawUrl: string, accept = "*/*"): Promise<HttpResult> {
    const first = checkUrl(rawUrl, this.opts.allowHttpLocalhost);
    if ("error" in first) return { ok: false, error: first.error };
    const cache = this.opts.cache;
    if (cache && !this.opts.refresh) {
      const hit = cache.get(first.url.href);
      if (hit) return { ok: true, status: hit.status, text: hit.body, fromCache: true };
    }
    let current = first.url;
    const maxBytes = this.opts.maxBytes ?? MAX_BODY_BYTES;
    const budget = this.opts.maxRequests ?? MAX_REQUESTS_PER_CALL;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (this.requests >= budget) return { ok: false, error: `request budget exhausted (${budget} per call)` };
      this.requests++;
      await this.limiter.wait(current.hostname);
      const headers: Record<string, string> = { Accept: accept, "User-Agent": USER_AGENT };
      if (this.opts.githubToken && current.hostname === "api.github.com" && current.protocol === "https:") {
        headers.Authorization = `Bearer ${this.opts.githubToken}`;
      }
      try {
        const res = await this.fetchFn(current.href, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
        if (res.status >= 300 && res.status < 400) {
          void res.body?.cancel().catch(() => undefined);
          const loc = res.headers.get("location");
          if (!loc) return { ok: false, status: res.status, error: "redirect without Location" };
          let target: string;
          try {
            target = new URL(loc, current).href;
          } catch {
            return { ok: false, status: res.status, error: "invalid redirect target" };
          }
          const next = checkUrl(target, this.opts.allowHttpLocalhost);
          if ("error" in next) return { ok: false, status: res.status, error: `redirect refused: ${next.error}` };
          current = next.url;
          continue;
        }
        const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
        if (Number.isFinite(declared) && declared > maxBytes) {
          void res.body?.cancel().catch(() => undefined);
          return { ok: false, status: res.status, error: "response too large" };
        }
        const text = await readCapped(res, maxBytes);
        if (text === null) return { ok: false, status: res.status, error: "response too large" };
        if (!res.ok) return { ok: false, status: res.status, error: statusMessage(res.status) };
        cache?.set(first.url.href, res.status, text);
        return { ok: true, status: res.status, text, fromCache: false };
      } catch (e) {
        const name = (e as Error).name;
        const msg = name === "TimeoutError" || name === "AbortError" ? "timed out" : this.redact(String((e as Error).message));
        return { ok: false, error: msg };
      }
    }
    return { ok: false, error: "too many redirects" };
  }

  /** GET and parse JSON. A body that is not JSON is an error, never an exception. */
  async getJson<T = unknown>(url: string): Promise<{ ok: true; data: T } | { ok: false; status?: number; error: string }> {
    const r = await this.get(url, "application/json");
    if (!r.ok) return r;
    try {
      return { ok: true, data: JSON.parse(r.text) as T };
    } catch {
      return { ok: false, status: r.status, error: "response is not JSON" };
    }
  }
}

export function statusMessage(status: number): string {
  if (status === 404) return "not found (HTTP 404)";
  if (status === 401 || status === 403) return `access denied or rate limited (HTTP ${status})`;
  if (status === 429) return "rate limit reached (HTTP 429)";
  if (status >= 500) return `server error (HTTP ${status})`;
  return `unexpected response (HTTP ${status})`;
}
