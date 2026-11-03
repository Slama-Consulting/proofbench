import { describe, expect, it } from "vitest";
import { GitLabClient } from "../src/gitlab.js";

interface Call { url: string; init: RequestInit | undefined }

function mock(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("no more mocked responses");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? []), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const SHA = "f".repeat(40);
const raw = (iid: number, extra: Record<string, unknown> = {}) => ({
  iid, title: `MR ${iid}`, description: null, source_branch: "feature/PROJ-1-x", merged_at: "2026-01-01T00:00:00Z",
  merge_commit_sha: "a".repeat(40), squash_commit_sha: null, state: "merged",
  web_url: `https://gitlab.example.com/a/b/-/merge_requests/${iid}`, ...extra,
});

describe("GitLabClient.mrsForCommit", () => {
  it("parses the response and encodes the project", async () => {
    const { fetchFn, calls } = mock([{ body: [raw(7)] }]);
    const c = new GitLabClient("gitlab.example.com", "tok", fetchFn);
    const mrs = await c.mrsForCommit("a/b", SHA);
    expect(calls[0].url).toContain(`https://gitlab.example.com/api/v4/projects/a%2Fb/repository/commits/${SHA}/merge_requests`);
    expect(mrs).toHaveLength(1);
    expect(mrs[0]).toMatchObject({ iid: 7, title: "MR 7", description: "", sourceBranch: "feature/PROJ-1-x", state: "merged", mergeCommitSha: "a".repeat(40) });
    expect(mrs[0].squashCommitSha).toBeUndefined();
    expect((calls[0].init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("tok");
    expect(calls[0].init?.redirect).toBe("error");
  });

  it("401 goes into misses, with no exception or token", async () => {
    const { fetchFn } = mock([{ status: 401, body: { message: "401 Unauthorized tok-secret" } }]);
    const c = new GitLabClient("gitlab.example.com", "tok-secret", fetchFn);
    expect(await c.mrsForCommit("a/b", SHA)).toEqual([]);
    expect(c.misses).toHaveLength(1);
    expect(c.misses[0]).toContain("401");
    expect(JSON.stringify(c.misses)).not.toContain("tok-secret");
  });

  it("404 on the first page: no MR and a project missing or inaccessible miss", async () => {
    const { fetchFn } = mock([{ status: 404 }]);
    const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
    expect(await c.mrsForCommit("a/b", SHA)).toEqual([]);
    expect(c.misses).toHaveLength(1);
    expect(c.misses[0]).toMatch(/missing or inaccessible/);
  });

  it("rejects a response that is too large: content-length, then an endless stream", async () => {
    const big = (async () => new Response("[]", { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } })) as typeof fetch;
    const c = new GitLabClient("gitlab.example.com", "t", big);
    expect(await c.mrsForCommit("a/b", SHA)).toEqual([]);
    expect(c.misses[0]).toMatch(/too large/);

    let pulled = 0;
    const stream = (async () =>
      new Response(
        new ReadableStream({
          pull(ctrl) {
            pulled += 1024 * 1024;
            ctrl.enqueue(new Uint8Array(1024 * 1024).fill(65));
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const d = new GitLabClient("gitlab.example.com", "t", stream);
    expect(await d.mrsForCommit("a/b", SHA)).toEqual([]);
    expect(d.misses[0]).toMatch(/too large/);
    expect(pulled).toBeLessThan(20 * 1024 * 1024);
  });

  it("429 and 5xx go into misses", async () => {
    for (const status of [429, 503]) {
      const { fetchFn } = mock([{ status }]);
      const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
      expect(await c.mrsForCommit("a/b", SHA)).toEqual([]);
      expect(c.misses[0]).toContain(String(status));
    }
  });

  it("a network error goes into misses, without leaking the token", async () => {
    const { fetchFn } = mock([new Error("boom tok-secret")]);
    const c = new GitLabClient("gitlab.example.com", "tok-secret", fetchFn);
    expect(await c.mrsForCommit("a/b", SHA)).toEqual([]);
    expect(c.misses).toHaveLength(1);
    expect(JSON.stringify(c.misses)).not.toContain("tok-secret");
  });

  it("follows pagination by x-next-page, never by a supplied URL", async () => {
    const { fetchFn, calls } = mock([
      { body: [raw(1)], headers: { "x-next-page": "2", link: '<https://evil.example/x>; rel="next"' } },
      { body: [raw(2)], headers: { "x-next-page": "" } },
    ]);
    const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
    const mrs = await c.mrsForCommit("a/b", SHA);
    expect(mrs.map((m) => m.iid)).toEqual([1, 2]);
    expect(calls[1].url).toContain("page=2");
    expect(calls.every((x) => x.url.startsWith("https://gitlab.example.com/"))).toBe(true);
  });

  it("caps pagination and says so in misses", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ body: [raw(i + 1)], headers: { "x-next-page": String(i + 2) } }));
    const { fetchFn, calls } = mock(pages);
    const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
    const mrs = await c.mrsForCommit("a/b", SHA);
    expect(calls.length).toBeLessThan(20);
    expect(mrs.length).toBe(calls.length);
    expect(c.misses.some((m) => m.includes("cap of"))).toBe(true);
  });

  it("rejects http and a dubious host", () => {
    expect(() => new GitLabClient("http://gitlab.example.com", "t")).toThrow();
    expect(() => new GitLabClient("gitlab.example.com/evil", "t")).toThrow();
    expect(() => new GitLabClient("user@gitlab.example.com", "t")).toThrow();
    expect(() => new GitLabClient("-oProxy", "t")).toThrow();
  });

  it("http localhost only with the test option; otherwise no call", async () => {
    const a = mock([{ body: [] }]);
    const c = new GitLabClient("localhost:8080", "t", a.fetchFn, { allowHttpLocalhost: true });
    await c.mrsForCommit("a/b", SHA);
    expect(a.calls[0].url.startsWith("http://localhost:8080/")).toBe(true);

    const b = mock([{ body: [] }]);
    const d = new GitLabClient("localhost:8080", "t", b.fetchFn);
    await d.mrsForCommit("a/b", SHA);
    expect(b.calls).toHaveLength(0);
    expect(d.misses).toHaveLength(1);
  });

  it("does not use web_url of another host", async () => {
    const { fetchFn } = mock([{ body: [raw(3, { web_url: "https://evil.example/x" })] }]);
    const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
    const [mr] = await c.mrsForCommit("a/b", SHA);
    expect(mr.url).toBe("https://gitlab.example.com/a/b/-/merge_requests/3");
  });
});

describe("GitLabClient.openMrs", () => {
  it("filters state=opened and encodes the search", async () => {
    const { fetchFn, calls } = mock([{ body: [raw(9, { state: "opened", merged_at: null, merge_commit_sha: null })] }]);
    const c = new GitLabClient("gitlab.example.com", "t", fetchFn);
    const mrs = await c.openMrs("a/b", "fix & co");
    expect(calls[0].url).toContain("state=opened");
    expect(calls[0].url).toContain("search=fix%20%26%20co");
    expect(mrs[0].mergedAt).toBeUndefined();
  });
});
