import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { namesUser, type BrowserCookie, type SessionOutcome, type SessionProvider } from "./jira-session.js";

const POLL_MS = 2000;
const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_MISS =
  "Jira: browser unavailable, links not verified. Install with `npm install playwright` then `npx playwright install chromium`";
const LAUNCH_MISS = "Jira: the browser did not start (profile already open?), links not verified";
const NO_WINDOW_MISS = "Jira: session missing or expired, links not verified";

/** The only Playwright surface used: nothing to read a page or fill in a field. */
interface ProbeResponse {
  ok(): boolean;
  json(): Promise<unknown>;
}
interface Context {
  request: { get(url: string, init: { headers: Record<string, string>; timeout: number; maxRedirects: number }): Promise<ProbeResponse> };
  newPage(): Promise<{ goto(url: string, init: { waitUntil: "domcontentloaded" }): Promise<unknown> }>;
  cookies(url?: string): Promise<BrowserCookie[]>;
  close(): Promise<void>;
}
export interface PlaywrightModule {
  chromium: { launchPersistentContext(dir: string, init: { headless: boolean }): Promise<Context> };
}

export interface BrowserOptions {
  profileDir?: string;
  importPlaywright?: () => Promise<PlaywrightModule>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function defaultProfileDir(): string {
  return join(homedir(), ".proofbench", "chrome-profile");
}

/** Recent path first, then older ones: Chromium moved its cookies file. */
export function profileHasSession(dir: string): boolean {
  return [["Default", "Network", "Cookies"], ["Default", "Cookies"], ["Cookies"]].some((parts) => existsSync(join(dir, ...parts)));
}

/** Specifier held in a variable: neither the build nor the server load depends on this optional package. */
async function loadPlaywright(): Promise<PlaywrightModule> {
  const name = "playwright";
  return (await import(name)) as PlaywrightModule;
}

/** Authenticated only if Jira names someone. Goes through the API: the page where the user logs in stays untouched. */
async function isAuthenticated(context: Context, probeUrl: string): Promise<boolean> {
  try {
    const res = await context.request.get(probeUrl, {
      headers: { Accept: "application/json" },
      timeout: PROBE_TIMEOUT_MS,
      maxRedirects: 0,
    });
    return res.ok() && namesUser(await res.json());
  } catch {
    return false;
  }
}

function launchMiss(e: unknown): string {
  // The error text is not returned: it may quote local paths.
  return /Executable doesn't exist|playwright install/i.test(String((e as Error)?.message)) ? INSTALL_MISS : LAUNCH_MISS;
}

/**
 * Default provider: persistent Chromium profile. Headless if the profile has already been used, otherwise a visible
 * window where the user logs in on their own (SSO, MFA). Nothing is typed or read in the page: the server probes the API and
 * waits. Any failure becomes a miss, without the error text.
 */
export function createBrowserProvider(options: BrowserOptions = {}): SessionProvider {
  const profileDir = options.profileDir ?? defaultProfileDir();
  const importPlaywright = options.importPlaywright ?? loadPlaywright;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  return async ({ baseUrl, loginTimeoutMs, allowWindow }): Promise<SessionOutcome> => {
    let chromium: PlaywrightModule["chromium"];
    try {
      ({ chromium } = await importPlaywright());
    } catch {
      return { ok: false, miss: INSTALL_MISS };
    }
    const probeUrl = `${baseUrl}/rest/api/2/myself`;

    try {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      if (profileHasSession(profileDir)) {
        const context = await chromium.launchPersistentContext(profileDir, { headless: true });
        try {
          if (await isAuthenticated(context, probeUrl)) return { ok: true, cookies: await context.cookies(baseUrl) };
        } finally {
          await context.close();
        }
      }
      if (!allowWindow) return { ok: false, miss: NO_WINDOW_MISS };

      const context = await chromium.launchPersistentContext(profileDir, { headless: false });
      try {
        try {
          const page = await context.newPage();
          await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        } catch {
          // An interrupted SSO redirect does not close the window: the user can continue.
        }
        const deadline = now() + loginTimeoutMs;
        for (;;) {
          if (await isAuthenticated(context, probeUrl)) {
            return { ok: true, cookies: await context.cookies(baseUrl), windowOpened: true };
          }
          const left = deadline - now();
          if (left <= 0) break;
          await sleep(Math.min(POLL_MS, left));
        }
      } finally {
        await context.close();
      }
      const seconds = Math.round(loginTimeoutMs / 1000);
      return {
        ok: false,
        windowOpened: true,
        miss: `Jira: login not completed within ${seconds} s, links not verified. Finish logging in and retry: restarting the MCP server reopens the window`,
      };
    } catch (e) {
      return { ok: false, miss: launchMiss(e) };
    }
  };
}

export const browserSessionProvider: SessionProvider = createBrowserProvider();
