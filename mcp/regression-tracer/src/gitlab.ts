import { execFile } from "node:child_process";
import { findOnPath } from "./git.js";
import { getJson, isLocalHostname, statusMiss, type ClientOptions, type FetchFn } from "./http.js";

export interface MrInfo {
  iid: number;
  title: string;
  description: string;
  sourceBranch: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  squashCommitSha?: string;
  state: string;
  url: string;
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
const PER_PAGE = 100;
/** Pages read at most per request: beyond that, the cap is reported in `misses`. */
export const MAX_PAGES = 5;

function hostname(host: string): string {
  return host.replace(/:\d+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Read-only GitLab client. The token is sent only to `host`, supplied by the caller (the repository's remote
 * or `gitlabHost` from the user config): never inferred from commit, MR or log text.
 * Failures do not throw: they accumulate in `misses` (which never contain the token).
 */
export class GitLabClient {
  readonly misses: string[] = [];
  private readonly base: string | null;

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly opts: ClientOptions = {},
  ) {
    if (!HOST_RE.test(host)) throw new Error("Invalid GitLab host (bare host name expected, no scheme or path)");
    if (isLocalHostname(hostname(host))) {
      this.base = opts.allowHttpLocalhost ? `http://${host}` : null;
    } else {
      this.base = `https://${host}`;
    }
  }

  private async pages(path: string, query: string): Promise<unknown[]> {
    if (!this.base) {
      this.misses.push("GitLab: local host refused (HTTPS required)");
      return [];
    }
    const out: unknown[] = [];
    let page = 1;
    for (;;) {
      const url = `${this.base}/api/v4${path}?${query}${query ? "&" : ""}per_page=${PER_PAGE}&page=${page}`;
      const r = await getJson(this.fetchFn, url, { "PRIVATE-TOKEN": this.token }, [this.token], this.opts.timeoutMs);
      if (!r.ok) {
        this.misses.push(`GitLab: request failed (${r.error})`);
        return out;
      }
      if (r.status === 404) {
        if (page === 1) this.misses.push("GitLab: project or commit missing or inaccessible (HTTP 404)");
        return out;
      }
      if (r.status < 200 || r.status >= 300 || !Array.isArray(r.body)) {
        this.misses.push(statusMiss("GitLab", r.status));
        return out;
      }
      out.push(...r.body);
      const next = Number.parseInt(r.headers.get("x-next-page") ?? "", 10);
      if (!Number.isInteger(next) || next !== page + 1) return out;
      if (page >= MAX_PAGES) {
        this.misses.push(`GitLab: cap of ${MAX_PAGES} pages reached, results incomplete`);
        return out;
      }
      page = next;
    }
  }

  private toMr(project: string, raw: unknown): MrInfo | null {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.iid !== "number" || !Number.isSafeInteger(o.iid)) return null;
    const own = `${this.base}/`;
    const webUrl = typeof o.web_url === "string" && o.web_url.startsWith(own) ? o.web_url : null;
    return {
      iid: o.iid,
      title: typeof o.title === "string" ? o.title : "",
      description: typeof o.description === "string" ? o.description : "",
      sourceBranch: typeof o.source_branch === "string" ? o.source_branch : "",
      mergedAt: str(o.merged_at),
      mergeCommitSha: str(o.merge_commit_sha),
      squashCommitSha: str(o.squash_commit_sha),
      state: typeof o.state === "string" ? o.state : "",
      url: webUrl ?? `${this.base}/${project}/-/merge_requests/${o.iid}`,
    };
  }

  private async mrs(project: string, path: string, query: string): Promise<MrInfo[]> {
    const raws = await this.pages(path, query);
    return raws.map((r) => this.toMr(project, r)).filter((m): m is MrInfo => m !== null);
  }

  /** MRs that contain the commit. 404: none. */
  mrsForCommit(project: string, sha: string): Promise<MrInfo[]> {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
      this.misses.push("GitLab: invalid sha, MR search skipped");
      return Promise.resolve([]);
    }
    const p = encodeURIComponent(project);
    return this.mrs(project, `/projects/${p}/repository/commits/${sha}/merge_requests`, "");
  }

  /** Open MRs of the project, filtered by an optional search text. */
  openMrs(project: string, search?: string): Promise<MrInfo[]> {
    const p = encodeURIComponent(project);
    const q = `state=opened${search ? `&search=${encodeURIComponent(search)}` : ""}`;
    return this.mrs(project, `/projects/${p}/merge_requests`, q);
  }
}

const GLAB_TIMEOUT_MS = 5_000;

/**
 * Fallback: reads the token stored by glab for `host`. Command: `glab config get token --host <host>`.
 * WARNING: not verified on a real installation (glab is absent from this machine). The docs for
 * `glab config get` document `--host` but do not list `token` as a key; recent versions may
 * store the token in the system keychain, in which case the output is empty and the fallback fails as a miss.
 * execFile without a shell, executable resolved in the absolute directories of PATH (never the cwd), timeout.
 * Returns null if glab is absent, fails or returns nothing. The token is never logged.
 */
export function glabToken(host: string): Promise<string | null> {
  if (!HOST_RE.test(host)) return Promise.resolve(null);
  const exe = findOnPath("glab", process.env.GLAB_PATH);
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      exe,
      ["config", "get", "token", "--host", host],
      { timeout: GLAB_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout) => {
        const token = stdout.trim();
        resolve(error || !token || /[\s\0]/.test(token) ? null : token);
      },
    );
  });
}
