import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserProvider, defaultProfileDir, profileHasSession, type BrowserOptions } from "../src/jira-browser.js";

const BASE = "https://jira.corp.example";
const PROBE = `${BASE}/rest/api/2/myself`;
const COOKIES = [{ name: "JSESSIONID", value: "session-value", domain: "jira.corp.example" }];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function profile(withSession: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-profile-"));
  dirs.push(dir);
  if (withSession) {
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(join(dir, "Default", "Network", "Cookies"), "");
  }
  return dir;
}

interface Launch {
  headless: boolean;
  dir: string;
  goto: Array<{ url: string; waitUntil?: string }>;
  closed: boolean;
}

/** Fake Playwright, deliberately poor: filling in a form would find no method on it. */
function fakeChromium(probe: (url: string, launch: Launch, init: { maxRedirects?: number; headers?: Record<string, string> }) => unknown) {
  const launches: Launch[] = [];
  const chromium = {
    launchPersistentContext: async (dir: string, o: { headless: boolean }) => {
      const launch: Launch = { headless: o.headless, dir, goto: [], closed: false };
      launches.push(launch);
      return {
        request: {
          get: async (url: string, init: { maxRedirects?: number; headers?: Record<string, string> }) => {
            const answer = probe(url, launch, init);
            return {
              ok: () => answer !== null,
              json: async () => {
                if (answer === "not json") throw new Error("not JSON");
                return answer;
              },
            };
          },
        },
        newPage: async () => ({
          goto: async (url: string, init: { waitUntil?: string }) => {
            launch.goto.push({ url, waitUntil: init.waitUntil });
          },
        }),
        cookies: async () => COOKIES,
        close: async () => {
          launch.closed = true;
        },
      };
    },
  };
  return { chromium, launches };
}

function make(profileDir: string, chromium: unknown, extra: Partial<BrowserOptions> = {}) {
  const sleeps: number[] = [];
  let clock = 0;
  const provider = createBrowserProvider({
    profileDir,
    importPlaywright: async () => ({ chromium }) as never,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  });
  return { provider, sleeps };
}

const ask = (allowWindow = true, loginTimeoutMs = 10_000) => ({ baseUrl: BASE, loginTimeoutMs, allowWindow });

describe("createBrowserProvider", () => {
  it("profile with a session: no window, check on /myself, cookies returned, context closed", async () => {
    const dir = profile(true);
    const seen: Array<[string, unknown]> = [];
    const { chromium, launches } = fakeChromium((url, _l, init) => {
      seen.push([url, init]);
      return { displayName: "the user" };
    });
    const r = await make(dir, chromium).provider(ask());
    expect(r).toEqual({ ok: true, cookies: COOKIES });
    expect(launches).toMatchObject([{ headless: true, dir, closed: true }]);
    expect(seen[0]?.[0]).toBe(PROBE);
    expect(seen[0]?.[1]).toMatchObject({ headers: { Accept: "application/json" }, maxRedirects: 0 });
  });

  it.each([{ name: "w" }, { emailAddress: "w@x.io" }, { displayName: "W" }])("%j is enough for the check", async (body) => {
    const { chromium } = fakeChromium(() => body);
    expect((await make(profile(true), chromium).provider(ask())).ok).toBe(true);
  });

  it.each([[{}], [[]], [{ error: "x" }], [{ name: "" }], ["not json"], [null]])("%j does not prove the login", async (body) => {
    const { chromium, launches } = fakeChromium(() => body);
    const r = await make(profile(true), chromium).provider(ask(false));
    expect(r.ok).toBe(false);
    expect(launches).toHaveLength(1);
  });

  it("expired session: reopens a window on the Jira home page and probes every 2 s", async () => {
    const dir = profile(true);
    let polls = 0;
    const { chromium, launches } = fakeChromium((_u, l) => (!l.headless && ++polls >= 3 ? { name: "w" } : null));
    const { provider, sleeps } = make(dir, chromium);
    const r = await provider(ask());
    expect(r).toEqual({ ok: true, cookies: COOKIES, windowOpened: true });
    expect(launches.map((l) => l.headless)).toEqual([true, false]);
    expect(launches[1]?.goto).toEqual([{ url: BASE, waitUntil: "domcontentloaded" }]);
    expect(sleeps).toEqual([2000, 2000]);
    expect(launches.every((l) => l.closed)).toBe(true);
  });

  it("blank profile: goes straight to the window", async () => {
    const { chromium, launches } = fakeChromium(() => ({ name: "w" }));
    await make(profile(false), chromium).provider(ask());
    expect(launches.map((l) => l.headless)).toEqual([false]);
  });

  it("timed out: a miss that says to finish and retry, no exception, window closed", async () => {
    const { chromium, launches } = fakeChromium(() => null);
    const { provider, sleeps } = make(profile(false), chromium);
    const r = await provider(ask(true, 6000));
    expect(r).toMatchObject({ ok: false, windowOpened: true });
    expect(!r.ok && r.miss).toMatch(/finish logging in/i);
    expect(!r.ok && r.miss).toMatch(/retry/i);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(6000);
    expect(launches[0]?.closed).toBe(true);
  });

  it("a failing home page does not interrupt the wait", async () => {
    const base = fakeChromium(() => ({ name: "w" }));
    const chromium = {
      launchPersistentContext: async (d: string, o: { headless: boolean }) => {
        const ctx = await base.chromium.launchPersistentContext(d, o);
        return { ...ctx, newPage: async () => ({ goto: async () => { throw new Error("net::ERR_ABORTED"); } }) };
      },
    };
    expect((await make(profile(false), chromium).provider(ask())).ok).toBe(true);
  });

  it("window forbidden: no visible launch", async () => {
    const { chromium, launches } = fakeChromium(() => null);
    const r = await make(profile(true), chromium).provider(ask(false));
    expect(r.ok).toBe(false);
    expect(launches.map((l) => l.headless)).toEqual([true]);
    const virgin = fakeChromium(() => null);
    expect((await make(profile(false), virgin.chromium).provider(ask(false))).ok).toBe(false);
    expect(virgin.launches).toHaveLength(0);
  });

  it("Playwright absent: loading fails as a miss that names the two commands", async () => {
    const provider = createBrowserProvider({
      profileDir: profile(false),
      importPlaywright: async () => {
        throw Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
      },
    });
    const r = await provider(ask());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.miss).toContain("npm install playwright");
    expect(!r.ok && r.miss).toContain("npx playwright install chromium");
    expect(!r.ok && r.miss).not.toContain("Cannot find");
  });

  it("Chromium not installed: the same miss", async () => {
    const chromium = {
      launchPersistentContext: async () => {
        throw new Error("browserType.launchPersistentContext: Executable doesn't exist at C:\\secret\\chrome.exe");
      },
    };
    const r = await make(profile(false), chromium).provider(ask());
    expect(!r.ok && r.miss).toContain("npx playwright install chromium");
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("other launch failure, profile already open for example: a miss without the error text", async () => {
    const chromium = { launchPersistentContext: async () => { throw new Error("profile locked at C:\\Users\\alice"); } };
    const r = await make(profile(true), chromium).provider(ask());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("alice");
  });
});

describe("profile", () => {
  it("lives in ~/.proofbench/chrome-profile", () => {
    expect(defaultProfileDir()).toBe(join(homedir(), ".proofbench", "chrome-profile"));
  });

  it("recognises the locations of the Chromium cookies file", () => {
    expect(profileHasSession(profile(false))).toBe(false);
    expect(profileHasSession(profile(true))).toBe(true);
    for (const parts of [["Default", "Cookies"], ["Cookies"]]) {
      const dir = profile(false);
      mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...parts), "");
      expect(profileHasSession(dir)).toBe(true);
    }
  });
});

describe("lazy loading", () => {
  it("no src file imports playwright statically", () => {
    const src = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(src, { recursive: true, encoding: "utf8" }).filter((x) => x.endsWith(".ts"))) {
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/(from\s+|import\s*\(\s*|import\s+)["']playwright/);
    }
  });

  it("playwright is an optional dependency, pinned to an exact version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.dependencies.playwright).toBeUndefined();
    expect(pkg.optionalDependencies.playwright).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
