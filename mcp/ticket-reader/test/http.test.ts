import { describe, expect, it } from "vitest";
import { createLimiter, Http, MAX_BODY_BYTES, MAX_REQUESTS_PER_READ, redact } from "../src/http.js";
import { fakeFetch, type Handler } from "./helpers/fake.js";

function client(h: Handler, opts: { timeoutMs?: number; allowHttpLocalhost?: boolean; hint?: string } = {}) {
  const f = fakeFetch([
    ["https://", h],
    ["http://", h],
  ]);
  const http = new Http({
    fetchFn: f.fetchFn,
    limiter: createLimiter(0),
    service: "Svc",
    secrets: ["sekret-token"],
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.allowHttpLocalhost ? { allowHttpLocalhost: true } : {}),
    ...(opts.hint ? { rateLimitHint: opts.hint } : {}),
  });
  return { http, calls: f.calls };
}

describe("Http", () => {
  it("returns parsed JSON and never follows redirects", async () => {
    const { http, calls } = client({ body: { a: 1 } });
    const r = await http.get("https://api.example.com/x", { Authorization: "Bearer sekret-token" });
    expect(r).toMatchObject({ ok: true, body: { a: 1 } });
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it.each([
    [401, /access denied \(HTTP 401\)/],
    [403, /access denied \(HTTP 403\)/],
    [404, /not found, or not visible with this token \(HTTP 404\)/],
    [429, /rate limit reached \(HTTP 429\); set a token/],
    [500, /server error \(HTTP 500\)/],
    [302, /redirect refused \(HTTP 302\)/],
    [418, /unexpected response \(HTTP 418\)/],
  ])("status %i becomes a miss", async (status, re) => {
    const { http } = client({ status, raw: "body with sekret-token inside" }, { hint: "set a token" });
    const r = await http.get("https://api.example.com/x", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.miss).toMatch(re);
      expect(r.miss).not.toContain("sekret-token");
      expect(r.miss).not.toContain("body with");
    }
  });

  it("a 403 with an exhausted quota is a rate limit", async () => {
    const { http } = client({ status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const r = await http.get("https://api.example.com/x", {});
    expect(r.ok === false && r.miss).toMatch(/rate limit reached/);
  });

  it("times out on a request that never answers", async () => {
    const fetchFn = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const http = new Http({ fetchFn, limiter: createLimiter(0), service: "Svc", secrets: [], timeoutMs: 20 });
    const r = await http.get("https://api.example.com/x", {});
    expect(r.ok === false && r.miss).toBe("Svc: timed out");
  });

  it("refuses an oversized body, declared or streamed", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 10);
    const a = await client({ raw: big }).http.get("https://api.example.com/x", {});
    expect(a.ok === false && a.miss).toMatch(/too large/);
    const b = await client({ raw: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } }).http.get("https://api.example.com/x", {});
    expect(b.ok === false && b.miss).toMatch(/too large/);
  });

  it("invalid JSON is a miss", async () => {
    const r = await client({ raw: "<html>login</html>" }).http.get("https://api.example.com/x", {});
    expect(r.ok === false && r.miss).toBe("Svc: response is not valid JSON");
  });

  it("a network error is redacted", async () => {
    const r = await client(new Error("connect failed with sekret-token")).http.get("https://api.example.com/x", {});
    expect(r.ok === false && r.miss).toBe("Svc: request failed (connect failed with ***)");
  });

  it("refuses plain http unless the test option allows localhost", async () => {
    expect((await client({}).http.get("http://api.example.com/x", {})).ok).toBe(false);
    expect((await client({}).http.get("http://localhost/x", {})).ok).toBe(false);
    expect((await client({}, { allowHttpLocalhost: true }).http.get("http://localhost/x", {})).ok).toBe(true);
    expect((await client({}, { allowHttpLocalhost: true }).http.get("http://evil.example/x", {})).ok).toBe(false);
    expect((await client({}).http.get("https://user:pw@api.example.com/x", {})).ok).toBe(false);
  });

  it("caps the requests of one read", async () => {
    const { http, calls } = client({});
    for (let i = 0; i < MAX_REQUESTS_PER_READ; i++) expect((await http.get("https://api.example.com/x", {})).ok).toBe(true);
    const r = await http.get("https://api.example.com/x", {});
    expect(r.ok === false && r.miss).toMatch(/budget/);
    expect(calls).toHaveLength(MAX_REQUESTS_PER_READ);
  });

  it("the limiter spaces requests of one provider", async () => {
    const limit = createLimiter(60);
    const t0 = Date.now();
    await limit("a");
    await limit("a");
    await limit("b");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe("redact", () => {
  it("masks every secret and ignores tiny ones", () => {
    expect(redact("a tok-123 b tok-123", ["tok-123"])).toBe("a *** b ***");
    expect(redact("ab", ["ab"])).toBe("ab");
  });
});
