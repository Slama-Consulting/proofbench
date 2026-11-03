/** HTTP helpers for the tracker clients: read-only, HTTPS, no redirects, capped, rate limited. */

export type FetchFn = typeof fetch;

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Hard cap on requests for one ticket read (1 ticket + 1 comments page + 1 links call + 1 file list). */
export const MAX_REQUESTS_PER_READ = 5;
/** At most 2 requests per second per provider. */
export const MIN_INTERVAL_MS = 500;

export interface ClientOptions {
  /** Reserved for tests: allows http:// to localhost / 127.0.0.1 / [::1]. False by default. */
  allowHttpLocalhost?: boolean;
  timeoutMs?: number;
}

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/** Replaces every secret with `***` in a text meant for a result, an error or a log. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 3) out = out.split(s).join("***");
  }
  return out;
}

/** Waits until the provider may send its next request. */
export type Limiter = (key: string) => Promise<void>;

export function createLimiter(minIntervalMs: number = MIN_INTERVAL_MS): Limiter {
  const next = new Map<string, number>();
  return async (key) => {
    const now = Date.now();
    const at = Math.max(now, next.get(key) ?? 0);
    next.set(key, at + minIntervalMs);
    if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
  };
}

/** Reads the body, stopping as soon as MAX_BODY_BYTES is exceeded (null then). */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Miss phrase for an unexpected HTTP status. Never includes the response body (untrusted). */
export function statusMiss(service: string, status: number, hint?: string): string {
  if (status === 401 || status === 403) return `${service}: access denied (HTTP ${status}), token missing, expired or without read permission`;
  if (status === 404) return `${service}: not found, or not visible with this token (HTTP 404)`;
  if (status === 429) return `${service}: rate limit reached (HTTP 429)${hint ? `; ${hint}` : ""}`;
  if (status >= 300 && status < 400) return `${service}: redirect refused (HTTP ${status})`;
  if (status >= 500) return `${service}: server error (HTTP ${status})`;
  return `${service}: unexpected response (HTTP ${status})`;
}

export type Res = { ok: true; body: unknown; headers: Headers } | { ok: false; miss: string; status?: number };

export interface HttpInit {
  fetchFn: FetchFn;
  limiter: Limiter;
  /** Provider label used in misses and as the rate-limit key. */
  service: string;
  secrets: readonly string[];
  allowHttpLocalhost?: boolean;
  timeoutMs?: number;
  /** Appended to the rate-limit miss (for example: set a token to raise the limit). */
  rateLimitHint?: string;
}

/** One HTTP client per ticket read. Never throws: every failure comes back as `{ ok: false, miss }`. */
export class Http {
  private count = 0;
  constructor(private readonly init: HttpInit) {}

  get(url: string, headers: Record<string, string>): Promise<Res> {
    return this.send("GET", url, headers);
  }

  post(url: string, headers: Record<string, string>, json: unknown): Promise<Res> {
    return this.send("POST", url, { "Content-Type": "application/json", ...headers }, JSON.stringify(json));
  }

  private safeUrl(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return this.init.allowHttpLocalhost === true && u.protocol === "http:" && isLocalHostname(u.hostname);
  }

  private async send(method: "GET" | "POST", url: string, headers: Record<string, string>, body?: string): Promise<Res> {
    const { service, secrets } = this.init;
    if (!this.safeUrl(url)) return { ok: false, miss: `${service}: refused a URL that is not HTTPS` };
    if (this.count >= MAX_REQUESTS_PER_READ) return { ok: false, miss: `${service}: request budget for one read exhausted` };
    this.count += 1;
    await this.init.limiter(service);
    try {
      const res = await this.init.fetchFn(url, {
        method,
        headers: { Accept: "application/json", ...headers },
        ...(body !== undefined ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, miss: statusMiss(service, limited ? 429 : res.status, this.init.rateLimitHint) };
      }
      const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        void res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, miss: `${service}: response too large (over 2 MiB)` };
      }
      const text = await readCapped(res);
      if (text === null) return { ok: false, status: res.status, miss: `${service}: response too large (over 2 MiB)` };
      try {
        return { ok: true, body: JSON.parse(text), headers: res.headers };
      } catch {
        return { ok: false, status: res.status, miss: `${service}: response is not valid JSON` };
      }
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, miss: `${service}: timed out` };
      const cause = String(((e as Error).cause as Error | undefined)?.message ?? "");
      if (/redirect/i.test(cause) || /redirect/i.test(String((e as Error).message))) return { ok: false, miss: `${service}: redirect refused` };
      return { ok: false, miss: `${service}: request failed (${redact(String((e as Error).message), secrets)})` };
    }
  }
}
