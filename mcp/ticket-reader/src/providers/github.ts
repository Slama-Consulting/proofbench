import type { GithubConfig } from "../config.js";
import type { ParsedRef } from "../refs.js";
import { arr, num, rec, str, truncate } from "../text.js";
import { FILE_LIST_MAX, type Change, type ChangeFile, type Ticket } from "../types.js";
import { encode, must, toComments, type ProviderCtx, type RawComment } from "./common.js";

export const GITHUB_API = "https://api.github.com";
export const RATE_LIMIT_HINT = "anonymous calls are throttled, set GITHUB_TOKEN to raise the limit";

function login(v: unknown): string | null {
  return str(rec(v)?.login);
}

export function githubHeaders(cfg: GithubConfig): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "proofbench-ticket-reader",
    ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
  };
}

export async function readGithub(ref: Extract<ParsedRef, { provider: "github" }>, cfg: GithubConfig, ctx: ProviderCtx): Promise<Ticket> {
  const { http, params } = ctx;
  const headers = githubHeaders(cfg);
  const repoUrl = `${GITHUB_API}/repos/${encode(ref.owner)}/${encode(ref.repo)}`;
  const n = ref.number;
  const misses: string[] = [];

  const issue = rec(must(await http.get(`${repoUrl}/issues/${n}`, headers)).body);
  if (!issue) throw new Error("GitHub: unexpected response shape");
  const isPull = rec(issue.pull_request) !== null || ref.hint === "pull";

  const raw: RawComment[] = [];
  const total = num(issue.comments) ?? 0;
  if (params.commentLimit > 0 && total > 0) {
    const page = Math.max(1, Math.ceil(total / 100));
    const res = await http.get(`${repoUrl}/issues/${n}/comments?per_page=100&page=${page}`, headers);
    if (res.ok) {
      for (const c of arr(res.body)) {
        const o = rec(c);
        if (o) raw.push({ author: login(o.user), createdAt: str(o.created_at), body: str(o.body) ?? "" });
      }
      if (raw.length < Math.min(total, params.commentLimit)) misses.push("GitHub: only the last page of comments is read, older comments were not fetched");
    } else misses.push(res.miss);
  }

  let change: Change | undefined;
  let status = str(issue.state);
  if (isPull) {
    const pr = rec(must(await http.get(`${repoUrl}/pulls/${n}`, headers)).body);
    if (!pr) throw new Error("GitHub: unexpected response shape");
    const merged = pr.merged === true;
    const files: ChangeFile[] = [];
    let filesTruncated = false;
    const fr = await http.get(`${repoUrl}/pulls/${n}/files?per_page=${FILE_LIST_MAX}`, headers);
    if (fr.ok) {
      for (const f of arr(fr.body).slice(0, FILE_LIST_MAX)) {
        const o = rec(f);
        const path = str(o?.filename);
        if (o && path) files.push({ path, ...(str(o.status) ? { status: str(o.status) as string } : {}), additions: num(o.additions) ?? 0, deletions: num(o.deletions) ?? 0 });
      }
    } else misses.push(fr.miss);
    const changedFiles = num(pr.changed_files);
    filesTruncated = changedFiles !== null && changedFiles > files.length;
    status = merged ? "merged" : (str(pr.state) ?? status);
    change = {
      state: str(pr.state) ?? "unknown",
      merged,
      draft: pr.draft === true,
      baseBranch: str(rec(pr.base)?.ref),
      headBranch: str(rec(pr.head)?.ref),
      changedFiles,
      files,
      filesTruncated,
    };
  }

  const desc = truncate(str(issue.body) ?? "", params.descriptionMaxChars);
  return {
    provider: "github",
    id: `${ref.owner}/${ref.repo}#${n}`,
    url: str(issue.html_url) ?? `https://github.com/${ref.owner}/${ref.repo}/${isPull ? "pull" : "issues"}/${n}`,
    kind: isPull ? "pull_request" : "issue",
    title: str(issue.title) ?? "",
    status,
    author: login(issue.user),
    assignees: arr(issue.assignees).map(login).filter((x): x is string => x !== null),
    labels: arr(issue.labels)
      .map((l) => (typeof l === "string" ? l : str(rec(l)?.name)))
      .filter((x): x is string => x !== null),
    createdAt: str(issue.created_at),
    updatedAt: str(issue.updated_at),
    description: desc.text,
    truncated: desc.truncated,
    comments: toComments(raw, params.commentLimit),
    links: [],
    ...(change ? { change } : {}),
    misses,
  };
}
