import { git } from "./git.js";
import { GitLabClient, glabToken, type MrInfo } from "./gitlab.js";
import type { ClientOptions, FetchFn } from "./http.js";
import { addEvidence, type Investigation, type RepoRef } from "./investigation.js";
import { JiraBrowserClient } from "./jira.js";
import { browserSessionProvider } from "./jira-browser.js";
import { loginTimeoutMs, type SessionProvider } from "./jira-session.js";
import { readConfig, remoteHost, remoteProjectPath, remoteUrl } from "./repo.js";

/** From most to least reliable. */
export type LinkSource = "mr_link" | "commit_mention" | "branch_name" | "text_match";
const SOURCE_RANK: Record<LinkSource, number> = { mr_link: 0, commit_mention: 1, branch_name: 2, text_match: 3 };

/** A link is a lead: "refs: X" means linked, not cause. */
export interface TicketLink {
  key: string;
  source: LinkSource;
  /** `true`: Jira knows the key; `false`: Jira answers 404; absent: not verified. */
  validated?: boolean;
  url?: string;
}

export interface LinkResult {
  mr?: MrInfo;
  tickets: TicketLink[];
  misses: string[];
  evidenceIds: string[];
}

export interface LinkDeps {
  fetchFn?: FetchFn;
  env?: Record<string, string | undefined>;
  configPath?: string;
  /** Reads the glab token for a host; replaceable in tests. */
  runGlab?: (host: string) => Promise<string | null>;
  clientOptions?: ClientOptions;
  /** Source of the Jira session without a token; replaceable in tests, so that no browser is launched. */
  sessionProvider?: SessionProvider;
}

const TICKET_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d{1,9})(?![A-Za-z0-9])/g;
/** Prefixes that look like a Jira key without being one (CVE-2024-1, SHA-256, UTF-8...). */
const NOT_PROJECTS = new Set([
  "CVE", "CWE", "GHSA", "SHA", "UTF", "ISO", "MD", "RFC", "HTTP", "TLS", "SSL", "AES", "RSA", "PEP", "BIP",
  "WCAG", "UTC", "GMT", "X", "ES", "ECMA", "IEEE", "TCP", "UDP", "IPV", "SSH", "GPG", "PGP", "JDK", "JSON",
]);
const MAX_TICKETS = 20;
const MAX_JIRA_LOOKUPS = 10;
const SHA_ARG_RE = /^[0-9a-f]{7,40}$/i;

export function extractTickets(text: string, source: LinkSource, projects?: string[]): TicketLink[] {
  const wanted = projects && projects.length > 0 ? new Set(projects) : null;
  const seen = new Set<string>();
  const out: TicketLink[] = [];
  for (const m of text.matchAll(TICKET_RE)) {
    const [key, project] = [m[0], m[1]];
    if (NOT_PROJECTS.has(project)) continue;
    if (wanted && !wanted.has(project)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, source });
  }
  return out;
}

/** Merges, keeping the most reliable source per key; sorts by reliability (stable order afterwards). */
function merge(lists: TicketLink[][]): TicketLink[] {
  const best = new Map<string, TicketLink>();
  for (const l of lists.flat()) {
    const cur = best.get(l.key);
    if (!cur || SOURCE_RANK[l.source] < SOURCE_RANK[cur.source]) best.set(l.key, { ...l });
  }
  return [...best.values()].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
}

function pickMr(mrs: MrInfo[], sha: string): { mr: MrInfo; ambiguous: boolean } | null {
  if (mrs.length === 0) return null;
  const exact = mrs.filter((m) => m.mergeCommitSha === sha || m.squashCommitSha === sha);
  const pool = exact.length > 0 ? exact : mrs.filter((m) => m.state === "merged");
  const chosen = pool[0] ?? mrs[0];
  return { mr: chosen, ambiguous: exact.length === 0 && mrs.length > 1 };
}

export function requireRepo(inv: Investigation, repoId: string): RepoRef {
  const repo = inv.repos.find((r) => r.repoId === repoId);
  if (!repo) {
    const known = inv.repos.map((r) => r.repoId).join(", ") || "none";
    throw new Error(`Unknown repository: ${repoId} (known repositories: ${known})`);
  }
  return repo;
}

/**
 * Links a commit to its GitLab MR and to tickets. Any network or access failure degrades to `misses`:
 * the tickets read in the commit are always returned. Commit, MR and Jira texts are never
 * copied into `misses`; they appear only in evidence, marked untrusted.
 * Links are leads (code_reading), never proof of cause.
 */
export async function linkChange(inv: Investigation, repoId: string, sha: string, deps: LinkDeps = {}): Promise<LinkResult> {
  const repo = requireRepo(inv, repoId);
  if (typeof sha !== "string" || !SHA_ARG_RE.test(sha)) throw new Error(`Invalid sha: ${JSON.stringify(sha)}`);

  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const misses: string[] = [];

  const log = await git(repo.path, [
    "log", "-1", "--no-ext-diff", "--no-textconv", "--format=%H%x00%P%x00%B", `${sha}^{commit}`, "--",
  ]);
  if (log.code !== 0) throw new Error(`Commit not found: ${sha}`);
  const [fullSha, parents = "", ...rest] = log.stdout.split("\0");
  const message = rest.join("\0");
  const [subject = "", ...bodyLines] = message.split("\n");
  const body = bodyLines.join("\n");

  let projects: string[] | undefined;
  try {
    projects = readConfig(repo.path, deps.configPath).jiraProjects;
  } catch (e) {
    misses.push(`Config ignored (user config): ${(e as Error).message}`);
  }

  // Merge commit: the branch named in the subject is a branch name, not a mention.
  const isMerge = parents.trim().split(/\s+/).filter(Boolean).length > 1 || /^Merge /.test(subject);
  const commitLinks = isMerge
    ? [extractTickets(subject, "branch_name", projects), extractTickets(body, "commit_mention", projects)]
    : [extractTickets(message, "commit_mention", projects)];

  // GitLab
  let mr: MrInfo | undefined;
  const mrLinks: TicketLink[][] = [];
  if (repo.forge === "gitlab") {
    const gl = await gitlabLookup(repo.path, fullSha, env, fetchFn, deps, misses);
    if (gl) {
      mr = gl;
      mrLinks.push(
        extractTickets(gl.title, "mr_link", projects),
        extractTickets(gl.sourceBranch, "branch_name", projects),
        extractTickets(gl.description, "text_match", projects),
      );
    }
  }

  let tickets = merge([...commitLinks, ...mrLinks]);
  if (tickets.length > MAX_TICKETS) {
    misses.push(`Tickets: cap of ${MAX_TICKETS} links reached, the least reliable are ignored`);
    tickets = tickets.slice(0, MAX_TICKETS);
  }

  // Jira
  const jiraInfo = new Map<string, { summary: string; status: string }>();
  if (tickets.length > 0) {
    const base = env.JIRA_BASE_URL;
    // The Jira host comes from JIRA_BASE_URL and nothing else: not the repository, the config, a commit or a ticket.
    if (!base) {
      misses.push("Jira not configured (JIRA_BASE_URL): links not verified");
    } else {
      let jira: JiraBrowserClient | null = null;
      try {
        jira = new JiraBrowserClient(base, deps.sessionProvider ?? browserSessionProvider, loginTimeoutMs(env), fetchFn, deps.clientOptions);
      } catch (e) {
        misses.push(`Jira ignored: ${(e as Error).message}`);
      }
      if (jira) {
        if (tickets.length > MAX_JIRA_LOOKUPS) {
          misses.push(`Jira: only the first ${MAX_JIRA_LOOKUPS} links are verified`);
        }
        for (const t of tickets.slice(0, MAX_JIRA_LOOKUPS)) {
          const before = jira.misses.length;
          const issue = await jira.getIssue(t.key);
          if (issue) {
            t.validated = true;
            jiraInfo.set(t.key, { summary: issue.summary, status: issue.status });
          } else if (jira.misses.length === before) {
            t.validated = false;
          }
          const url = jira.browseUrl(t.key);
          if (url) t.url = url;
        }
        misses.push(...new Set(jira.misses));
      }
    }
  }

  // Evidence: leads (code_reading), untrusted data.
  const evidenceIds: string[] = [];
  const short = fullSha.slice(0, 10);
  if (mr) {
    const e = addEvidence(inv, {
      kind: "code_reading",
      summary: `Lead: MR !${mr.iid} contains commit ${short} (link, not a cause)`,
      source: "gitlab:merge_request",
      data: { sha: fullSha, mr },
      untrusted: true,
    });
    evidenceIds.push(e.id);
  }
  for (const t of tickets) {
    const e = addEvidence(inv, {
      kind: "code_reading",
      summary: `Lead: ${t.key} is linked to commit ${short} by ${t.source} (linked, not proven cause)`,
      source: `links:${t.source}`,
      data: { sha: fullSha, ...t, jira: jiraInfo.get(t.key) },
      untrusted: true,
    });
    evidenceIds.push(e.id);
  }

  return { mr, tickets, misses, evidenceIds };
}

async function gitlabLookup(
  repoPath: string,
  fullSha: string,
  env: Record<string, string | undefined>,
  fetchFn: FetchFn,
  deps: LinkDeps,
  misses: string[],
): Promise<MrInfo | null> {
  const gl = await gitlabClient(repoPath, env, fetchFn, deps, misses);
  if (!gl) return null;
  const mrs = await gl.client.mrsForCommit(gl.project, fullSha);
  misses.push(...new Set(gl.client.misses));
  const pick = pickMr(mrs, fullSha);
  if (!pick) return null;
  if (pick.ambiguous) misses.push("Several MRs contain this commit without being its merge point: the most likely one is kept");
  return pick.mr;
}

/** GitLab client for the repository, or null with the reason in `misses`. The only place that decides where the token goes. */
export async function gitlabClient(
  repoPath: string,
  env: Record<string, string | undefined>,
  fetchFn: FetchFn,
  deps: LinkDeps,
  misses: string[],
): Promise<{ client: GitLabClient; project: string } | null> {
  let gitlabHost: string | undefined;
  try {
    gitlabHost = readConfig(repoPath, deps.configPath).gitlabHost;
  } catch (e) {
    const miss = `Config ignored (user config): ${(e as Error).message}`;
    if (!misses.includes(miss)) misses.push(miss);
  }
  // The token goes only to an allowed host: gitlabHost from the user config if defined
  // (and only that), otherwise gitlab.com. The remote is re-read here, and the host and the project both come from
  // that same remote. A forced platform (override or config.forge) never widens this list.
  const url = await remoteUrl(repoPath);
  const remote = url ? remoteHost(url) : null;
  const project = url ? remoteProjectPath(url) : null;
  const allowed = gitlabHost?.trim() || "gitlab.com";
  const noPort = (h: string) => h.toLowerCase().replace(/:\d+$/, "");
  if (!remote || !project) {
    misses.push("GitLab: remote host or project not found, MR not searched");
    return null;
  }
  if (noPort(remote) !== noPort(allowed)) {
    misses.push(
      "GitLab: the remote host is not the allowed host (gitlab.com, or gitlabHost from the user config): token not sent, MR not searched",
    );
    return null;
  }
  const host = allowed.toLowerCase();

  let token = env.GITLAB_TOKEN?.trim() || null;
  if (!token) {
    token = (await (deps.runGlab ?? glabToken)(host))?.trim() || null;
    if (!token) {
      misses.push("No GitLab token (GITLAB_TOKEN missing, glab fallback returned nothing): MR not searched");
      return null;
    }
  }
  if (/[\s\0]/.test(token)) {
    misses.push("Invalid GitLab token (forbidden characters): MR not searched");
    return null;
  }

  try {
    return { client: new GitLabClient(host, token, fetchFn, deps.clientOptions), project };
  } catch (e) {
    misses.push(`GitLab ignored: ${(e as Error).message}`);
    return null;
  }
}
