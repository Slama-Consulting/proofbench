import { describe, expect, it } from "vitest";
import { knownSecrets } from "../src/fix.js";
import { getJson } from "../src/http.js";
import { JiraBrowserClient } from "../src/jira.js";
import {
  cookieHeader,
  loginTimeoutMs,
  sessionFor,
  type BrowserCookie,
  type SessionOutcome,
  type SessionProvider,
  type SessionRequest,
} from "../src/jira-session.js";

const BASE = "https://jira.corp.example";
const SECRET = "session-value-secret";
const live: BrowserCookie[] = [{ name: "JSESSIONID", value: SECRET, domain: "jira.corp.example", path: "/" }];

function provider(...outcomes: SessionOutcome[]) {
  const calls: SessionRequest[] = [];
  const fn: SessionProvider = async (req) => {
    calls.push(req);
    return outcomes[Math.min(calls.length - 1, outcomes.length - 1)] ?? { ok: true, cookies: live };
  };
  return { fn, calls };
}

type Reply = { status?: number; body?: unknown } | Error;

function mock(...replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const r = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push({ url: String(url), init });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const issue = { body: { fields: { summary: "Login", status: { name: "Done" } } } };
const header = (c: { init: RequestInit | undefined }) => c.init?.headers as Record<string, string>;
const refused = () => new TypeError("fetch failed", { cause: new Error("unexpected redirect") });

describe("cookieHeader", () => {
  const c = (domain: string, extra: Partial<BrowserCookie> = {}): BrowserCookie => ({ name: "n", value: "v", domain, ...extra });

  it("keeps the exact domain and the dotted parent domain, like a browser", () => {
    expect(cookieHeader([c("jira.corp.example")], BASE)).toBe("n=v");
    expect(cookieHeader([c(".corp.example")], BASE)).toBe("n=v");
    expect(cookieHeader([c(".jira.corp.example")], BASE)).toBe("n=v");
  });

  it("never sends a cookie from another domain", () => {
    for (const d of ["idp.example", "other.corp.example", "corp.example", "ira.corp.example", ".ira.corp.example", "sub.jira.corp.example", ".example", ""]) {
      expect(cookieHeader([c(d)], BASE), d).toBe("");
    }
  });

  it("domain case does not matter, nor does the URL port", () => {
    expect(cookieHeader([c("JIRA.corp.example")], "https://jira.corp.example:8443")).toBe("n=v");
  });

  it("an IP address matches only itself", () => {
    expect(cookieHeader([c("10.0.0.1")], "https://10.0.0.1")).toBe("n=v");
    expect(cookieHeader([c(".0.0.1")], "https://10.0.0.1")).toBe("");
  });

  it("respects the cookie path and its expiry", () => {
    expect(cookieHeader([c("jira.corp.example", { path: "/jira" })], `${BASE}/jira`)).toBe("n=v");
    expect(cookieHeader([c("jira.corp.example", { path: "/other" })], `${BASE}/jira`)).toBe("");
    expect(cookieHeader([c("jira.corp.example", { path: "/ji" })], `${BASE}/jira`)).toBe("");
    expect(cookieHeader([c("jira.corp.example", { expires: 1 })], BASE)).toBe("");
    expect(cookieHeader([c("jira.corp.example", { expires: -1 })], BASE)).toBe("n=v");
  });

  it("drops a name or value that would break the header", () => {
    expect(cookieHeader([c("jira.corp.example", { value: "a\r\nX: y" })], BASE)).toBe("");
    expect(cookieHeader([c("jira.corp.example", { value: "a;b" })], BASE)).toBe("");
    expect(cookieHeader([c("jira.corp.example", { name: "a=b" })], BASE)).toBe("");
  });

  it("rejects anything that is not HTTPS", () => {
    expect(cookieHeader([c("jira.corp.example")], "http://jira.corp.example")).toBe("");
  });
});

describe("loginTimeoutMs", () => {
  it("120 s by default, JIRA_LOGIN_TIMEOUT_S otherwise", () => {
    expect(loginTimeoutMs({})).toBe(120_000);
    expect(loginTimeoutMs({ JIRA_LOGIN_TIMEOUT_S: "30" })).toBe(30_000);
    for (const bad of ["", "abc", "0", "-5", "Infinity"]) expect(loginTimeoutMs({ JIRA_LOGIN_TIMEOUT_S: bad }), bad).toBe(120_000);
  });
});

describe("sessionFor", () => {
  it("opens only one session for simultaneous requests", async () => {
    const p = provider({ ok: true, cookies: live });
    const s = sessionFor(p.fn, BASE);
    const [a, b] = await Promise.all([s.acquire(1000), s.acquire(1000)]);
    expect(a.ok && b.ok).toBe(true);
    expect(p.calls).toHaveLength(1);
    await s.acquire(1000);
    expect(p.calls).toHaveLength(1);
    s.drop();
  });

  it("a window without success does not reopen in this process, and the provider is no longer called", async () => {
    const p = provider({ ok: false, miss: "timeout", windowOpened: true });
    const s = sessionFor(p.fn, BASE);
    expect(await s.acquire(1000)).toMatchObject({ ok: false, miss: "timeout" });
    expect(p.calls[0]?.allowWindow).toBe(true);
    for (let i = 0; i < 5; i++) expect((await s.acquire(1000)).ok).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  it("a failure without a window, Playwright absent for example, leaves the window possible afterwards", async () => {
    const p = provider({ ok: false, miss: "absent" }, { ok: true, cookies: live, windowOpened: true });
    const s = sessionFor(p.fn, BASE);
    expect((await s.acquire(1000)).ok).toBe(false);
    expect((await s.acquire(1000)).ok).toBe(true);
    expect(p.calls.map((c) => c.allowWindow)).toEqual([true, true]);
    s.drop();
  });

  it("a successful window never confirmed by Jira forbids a second window", async () => {
    const p = provider({ ok: true, cookies: live, windowOpened: true }, { ok: false, miss: "not logged in" });
    const s = sessionFor(p.fn, BASE);
    await s.acquire(1000);
    s.drop();
    expect((await s.acquire(1000)).ok).toBe(false);
    expect(p.calls.map((c) => c.allowWindow)).toEqual([true, false]);
  });

  it("a session confirmed by Jira makes the window possible for the next outage", async () => {
    const p = provider({ ok: true, cookies: live, windowOpened: true });
    const s = sessionFor(p.fn, BASE);
    await s.acquire(1000);
    s.confirmed();
    s.drop();
    await s.acquire(1000);
    expect(p.calls.map((c) => c.allowWindow)).toEqual([true, true]);
    s.drop();
  });

  it("no cookie for this host: a miss, no request possible", async () => {
    const p = provider({ ok: true, cookies: [{ name: "n", value: "v", domain: "idp.example" }] });
    const s = sessionFor(p.fn, BASE);
    const r = await s.acquire(1000);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("idp.example");
  });

  it("two providers do not share their state", () => {
    expect(sessionFor(provider().fn, BASE)).not.toBe(sessionFor(provider().fn, BASE));
  });
});

describe("session secrets", () => {
  it("masked like tokens while the session lives, then forgotten", async () => {
    const s = sessionFor(provider({ ok: true, cookies: live }).fn, BASE);
    await s.acquire(1000);
    expect(knownSecrets()).toContain(SECRET);
    s.drop();
    expect(knownSecrets()).not.toContain(SECRET);
  });

  it("a short value does not mask the whole result", async () => {
    const cookies: BrowserCookie[] = [...live, { name: "flag", value: "true", domain: "jira.corp.example" }];
    const s = sessionFor(provider({ ok: true, cookies }).fn, BASE);
    await s.acquire(1000);
    expect(knownSecrets()).not.toContain("true");
    s.drop();
  });

  it("a cookie from another domain is not kept in memory", async () => {
    const foreign = "cookie-of-the-sso-provider";
    const cookies: BrowserCookie[] = [...live, { name: "idp", value: foreign, domain: "idp.example" }];
    const s = sessionFor(provider({ ok: true, cookies }).fn, BASE);
    const r = await s.acquire(1000);
    expect(JSON.stringify(r)).not.toContain(foreign);
    expect(knownSecrets()).not.toContain(foreign);
    s.drop();
  });
});

describe("JiraBrowserClient", () => {
  const client = (p: SessionProvider, fetchFn: typeof fetch) => new JiraBrowserClient(BASE, p, 1000, fetchFn);

  it("reads over REST v2 with the cookie, without Authorization, without following redirects", async () => {
    const m = mock(issue);
    const c = client(provider({ ok: true, cookies: live }).fn, m.fetchFn);
    expect(await c.getIssue("PROJ-1")).toEqual({ key: "PROJ-1", summary: "Login", status: "Done" });
    expect(m.calls[0]?.url).toBe(`${BASE}/rest/api/2/issue/PROJ-1?fields=summary,status`);
    expect(header(m.calls[0]!).Cookie).toBe(`JSESSIONID=${SECRET}`);
    expect(header(m.calls[0]!).Authorization).toBeUndefined();
    expect(m.calls[0]?.init?.redirect).toBe("error");
    expect(c.browseUrl("PROJ-1")).toBe(`${BASE}/browse/PROJ-1`);
  });

  it("sends only the host's cookies", async () => {
    const m = mock(issue);
    const cookies: BrowserCookie[] = [...live, { name: "idp", value: "cookie-sso-external", domain: "idp.example" }];
    await client(provider({ ok: true, cookies }).fn, m.fetchFn).getIssue("PROJ-1");
    expect(header(m.calls[0]!).Cookie).toBe(`JSESSIONID=${SECRET}`);
  });

  it("invalid key: neither session nor network", async () => {
    const p = provider();
    const m = mock(issue);
    expect(await client(p.fn, m.fetchFn).getIssue("../admin")).toBeNull();
    expect(p.calls).toHaveLength(0);
    expect(m.calls).toHaveLength(0);
  });

  it("rejects http, even with the local option, and credentials in the URL", () => {
    const p = provider().fn;
    expect(() => new JiraBrowserClient("http://jira.corp.example", p, 1000)).toThrow();
    expect(() => new JiraBrowserClient("http://localhost:9000", p, 1000, undefined, { allowHttpLocalhost: true })).toThrow();
    expect(() => new JiraBrowserClient("https://u:p@jira.corp.example", p, 1000)).toThrow();
  });

  /** Answers according to the URL: the `/myself` check and the ticket read do not share their sequence of answers. */
  function routed(issueReplies: Reply[], myself: Reply[]) {
    const calls: string[] = [];
    let i = 0;
    let p = 0;
    const answer = (r: Reply) => {
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    };
    const fetchFn = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/rest/api/2/myself")) return answer(myself[Math.min(p++, myself.length - 1)]!);
      return answer(issueReplies[Math.min(i++, issueReplies.length - 1)]!);
    }) as typeof fetch;
    return { fetchFn, calls, probes: () => calls.filter((c) => c.endsWith("/myself")).length };
  }
  const named: Reply = { body: { displayName: "the user" } };

  describe("ambiguous 404 and 403", () => {
    it("404, /myself 401: session rejected, one re-read, then a miss", async () => {
      const p = provider({ ok: true, cookies: live });
      const m = routed([{ status: 404 }], [{ status: 401 }]);
      const c = client(p.fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(c.misses).toHaveLength(1);
      expect(c.misses[0]).toMatch(/session/i);
      expect(p.calls).toHaveLength(2);
      expect(m.probes()).toBe(1);
      expect(m.calls.filter((u) => u.includes("/issue/"))).toHaveLength(2);
    });

    it("404, /myself 401, session restored: the ticket is read", async () => {
      const m = routed([{ status: 404 }, issue], [{ status: 401 }]);
      const c = client(provider({ ok: true, cookies: live }).fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toMatchObject({ summary: "Login" });
      expect(c.misses).toEqual([]);
    });

    it("404, /myself names someone: real 404, no miss, session kept, no provider", async () => {
      const p = provider({ ok: true, cookies: live });
      const m = routed([{ status: 404 }], [named]);
      const c = client(p.fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(await c.getIssue("PROJ-2")).toBeNull();
      expect(c.misses).toEqual([]);
      expect(p.calls).toHaveLength(1);
      expect(m.probes()).toBe(1);
    });

    it.each<[string, Reply]>([
      ["response without a name", { body: {} }],
      ["redirect", refused()],
      ["403", { status: 403 }],
    ])("404, /myself %s: not authenticated", async (_name, reply) => {
      const m = routed([{ status: 404 }], [reply]);
      const c = client(provider({ ok: true, cookies: live }).fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(c.misses).toHaveLength(1);
    });

    it("404, /myself down: a miss, neither a real 404 nor an abandoned session", async () => {
      const p = provider({ ok: true, cookies: live });
      const m = routed([{ status: 404 }], [{ status: 500 }]);
      const c = client(p.fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(c.misses).toHaveLength(1);
      expect(p.calls).toHaveLength(1);
    });

    it("403, /myself names someone: permission denied, clean miss, session kept", async () => {
      const p = provider({ ok: true, cookies: live });
      const m = routed([{ status: 403 }], [named]);
      const c = client(p.fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toBeNull();
      expect(c.misses).toHaveLength(1);
      expect(c.misses[0]).toMatch(/permission/i);
      expect(c.misses[0]).not.toMatch(/session/i);
      expect(p.calls).toHaveLength(1);
      expect(m.calls.filter((u) => u.includes("/issue/"))).toHaveLength(1);
    });

    it("403, /myself 401: session rejected, one re-read", async () => {
      const p = provider({ ok: true, cookies: live });
      const m = routed([{ status: 403 }, issue], [{ status: 401 }]);
      const c = client(p.fn, m.fetchFn);
      expect(await c.getIssue("PROJ-1")).toMatchObject({ summary: "Login" });
      expect(p.calls).toHaveLength(2);
    });

    it("the check goes to the Jira host, with the cookie, and appears in no miss", async () => {
      const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
      const fetchFn = (async (url: string | URL, init?: RequestInit) => {
        seen.push({ url: String(url), init });
        if (String(url).endsWith("/myself")) throw new Error(`boom ${SECRET}`);
        return new Response("{}", { status: 404 });
      }) as typeof fetch;
      const c = client(provider({ ok: true, cookies: live }).fn, fetchFn);
      await c.getIssue("PROJ-1");
      expect(seen[1]?.url).toBe(`${BASE}/rest/api/2/myself`);
      expect(header(seen[1]!).Cookie).toBe(`JSESSIONID=${SECRET}`);
      expect(seen[1]?.init?.redirect).toBe("error");
      expect(JSON.stringify(c.misses)).not.toContain(SECRET);
    });
  });

  it.each<[string, Reply]>([
    ["401", { status: 401 }],
    ["redirect", refused()],
  ])("%s: abandons the session once, redoes the check, re-reads", async (_name, first) => {
    const p = provider({ ok: true, cookies: live });
    const m = mock(first, issue);
    const c = client(p.fn, m.fetchFn);
    expect(await c.getIssue("PROJ-1")).toMatchObject({ summary: "Login" });
    expect(p.calls).toHaveLength(2);
    expect(m.calls).toHaveLength(2);
    expect(c.misses).toEqual([]);
  });

  it.each<[string, Reply]>([
    ["401", { status: 401 }],
    ["redirect", refused()],
  ])("%s again: a miss, no loop or sequence of checks", async (_name, reply) => {
    const p = provider({ ok: true, cookies: live });
    const m = mock(reply);
    const c = client(p.fn, m.fetchFn);
    expect(await c.getIssue("PROJ-1")).toBeNull();
    expect(await c.getIssue("PROJ-2")).toBeNull();
    expect(p.calls).toHaveLength(2);
    expect(m.calls).toHaveLength(3);
    expect(c.misses).toHaveLength(2);
    expect(JSON.stringify(c.misses)).not.toContain(SECRET);
  });

  it("a network outage is not a session rejection", async () => {
    const p = provider({ ok: true, cookies: live });
    const m = mock(new Error("connection dropped"));
    const c = client(p.fn, m.fetchFn);
    expect(await c.getIssue("PROJ-1")).toBeNull();
    expect(p.calls).toHaveLength(1);
    expect(m.calls).toHaveLength(1);
    expect(c.misses).toHaveLength(1);
  });

  it("a session miss repeats on each ticket without calling the provider again", async () => {
    const p = provider({ ok: false, miss: "Jira: absent" });
    const m = mock(issue);
    const c = client(p.fn, m.fetchFn);
    expect(await c.getIssue("PROJ-1")).toBeNull();
    expect(await c.getIssue("PROJ-2")).toBeNull();
    expect(c.misses).toEqual(["Jira: absent", "Jira: absent"]);
    expect(p.calls).toHaveLength(1);
    expect(m.calls).toHaveLength(0);
  });

  it("neither errors nor Jira texts carry a cookie", async () => {
    const failing = client(provider({ ok: true, cookies: live }).fn, mock(new Error(`boom Cookie: JSESSIONID=${SECRET}`)).fetchFn);
    await failing.getIssue("PROJ-1");
    expect(JSON.stringify(failing.misses)).not.toContain(SECRET);

    const body = { fields: { summary: `echo ${SECRET}`, status: { name: `status ${SECRET}` } } };
    const echoed = await client(provider({ ok: true, cookies: live }).fn, mock({ body }).fetchFn).getIssue("PROJ-1");
    expect(JSON.stringify(echoed)).not.toContain(SECRET);
  });
});

describe("getJson, redirect refused", () => {
  it("tells it apart from a network outage without changing the error message", async () => {
    const r = await getJson(mock(refused()).fetchFn, `${BASE}/x`, {}, []);
    expect(r).toEqual({ ok: false, error: "fetch failed", redirected: true });
    const other = await getJson(mock(new TypeError("fetch failed", { cause: new Error("ECONNRESET") })).fetchFn, `${BASE}/x`, {}, []);
    expect(other).toEqual({ ok: false, error: "fetch failed" });
  });
});
