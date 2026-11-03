import type { GitlabConfig } from "../config.js";
import type { ParsedRef } from "../refs.js";
import { arr, num, rec, str, truncate } from "../text.js";
import { FILE_LIST_MAX, type Change, type ChangeFile, type Kind, type Ticket, type TicketLink } from "../types.js";
import { encode, must, toComments, type ProviderCtx, type RawComment } from "./common.js";

function user(v: unknown): string | null {
  const o = rec(v);
  return str(o?.username) ?? str(o?.name);
}

function linkOf(type: string, v: unknown): TicketLink | null {
  const o = rec(v);
  if (!o) return null;
  const refs = rec(o.references);
  const id = str(refs?.full) ?? (num(o.iid) !== null ? String(o.iid) : null);
  if (!id) return null;
  const url = str(o.web_url);
  const title = str(o.title);
  return { type, id, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

function issueKind(t: string | null): Kind {
  if (t === "task") return "task";
  if (t === "epic") return "epic";
  return "issue";
}

export async function readGitlab(ref: Extract<ParsedRef, { provider: "gitlab" }>, cfg: GitlabConfig, ctx: ProviderCtx): Promise<Ticket> {
  const { http, params } = ctx;
  const headers = { "PRIVATE-TOKEN": cfg.token };
  const isMr = ref.type === "mr";
  const resource = isMr ? "merge_requests" : "issues";
  const root = `${cfg.baseUrl}/api/v4/projects/${encode(ref.project)}/${resource}/${ref.number}`;
  const misses: string[] = [];

  const item = rec(must(await http.get(root, headers)).body);
  if (!item) throw new Error("GitLab: unexpected response shape");

  const raw: RawComment[] = [];
  if (params.commentLimit > 0) {
    const res = await http.get(`${root}/notes?sort=desc&order_by=created_at&per_page=${Math.min(100, params.commentLimit + 20)}`, headers);
    if (res.ok) {
      for (const c of arr(res.body)) {
        const o = rec(c);
        // System notes are state changes ("assigned to", "changed the description"), not discussion.
        if (o && o.system !== true) raw.push({ author: user(o.author), createdAt: str(o.created_at), body: str(o.body) ?? "" });
      }
    } else misses.push(res.miss);
  }

  const links: TicketLink[] = [];
  let change: Change | undefined;
  if (isMr) {
    const closes = await http.get(`${root}/closes_issues`, headers);
    if (closes.ok) for (const i of arr(closes.body)) { const l = linkOf("closes", i); if (l) links.push(l); }
    else misses.push(closes.miss);

    const files: ChangeFile[] = [];
    const fr = await http.get(`${root}/diffs?per_page=${FILE_LIST_MAX}`, headers);
    if (fr.ok) {
      for (const f of arr(fr.body).slice(0, FILE_LIST_MAX)) {
        const o = rec(f);
        const path = str(o?.new_path) ?? str(o?.old_path);
        if (!o || !path) continue;
        files.push({ path, status: o.new_file === true ? "added" : o.deleted_file === true ? "deleted" : o.renamed_file === true ? "renamed" : "modified" });
      }
    } else misses.push(fr.miss);
    const count = Number.parseInt(String(item.changes_count ?? ""), 10);
    const state = str(item.state) ?? "unknown";
    change = {
      state,
      merged: state === "merged",
      draft: item.draft === true || item.work_in_progress === true,
      baseBranch: str(item.target_branch),
      headBranch: str(item.source_branch),
      changedFiles: Number.isFinite(count) ? count : null,
      files,
      filesTruncated: Number.isFinite(count) ? count > files.length : files.length >= FILE_LIST_MAX,
    };
  } else {
    const res = await http.get(`${root}/links`, headers);
    if (res.ok) for (const i of arr(res.body)) { const l = linkOf(str(rec(i)?.link_type) ?? "relates_to", i); if (l) links.push(l); }
    else misses.push(res.miss);
  }

  const desc = truncate(str(item.description) ?? "", params.descriptionMaxChars);
  const sep = isMr ? "!" : "#";
  return {
    provider: "gitlab",
    id: `${ref.project}${sep}${ref.number}`,
    url: str(item.web_url) ?? `${cfg.baseUrl}/${ref.project}/-/${resource}/${ref.number}`,
    kind: isMr ? "merge_request" : issueKind(str(item.issue_type)),
    title: str(item.title) ?? "",
    status: str(item.state),
    author: user(item.author),
    assignees: arr(item.assignees).map(user).filter((x): x is string => x !== null),
    labels: arr(item.labels).filter((x): x is string => typeof x === "string"),
    createdAt: str(item.created_at),
    updatedAt: str(item.updated_at),
    description: desc.text,
    truncated: desc.truncated,
    comments: toComments(raw, params.commentLimit),
    links,
    ...(change ? { change } : {}),
    misses,
  };
}
