import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskCache } from "../src/cache.js";
import { ALLOWED_HOSTS, checkUrl, Http, RateLimiter } from "../src/http.js";
import { fakeFetch, tmpDir } from "./helpers/fake.js";

describe("host allowlist", () => {
  it("accepts exactly the allowlisted hosts over HTTPS", () => {
    for (const h of ALLOWED_HOSTS) expect(checkUrl(`https://${h}/x`)).toHaveProperty("url");
    expect(ALLOWED_HOSTS.size).toBe(10);
    expect(checkUrl("https://REGISTRY.NPMJS.ORG/zod")).toHaveProperty("url");
  });

  it.each([
    ["look-alike suffix", "https://registry.npmjs.org.evil.com/zod"],
    ["look-alike prefix", "https://evil-registry.npmjs.org/zod"],
    ["sub-domain of an allowed host", "https://x.registry.npmjs.org/zod"],
    ["userinfo trick", "https://registry.npmjs.org@evil.com/zod"],
    ["userinfo with credentials", "https://user:pw@registry.npmjs.org/zod"],
    ["userinfo only", "https://user@registry.npmjs.org/zod"],
    ["plain http", "http://registry.npmjs.org/zod"],
    ["other port", "https://registry.npmjs.org:8443/zod"],
    ["trailing dot", "https://registry.npmjs.org./zod"],
    ["backslash trick", "https://evil.com\\@registry.npmjs.org/zod"],
    ["file scheme", "file:///etc/passwd"],
    ["ftp scheme", "ftp://registry.npmjs.org/zod"],
    ["localhost without the test option", "http://localhost:8080/x"],
    ["not a URL", "registry.npmjs.org/zod"],
    ["IP literal", "https://140.82.112.5/x"],
  ])("refuses %s", (_label, url) => {
    expect(checkUrl(url)).toHaveProperty("error");
  });

  it("allows http to localhost only through the test option, and never to look-alikes", () => {
    expect(checkUrl("http://localhost:9/x", true)).toHaveProperty("url");
    expect(checkUrl("http://127.0.0.1:9/x", true)).toHaveProperty("url");
    expect(checkUrl("http://[::1]:9/x", true)).toHaveProperty("url");
    expect(checkUrl("http://localhost.evil.com/x", true)).toHaveProperty("error");
    expect(checkUrl("http://evil.com/x", true)).toHaveProperty("error");
  });
});

describe("Http.get", () => {
  it("refuses a disallowed URL without calling fetch", async () => {
    const f = fakeFetch({});
    const r = await new Http({ fetchFn: f.fn }).get("https://evil.example.com/x");
    expect(r).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a redirect to a host outside the allowlist", async () => {
    const f = fakeFetch({ "https://registry.npmjs.org/a": { status: 302, headers: { location: "https://evil.example.com/steal" } } });
    const r = await new Http({ fetchFn: f.fn }).get("https://registry.npmjs.org/a");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/redirect refused/);
    expect(f.urls()).toEqual(["https://registry.npmjs.org/a"]);
  });

  it("refuses redirects to http, to credentials and to look-alikes", async () => {
    for (const loc of ["http://registry.npmjs.org/b", "https://u:p@registry.npmjs.org/b", "https://registry.npmjs.org.evil.io/b"]) {
      const f = fakeFetch({ "https://registry.npmjs.org/a": { status: 301, headers: { location: loc } } });
      const r = await new Http({ fetchFn: f.fn }).get("https://registry.npmjs.org/a");
      expect(r.ok).toBe(false);
      expect(f.calls).toHaveLength(1);
    }
  });

  it("follows a redirect to another allowlisted host and never lets fetch follow by itself", async () => {
    const f = fakeFetch({
      "https://crates.io/api/v1/crates/x/1.0.0/readme": { status: 302, headers: { location: "https://static.crates.io/readmes/x/x-1.0.0.html" } },
      "https://static.crates.io/readmes/x/x-1.0.0.html": "<p>hi</p>",
    });
    const r = await new Http({ fetchFn: f.fn }).get("https://crates.io/api/v1/crates/x/1.0.0/readme");
    expect(r).toMatchObject({ ok: true, text: "<p>hi</p>" });
    expect(f.calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("stops redirect loops", async () => {
    const f = fakeFetch({ "https://pypi.org/loop": { status: 302, headers: { location: "https://pypi.org/loop" } } });
    const r = await new Http({ fetchFn: f.fn }).get("https://pypi.org/loop");
    expect(r).toMatchObject({ ok: false, error: "too many redirects" });
  });

  it("sends the GitHub token only to api.github.com, in a header", async () => {
    const f = fakeFetch({
      "https://api.github.com/repos/o/r": { status: 302, headers: { location: "https://raw.githubusercontent.com/o/r/main/README.md" } },
      "https://raw.githubusercontent.com/o/r/main/README.md": "x",
      "https://registry.npmjs.org/zod/latest": "{}",
    });
    const http = new Http({ fetchFn: f.fn, githubToken: "ghp_secrettokenvalue0123456789" });
    await http.get("https://registry.npmjs.org/zod/latest");
    await http.get("https://api.github.com/repos/o/r");
    const byHost = (host: string) => f.calls.filter((c) => new URL(c.url).hostname === host);
    expect(byHost("api.github.com")[0]!.headers.Authorization).toBe("Bearer ghp_secrettokenvalue0123456789");
    expect(byHost("raw.githubusercontent.com")[0]!.headers.Authorization).toBeUndefined();
    expect(byHost("registry.npmjs.org")[0]!.headers.Authorization).toBeUndefined();
    expect(f.calls.every((c) => !c.url.includes("ghp_"))).toBe(true);
  });

  it("redacts the token from network errors", async () => {
    const token = "ghp_secrettokenvalue0123456789";
    const fn = (async () => {
      throw new Error(`connect failed with ${token}`);
    }) as unknown as typeof fetch;
    const r = await new Http({ fetchFn: fn, githubToken: token }).get("https://api.github.com/x");
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(token);
  });

  it("rejects a body larger than the cap (declared and streamed)", async () => {
    const big = "x".repeat(3000);
    const f = fakeFetch({
      "https://pypi.org/declared": { status: 200, body: "tiny", headers: { "content-length": "999999999" } },
      "https://pypi.org/streamed": big,
    });
    const http = new Http({ fetchFn: f.fn, maxBytes: 2048 });
    expect(await http.get("https://pypi.org/declared")).toMatchObject({ ok: false, error: "response too large" });
    expect(await http.get("https://pypi.org/streamed")).toMatchObject({ ok: false, error: "response too large" });
    expect(await new Http({ fetchFn: f.fn, maxBytes: 4096 }).get("https://pypi.org/streamed")).toMatchObject({ ok: true });
  });

  it("times out slow servers", async () => {
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const r = await new Http({ fetchFn: fn, timeoutMs: 30 }).get("https://pypi.org/slow");
    expect(r).toEqual({ ok: false, error: "timed out" });
  });

  it("reports invalid JSON and HTTP errors without throwing", async () => {
    const f = fakeFetch({ "https://pypi.org/bad": "<html>", "https://pypi.org/limited": { status: 403, body: "rate limit exceeded details" } });
    const http = new Http({ fetchFn: f.fn });
    expect(await http.getJson("https://pypi.org/bad")).toMatchObject({ ok: false, error: "response is not JSON" });
    const limited = await http.getJson("https://pypi.org/limited");
    expect(limited).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(limited)).not.toContain("details");
    expect(await http.getJson("https://pypi.org/missing")).toMatchObject({ ok: false, status: 404 });
  });

  it("enforces the per-call request budget", async () => {
    const f = fakeFetch({ "https://pypi.org/a": "1", "https://pypi.org/b": "2", "https://pypi.org/c": "3" });
    const http = new Http({ fetchFn: f.fn, maxRequests: 2 });
    expect((await http.get("https://pypi.org/a")).ok).toBe(true);
    expect((await http.get("https://pypi.org/b")).ok).toBe(true);
    expect(await http.get("https://pypi.org/c")).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(2);
  });

  it("spaces out requests to the same host", async () => {
    const limiter = new RateLimiter(40);
    const f = fakeFetch({ "https://pypi.org/a": "1", "https://pypi.org/b": "2" });
    const http = new Http({ fetchFn: f.fn, limiter });
    const t0 = Date.now();
    await http.get("https://pypi.org/a");
    await http.get("https://pypi.org/b");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});

describe("DiskCache", () => {
  it("serves a hit without a second request, and refresh bypasses it", async () => {
    const dir = tmpDir();
    const f = fakeFetch({ "https://pypi.org/a": "hello" });
    const cache = new DiskCache({ dir });
    expect(await new Http({ fetchFn: f.fn, cache }).get("https://pypi.org/a")).toMatchObject({ ok: true, fromCache: false });
    expect(await new Http({ fetchFn: f.fn, cache }).get("https://pypi.org/a")).toMatchObject({ ok: true, text: "hello", fromCache: true });
    expect(f.calls).toHaveLength(1);
    expect(await new Http({ fetchFn: f.fn, cache, refresh: true }).get("https://pypi.org/a")).toMatchObject({ fromCache: false });
    expect(f.calls).toHaveLength(2);
  });

  it("expires entries after the TTL", () => {
    let now = 1_000_000;
    const cache = new DiskCache({ dir: tmpDir(), ttlMs: 24 * 3_600_000, now: () => now });
    cache.set("https://pypi.org/a", 200, "v1");
    now += 23 * 3_600_000;
    expect(cache.get("https://pypi.org/a")?.body).toBe("v1");
    now += 2 * 3_600_000;
    expect(cache.get("https://pypi.org/a")).toBeNull();
  });

  it("evicts the oldest entries first when the size limit is exceeded", () => {
    let now = 1_000_000_000;
    const dir = tmpDir();
    const cache = new DiskCache({ dir, maxBytes: 2500, now: () => now });
    for (const k of ["a", "b", "c"]) {
      cache.set(`https://pypi.org/${k}`, 200, k.repeat(1000));
      now += 1000;
    }
    const total = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(2500);
    expect(cache.get("https://pypi.org/a")).toBeNull();
    expect(cache.get("https://pypi.org/c")).not.toBeNull();
  });

  it("does not cache errors, and writes private files where the OS supports it", async () => {
    const dir = tmpDir();
    const cache = new DiskCache({ dir });
    const f = fakeFetch({ "https://pypi.org/ok": "fine" });
    const http = new Http({ fetchFn: f.fn, cache });
    await http.get("https://pypi.org/missing");
    expect(cache.get("https://pypi.org/missing")).toBeNull();
    await http.get("https://pypi.org/ok");
    const file = readdirSync(dir)[0]!;
    expect(existsSync(join(dir, file))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
  });

  it("ignores a corrupt cache file", () => {
    const dir = tmpDir();
    const cache = new DiskCache({ dir });
    cache.set("https://pypi.org/a", 200, "x");
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, "{ not json");
    expect(cache.get("https://pypi.org/a")).toBeNull();
  });
});

