/** HTTP helpers shared by the GitLab and Jira clients (read-only, HTTPS, no redirects). */

export type FetchFn = typeof fetch;

export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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

export type HttpOutcome =
  | { ok: true; status: number; body: unknown; headers: Headers }
  | { ok: false; status?: number; error: string; redirected?: true };

/**
 * GET JSON. Never throws. No redirect is followed (`redirect: "error"`), so authentication headers
 * never leave the intended host. A timeout cuts off requests that are too slow.
 */
export async function getJson(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  secrets: readonly string[],
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<HttpOutcome> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: "response too large" };
    }
    const text = await readCapped(res);
    if (text === null) return { ok: false, status: res.status, error: "response too large" };
    let body: unknown;
    if (res.ok) {
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, error: "response is not JSON" };
      }
    }
    return { ok: true, status: res.status, body, headers: res.headers };
  } catch (e) {
    const name = (e as Error).name;
    const msg = name === "TimeoutError" || name === "AbortError" ? "timed out" : redact(String((e as Error).message), secrets);
    // `redirect: "error"` can only be told apart from a network failure by its cause.
    const redirected = /redirect/i.test(String(((e as Error).cause as Error | undefined)?.message));
    return redirected ? { ok: false, error: msg, redirected: true } : { ok: false, error: msg };
  }
}

/** Miss phrase for an unexpected HTTP status: no response body (untrusted). */
export function statusMiss(service: string, status: number): string {
  if (status === 401 || status === 403) return `${service}: access denied (HTTP ${status}), token missing, expired or without read permission`;
  if (status === 429) return `${service}: rate limit reached (HTTP 429)`;
  if (status >= 500) return `${service}: server error (HTTP ${status})`;
  return `${service}: unexpected response (HTTP ${status})`;
}
