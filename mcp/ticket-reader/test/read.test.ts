import { describe, expect, it } from "vitest";
import { readTicket } from "../src/read.js";
import { deps, GITHUB_ENV, GITLAB_ENV, JIRA_COOKIE, JIRA_ENV, JIRA_PATH_ENV, SESSION_VALUE, fakeSession, LINEAR_ENV, PARAMS } from "./helpers/fake.js";

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("Jira", () => {
  const issue = {
    key: "PROJ-123",
    fields: {
      summary: "Login fails",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      creator: { displayName: "Ada", emailAddress: "ada@example.com" },
      assignee: { displayName: "Grace" },
      labels: ["auth", "urgent"],
      priority: { name: "High" },
      created: "2026-01-01T10:00:00.000+0000",
      updated: "2026-01-02T10:00:00.000+0000",
      description: adf("Cannot log in\nafter reset"),
      issuelinks: [
        { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "PROJ-200", fields: { summary: "Release" } } },
        { type: { name: "Relates", inward: "relates to", outward: "relates to" }, inwardIssue: { key: "PROJ-7", fields: { summary: "Old" } } },
      ],
      parent: { key: "PROJ-1", fields: { summary: "Epic" } },
      subtasks: [{ key: "PROJ-124", fields: { summary: "Sub" } }],
    },
  };
  const comments = {
    comments: [
      { author: { displayName: "Newest" }, created: "2026-01-04T00:00:00.000+0000", body: adf("third") },
      { author: { displayName: "Mid" }, created: "2026-01-03T00:00:00.000+0000", body: adf("second") },
    ],
  };

  it("normalises a Jira issue (REST v2, session cookie, ADF to text)", async () => {
    const { deps: d, calls } = deps(JIRA_ENV, [
      ["https://jira.example.com/rest/api/2/issue/PROJ-123/comment", { body: comments }],
      ["https://jira.example.com/rest/api/2/issue/PROJ-123", { body: issue }],
    ]);
    const t = await readTicket({ ref: "https://jira.example.com/browse/PROJ-123" }, PARAMS, d);
    expect(t).toMatchObject({
      provider: "jira",
      id: "PROJ-123",
      url: "https://jira.example.com/browse/PROJ-123",
      kind: "bug",
      title: "Login fails",
      status: "In Progress",
      author: "Ada",
      assignees: ["Grace"],
      labels: ["auth", "urgent"],
      priority: "High",
      description: "Cannot log in\nafter reset",
      truncated: false,
      misses: [],
    });
    expect(t.comments.map((c) => c.body)).toEqual(["second", "third"]);
    expect(t.links).toEqual([
      { type: "blocks", id: "PROJ-200", url: "https://jira.example.com/browse/PROJ-200", title: "Release" },
      { type: "relates to", id: "PROJ-7", url: "https://jira.example.com/browse/PROJ-7", title: "Old" },
      { type: "parent", id: "PROJ-1", url: "https://jira.example.com/browse/PROJ-1", title: "Epic" },
      { type: "subtask", id: "PROJ-124", url: "https://jira.example.com/browse/PROJ-124", title: "Sub" },
    ]);
    expect(JSON.stringify(t)).not.toContain("ada@example.com");
    expect(calls).toHaveLength(2);
    const sent = calls[0]?.init?.headers as Record<string, string>;
    expect(sent.Cookie).toBe(JIRA_COOKIE);
    expect(sent.Authorization).toBeUndefined();
    expect(calls[1]?.url).toContain("maxResults=20");
  });

  it("keeps the context path in the API and browse URLs, with plain-text fields", async () => {
    const v2 = { ...issue, fields: { ...issue.fields, description: "wiki *text*" } };
    const { deps: d, calls } = deps(JIRA_PATH_ENV, [
      ["https://jira.example.com/jira/rest/api/2/issue/PROJ-123/comment", { body: { comments: [{ author: { name: "bob" }, created: "2026-01-01", body: "plain" }] } }],
      ["https://jira.example.com/jira/rest/api/2/issue/PROJ-123", { body: v2 }],
    ]);
    const t = await readTicket({ ref: "PROJ-123" }, PARAMS, d);
    expect(t.description).toBe("wiki *text*");
    expect(t.comments[0]).toMatchObject({ author: "bob", body: "plain" });
    expect(t.url).toBe("https://jira.example.com/jira/browse/PROJ-123");
    expect((calls[0]?.init?.headers as Record<string, string>).Cookie).toBe(JIRA_COOKIE);
  });

  it("applies the comment limit and the truncation flags", async () => {
    const many = { comments: Array.from({ length: 5 }, (_, i) => ({ author: { displayName: "u" }, created: `2026-01-0${i + 1}`, body: adf(i === 4 ? "z".repeat(2500) : `c${i}`) })) };
    const { deps: d } = deps(JIRA_ENV, [
      ["https://jira.example.com/rest/api/2/issue/PROJ-123/comment", { body: many }],
      ["https://jira.example.com/rest/api/2/issue/PROJ-123", { body: { ...issue, fields: { ...issue.fields, description: adf("d".repeat(100)) } } }],
    ]);
    const t = await readTicket({ ref: "PROJ-123" }, { commentLimit: 2, descriptionMaxChars: 10 }, d);
    expect(t.description).toBe("d".repeat(10));
    expect(t.truncated).toBe(true);
    expect(t.comments).toHaveLength(2);
    expect(t.comments[0]).toMatchObject({ body: "c3" });
    expect(t.comments[1]?.body).toHaveLength(2000);
    expect(t.comments[1]?.truncated).toBe(true);
    expect(t.comments[0]).not.toHaveProperty("truncated");
  });

  it("commentLimit 0 makes no comments call", async () => {
    const { deps: d, calls } = deps(JIRA_ENV, [["https://jira.example.com/rest/api/2/issue/PROJ-123", { body: issue }]]);
    const t = await readTicket({ ref: "PROJ-123" }, { commentLimit: 0, descriptionMaxChars: 100 }, d);
    expect(t.comments).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a failing comments call is a miss, not an error", async () => {
    const { deps: d } = deps(JIRA_ENV, [
      ["https://jira.example.com/rest/api/2/issue/PROJ-123/comment", { status: 403 }],
      ["https://jira.example.com/rest/api/2/issue/PROJ-123", { body: issue }],
    ]);
    const t = await readTicket({ ref: "PROJ-123" }, PARAMS, d);
    expect(t.comments).toEqual([]);
    expect(t.misses).toEqual(["Jira: access denied (HTTP 403), token missing, expired or without read permission"]);
  });

  it("is not configured without JIRA_BASE_URL and names the variable", async () => {
    const { deps: d, calls } = deps({}, []);
    await expect(readTicket({ ref: "PROJ-1", provider: "jira" }, PARAMS, d)).rejects.toThrow(/JIRA_BASE_URL/);
    expect(calls).toEqual([]);
  });

  it("makes no request when the login gives no session, and says why", async () => {
    const { deps: d, calls } = deps(JIRA_ENV, [], { sessionProvider: async () => ({ ok: false, miss: "Jira: login not completed within 120 s" }) });
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, d)).rejects.toThrow(/login not completed/);
    expect(calls).toEqual([]);
  });

  it("drops the session on a 401 and asks to log in again", async () => {
    let logins = 0;
    const provider = async () => {
      logins += 1;
      return fakeSession()({ baseUrl: "https://jira.example.com", loginTimeoutMs: 1, allowWindow: true });
    };
    const { deps: d } = deps(JIRA_ENV, [["https://jira.example.com/rest/api/2/issue/PROJ-1", { status: 401 }]], { sessionProvider: provider });
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, d)).rejects.toThrow(/session missing or expired/);
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, d)).rejects.toThrow(/session missing or expired/);
    expect(logins).toBe(2);
  });

  it("treats a redirect to the SSO page as an expired session", async () => {
    const { deps: d } = deps(JIRA_ENV, [["https://jira.example.com/rest/api/2/issue/PROJ-1", () => new Error("redirect")]]);
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, d)).rejects.toThrow(/session missing or expired/);
  });

  it("does not use a cookie that belongs to another host", async () => {
    const { deps: d, calls } = deps(JIRA_ENV, [], { sessionProvider: fakeSession("other.example.com") });
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, d)).rejects.toThrow(/no session cookie/);
    expect(calls).toEqual([]);
  });

  it("refuses a Jira URL on another host before any request", async () => {
    const { deps: d, calls } = deps(JIRA_ENV, []);
    await expect(readTicket({ ref: "https://jira.example.com.evil.example/browse/PROJ-1" }, PARAMS, d)).rejects.toThrow(/not a configured tracker host/);
    expect(calls).toEqual([]);
  });

  it("refuses a plain-http base URL", async () => {
    const { deps: d } = deps({ ...JIRA_ENV, JIRA_BASE_URL: "http://jira.example.com" }, []);
    await expect(readTicket({ ref: "PROJ-1", provider: "jira" }, PARAMS, d)).rejects.toThrow(/HTTPS/);
  });
});

describe("GitHub", () => {
  const api = "https://api.github.com/repos/octo/repo";
  const issue = {
    number: 42,
    title: "Crash on start",
    state: "open",
    html_url: "https://github.com/octo/repo/issues/42",
    user: { login: "ada" },
    assignees: [{ login: "grace" }],
    labels: [{ name: "bug" }, "plain"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    body: "Steps to reproduce",
    comments: 2,
  };

  it("reads an issue without a token and with the right headers", async () => {
    const { deps: d, calls } = deps({}, [
      [`${api}/issues/42/comments?per_page=100&page=1`, { body: [{ user: { login: "u1" }, created_at: "2026-01-01T01:00:00Z", body: "first" }, { user: { login: "u2" }, created_at: "2026-01-01T02:00:00Z", body: "second" }] }],
      [`${api}/issues/42`, { body: issue }],
    ]);
    const t = await readTicket({ ref: "octo/repo#42" }, PARAMS, d);
    expect(t).toMatchObject({ provider: "github", id: "octo/repo#42", kind: "issue", status: "open", author: "ada", assignees: ["grace"], labels: ["bug", "plain"], misses: [] });
    expect(t.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(t).not.toHaveProperty("change");
    const h = calls[0]?.init?.headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(h["User-Agent"]).toBe("proofbench-ticket-reader");
  });

  it("reads a pull request: branches, files, no diff", async () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 2, patch: "SECRET DIFF" }));
    const { deps: d, calls } = deps(GITHUB_ENV, [
      [`${api}/pulls/7/files?per_page=50`, { body: files }],
      [`${api}/pulls/7`, { body: { state: "open", merged: false, draft: true, base: { ref: "main" }, head: { ref: "feature/x" }, changed_files: 80, additions: 100, deletions: 40 } }],
      [`${api}/issues/7`, { body: { ...issue, number: 7, comments: 0, pull_request: { url: "x" }, html_url: "https://github.com/octo/repo/pull/7" } }],
    ]);
    const t = await readTicket({ ref: "https://github.com/octo/repo/pull/7" }, PARAMS, d);
    expect(t.kind).toBe("pull_request");
    expect(t.change).toMatchObject({ state: "open", merged: false, draft: true, baseBranch: "main", headBranch: "feature/x", changedFiles: 80, filesTruncated: true });
    expect(t.change?.files).toHaveLength(50);
    expect(t.change?.files[0]).toEqual({ path: "src/f0.ts", status: "modified", additions: 1, deletions: 2 });
    expect(JSON.stringify(t)).not.toContain("SECRET DIFF");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secret_token_value");
  });

  it("a merged PR reached through an /issues/ URL has status merged", async () => {
    const { deps: d } = deps({}, [
      [`${api}/pulls/7/files`, { body: [] }],
      [`${api}/pulls/7`, { body: { state: "closed", merged: true, base: { ref: "main" }, head: { ref: "x" }, changed_files: 0 } }],
      [`${api}/issues/7`, { body: { ...issue, number: 7, state: "closed", comments: 0, pull_request: {} } }],
    ]);
    const t = await readTicket({ ref: "https://github.com/octo/repo/issues/7" }, PARAMS, d);
    expect(t).toMatchObject({ kind: "pull_request", status: "merged" });
    expect(t.change?.merged).toBe(true);
  });

  it("reads the last page of comments for a busy issue and says so", async () => {
    const { deps: d, calls } = deps({}, [
      [`${api}/issues/42/comments?per_page=100&page=3`, { body: [{ user: { login: "u" }, created_at: "2026-02-01T00:00:00Z", body: "late" }] }],
      [`${api}/issues/42`, { body: { ...issue, comments: 250 } }],
    ]);
    const t = await readTicket({ ref: "octo/repo#42" }, PARAMS, d);
    expect(calls[1]?.url).toContain("page=3");
    expect(t.comments).toHaveLength(1);
    expect(t.misses[0]).toMatch(/older comments were not fetched/);
  });

  it("an anonymous rate limit mentions GITHUB_TOKEN", async () => {
    const { deps: d } = deps({}, [["https://api.github.com/", { status: 403, headers: { "x-ratelimit-remaining": "0" } }]]);
    await expect(readTicket({ ref: "octo/repo#42" }, PARAMS, d)).rejects.toThrow(/rate limit reached.*GITHUB_TOKEN/);
  });

  it("a rate-limited comments call is a miss", async () => {
    const { deps: d } = deps(GITHUB_ENV, [
      [`${api}/issues/42/comments`, { status: 429 }],
      [`${api}/issues/42`, { body: issue }],
    ]);
    const t = await readTicket({ ref: "octo/repo#42" }, PARAMS, d);
    expect(t.misses).toEqual(["GitHub: rate limit reached (HTTP 429)"]);
  });
});

describe("GitLab", () => {
  const root = "https://gitlab.example.com/api/v4/projects/group%2Fproject";
  const issue = {
    iid: 7,
    title: "Slow query",
    state: "opened",
    web_url: "https://gitlab.example.com/group/project/-/issues/7",
    author: { username: "ada" },
    assignees: [{ username: "grace" }],
    labels: ["perf"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    description: "EXPLAIN shows a seq scan",
    issue_type: "issue",
  };

  it("reads an issue: notes without system notes, related issues", async () => {
    const { deps: d, calls } = deps(GITLAB_ENV, [
      [`${root}/issues/7/notes`, { body: [{ system: false, author: { username: "u2" }, created_at: "2026-01-03T00:00:00Z", body: "newer" }, { system: true, author: { username: "bot" }, created_at: "2026-01-02T12:00:00Z", body: "changed the description" }, { system: false, author: { username: "u1" }, created_at: "2026-01-02T00:00:00Z", body: "older" }] }],
      [`${root}/issues/7/links`, { body: [{ iid: 9, title: "Index", web_url: "https://gitlab.example.com/group/other/-/issues/9", link_type: "blocks", references: { full: "group/other#9" } }] }],
      [`${root}/issues/7`, { body: issue }],
    ]);
    const t = await readTicket({ ref: "https://gitlab.example.com/group/project/-/issues/7" }, PARAMS, d);
    expect(t).toMatchObject({ provider: "gitlab", id: "group/project#7", kind: "issue", status: "opened", author: "ada", assignees: ["grace"], labels: ["perf"], misses: [] });
    expect(t.comments.map((c) => c.body)).toEqual(["older", "newer"]);
    expect(t.links).toEqual([{ type: "blocks", id: "group/other#9", url: "https://gitlab.example.com/group/other/-/issues/9", title: "Index" }]);
    expect((calls[0]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-secret-token-value");
    expect(calls).toHaveLength(3);
  });

  it("reads a merge request: branches, files, closing issues", async () => {
    const { deps: d } = deps(GITLAB_ENV, [
      [`${root}/merge_requests/3/notes`, { body: [] }],
      [`${root}/merge_requests/3/closes_issues`, { body: [{ iid: 7, title: "Slow query", web_url: "https://gitlab.example.com/group/project/-/issues/7", references: { full: "group/project#7" } }] }],
      [`${root}/merge_requests/3/diffs`, { body: [{ new_path: "a.ts", old_path: "a.ts", diff: "SECRET DIFF" }, { new_path: "b.ts", new_file: true }, { old_path: "c.ts", new_path: "c.ts", deleted_file: true }] }],
      [`${root}/merge_requests/3`, { body: { ...issue, iid: 3, state: "merged", draft: false, source_branch: "feat", target_branch: "main", changes_count: "3", web_url: "https://gitlab.example.com/group/project/-/merge_requests/3" } }],
    ]);
    const t = await readTicket({ ref: "group/project!3" }, PARAMS, d);
    expect(t).toMatchObject({ id: "group/project!3", kind: "merge_request", status: "merged" });
    expect(t.change).toMatchObject({ merged: true, baseBranch: "main", headBranch: "feat", changedFiles: 3, filesTruncated: false });
    expect(t.change?.files.map((f) => [f.path, f.status])).toEqual([["a.ts", "modified"], ["b.ts", "added"], ["c.ts", "deleted"]]);
    expect(t.links[0]).toMatchObject({ type: "closes", id: "group/project#7" });
    expect(JSON.stringify(t)).not.toContain("SECRET DIFF");
  });

  it("refuses a URL on gitlab.com when GITLAB_HOST is another host, and needs a token", async () => {
    const { deps: d, calls } = deps(GITLAB_ENV, []);
    await expect(readTicket({ ref: "https://gitlab.com/group/project/-/issues/7" }, PARAMS, d)).rejects.toThrow(/not a configured tracker host/);
    const none = deps({ GITLAB_HOST: "gitlab.example.com" }, []);
    await expect(readTicket({ ref: "group/project#7", provider: "gitlab" }, PARAMS, none.deps)).rejects.toThrow(/GITLAB_TOKEN/);
    expect(calls).toEqual([]);
  });

  it("rejects a GITLAB_HOST that carries a scheme or port", async () => {
    for (const host of ["https://gitlab.example.com", "gitlab.example.com:8443", "gitlab.example.com/x"]) {
      const { deps: d } = deps({ GITLAB_TOKEN: "glpat-secret-token-value", GITLAB_HOST: host }, []);
      await expect(readTicket({ ref: "g/p#1", provider: "gitlab" }, PARAMS, d)).rejects.toThrow(/GITLAB_HOST/);
    }
  });

  it("defaults to gitlab.com", async () => {
    const { deps: d, calls } = deps({ GITLAB_TOKEN: "glpat-secret-token-value" }, [["https://gitlab.com/api/v4/projects/g%2Fp/issues/1", { body: issue }]]);
    await readTicket({ ref: "https://gitlab.com/g/p/-/issues/1" }, { commentLimit: 0, descriptionMaxChars: 10 }, d);
    expect(calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/g%2Fp/issues/1");
  });
});

describe("Linear", () => {
  const issue = {
    identifier: "ENG-12",
    title: "Add retry",
    url: "https://linear.app/acme/issue/ENG-12/add-retry",
    description: "Retry with backoff",
    priority: 2,
    priorityLabel: "High",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    state: { name: "Todo" },
    creator: { name: "Ada Lovelace" },
    assignee: { name: "Grace Hopper" },
    labels: { nodes: [{ name: "backend" }] },
    comments: { nodes: [{ body: "newer", createdAt: "2026-01-03T00:00:00Z", user: { name: "B" } }, { body: "older", createdAt: "2026-01-02T00:00:00Z", user: { name: "A" } }] },
    parent: { identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1", title: "Epic" },
    children: { nodes: [{ identifier: "ENG-13", url: "https://linear.app/acme/issue/ENG-13", title: "Child" }] },
    relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-20", url: "https://linear.app/acme/issue/ENG-20", title: "Ship" } }] },
    attachments: { nodes: [{ url: "https://github.com/octo/repo/pull/3", title: "Fix", sourceType: "github" }] },
  };

  it("reads an issue with one read-only GraphQL query", async () => {
    const { deps: d, calls } = deps(LINEAR_ENV, [["https://api.linear.app/graphql", { body: { data: { issue } } }]]);
    const t = await readTicket({ ref: "https://linear.app/acme/issue/ENG-12/add-retry" }, PARAMS, d);
    expect(t).toMatchObject({ provider: "linear", id: "ENG-12", kind: "issue", title: "Add retry", status: "Todo", author: "Ada Lovelace", assignees: ["Grace Hopper"], labels: ["backend"], priority: "High", misses: [] });
    expect(t.comments.map((c) => c.body)).toEqual(["older", "newer"]);
    expect(t.links.map((l) => [l.type, l.id])).toEqual([["parent", "ENG-1"], ["subtask", "ENG-13"], ["blocks", "ENG-20"], ["attachment:github", "https://github.com/octo/repo/pull/3"]]);
    expect(calls).toHaveLength(1);
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("lin_api_secret_key");
    const sent = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
    expect(sent.variables.id).toBe("ENG-12");
    expect(sent.query.trimStart().startsWith("query")).toBe(true);
    expect(sent.query).not.toMatch(/mutation/i);
  });

  it("a key needs provider linear when Jira is also configured", async () => {
    const { deps: d } = deps({ ...JIRA_ENV, ...LINEAR_ENV }, [["https://api.linear.app/graphql", { body: { data: { issue } } }]]);
    await expect(readTicket({ ref: "ENG-12" }, PARAMS, d)).rejects.toThrow(/ambiguous/);
    expect((await readTicket({ ref: "ENG-12", provider: "linear" }, PARAMS, d)).provider).toBe("linear");
  });

  it("an unknown issue and a rejected query are errors; no key is not configured", async () => {
    const nf = deps(LINEAR_ENV, [["https://api.linear.app/graphql", { body: { data: { issue: null }, errors: [{ message: "Entity not found: Issue" }] } }]]);
    await expect(readTicket({ ref: "ENG-12", provider: "linear" }, PARAMS, nf.deps)).rejects.toThrow(/not found/);
    const bad = deps(LINEAR_ENV, [["https://api.linear.app/graphql", { body: { errors: [{ message: "Syntax Error lin_api_secret_key" }] } }]]);
    await expect(readTicket({ ref: "ENG-12", provider: "linear" }, PARAMS, bad.deps)).rejects.toThrow(/rejected/);
    const none = deps({}, []);
    await expect(readTicket({ ref: "ENG-12", provider: "linear" }, PARAMS, none.deps)).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe("failure modes on the main request", () => {
  const cases: Array<[string, Parameters<typeof deps>[1][number][1], RegExp]> = [
    ["401", { status: 401 }, /session missing or expired/],
    ["403", { status: 403 }, /access denied \(HTTP 403\)/],
    ["404", { status: 404 }, /not found/],
    ["429", { status: 429 }, /rate limit reached/],
    ["500", { status: 500 }, /server error/],
    ["invalid JSON", { raw: "<html>" }, /not valid JSON/],
    ["oversized", { raw: "x".repeat(2 * 1024 * 1024 + 5) }, /too large/],
    ["network error carrying the session cookie", new Error(`down ${SESSION_VALUE}`), /request failed \(down \*\*\*\)/],
    ["redirect to the SSO page", { status: 302, headers: { location: "https://evil.example/" } }, /session missing or expired/],
  ];
  it.each(cases)("%s", async (_name, reply, re) => {
    const { deps: d } = deps(JIRA_ENV, [["https://jira.example.com/", reply]]);
    const err = await readTicket({ ref: "PROJ-1" }, PARAMS, d).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(re);
    expect(err?.message).not.toContain(SESSION_VALUE);
  });

  it("times out", async () => {
    const fetchFn = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const { deps: d } = deps(JIRA_ENV, []);
    await expect(readTicket({ ref: "PROJ-1" }, PARAMS, { ...d, fetchFn, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
