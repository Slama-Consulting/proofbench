import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../../src/http.js";

export type Route = string | object | { status: number; body?: string | object; headers?: Record<string, string> } | (() => Response);

export interface FakeFetch {
  fn: FetchFn;
  calls: { url: string; headers: Record<string, string>; redirect?: string | undefined }[];
  urls(): string[];
}

function isSpec(r: Route): r is { status: number; body?: string | object; headers?: Record<string, string> } {
  return typeof r === "object" && r !== null && "status" in r && typeof (r as { status: unknown }).status === "number";
}

/** A fake `fetch`: exact-URL routes, everything else is a 404. No real network is ever touched. */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) }, redirect: init?.redirect });
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404 });
    if (typeof r === "function") return r();
    if (typeof r === "string") return new Response(r, { status: 200 });
    if (isSpec(r)) {
      const body = typeof r.body === "object" ? JSON.stringify(r.body) : (r.body ?? "");
      return new Response(body, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });
    }
    return new Response(JSON.stringify(r), { status: 200 });
  }) as FetchFn;
  return { fn, calls, urls: () => calls.map((c) => c.url) };
}

export function tmpDir(prefix = "docs-lookup-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Git tree response for api.github.com. */
export function tree(entries: { path: string; type?: "blob" | "tree"; sha?: string; size?: number }[], truncated = false): object {
  return {
    sha: "a".repeat(40),
    truncated,
    tree: entries.map((e, i) => ({ path: e.path, type: e.type ?? "blob", sha: e.sha ?? String(i).padStart(40, "0"), size: e.size ?? 100 })),
  };
}
