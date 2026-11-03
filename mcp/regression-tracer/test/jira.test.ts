import { describe, expect, it } from "vitest";
import { JiraClient } from "../src/jira.js";

function mock(r: { status?: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("JiraClient", () => {
  it("reads summary and status", async () => {
    const { fetchFn, calls } = mock({ body: { key: "PROJ-1", fields: { summary: "Login", status: { name: "Done" } } } });
    const c = new JiraClient("https://acme.atlassian.net/", "me@x.io", "tok", fetchFn);
    expect(await c.getIssue("PROJ-1")).toEqual({ key: "PROJ-1", summary: "Login", status: "Done" });
    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-1?fields=summary,status");
    expect(calls[0].init?.redirect).toBe("error");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("me@x.io:tok").toString("base64"),
    );
  });

  it("404 gives null without a miss", async () => {
    const c = new JiraClient("https://acme.atlassian.net", "e", "t", mock({ status: 404 }).fetchFn);
    expect(await c.getIssue("PROJ-1")).toBeNull();
    expect(c.misses).toEqual([]);
  });

  it("401, 429, 5xx and network errors go into misses without the token", async () => {
    for (const r of [{ status: 401 }, { status: 429 }, { status: 500 }, new Error("boom tok-secret")]) {
      const c = new JiraClient("https://acme.atlassian.net", "e", "tok-secret", mock(r).fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(c.misses).toHaveLength(1);
      expect(JSON.stringify(c.misses)).not.toContain("tok-secret");
    }
  });

  it("rejects an invalid key without a network call", async () => {
    const { fetchFn, calls } = mock({});
    const c = new JiraClient("https://acme.atlassian.net", "e", "t", fetchFn);
    expect(await c.getIssue("../../admin")).toBeNull();
    expect(await c.getIssue("proj-1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("rejects http, credentials in the URL and an invalid URL", () => {
    expect(() => new JiraClient("http://acme.atlassian.net", "e", "t")).toThrow();
    expect(() => new JiraClient("https://u:p@acme.atlassian.net", "e", "t")).toThrow();
    expect(() => new JiraClient("not a url", "e", "t")).toThrow();
    expect(() => new JiraClient("http://localhost:9000", "e", "t", undefined, { allowHttpLocalhost: true })).not.toThrow();
  });
});
