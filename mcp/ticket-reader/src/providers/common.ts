import type { Http, Res } from "../http.js";
import { truncate } from "../text.js";
import { COMMENT_MAX_CHARS, type ReadParams, type TicketComment } from "../types.js";

export interface ProviderCtx {
  http: Http;
  params: ReadParams;
}

export interface RawComment {
  author: string | null;
  createdAt: string | null;
  body: string;
}

/** The main request of a read: a failure aborts the read with the miss as message. */
export function must(res: Res): { body: unknown; headers: Headers } {
  if (!res.ok) throw new Error(res.miss);
  return res;
}

/** The most recent `limit` comments, oldest first, each body cut at the per-comment limit. */
export function toComments(raw: RawComment[], limit: number): TicketComment[] {
  const sorted = raw
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.createdAt ?? "").localeCompare(b.c.createdAt ?? "") || a.i - b.i)
    .map((x) => x.c);
  return sorted.slice(Math.max(0, sorted.length - limit)).map((c) => {
    const t = truncate(c.body, COMMENT_MAX_CHARS);
    return { author: c.author, createdAt: c.createdAt, body: t.text, ...(t.truncated ? { truncated: true as const } : {}) };
  });
}

export function encode(segment: string): string {
  return encodeURIComponent(segment);
}
