import type { JiraConfig } from "../config.js";
import type { ParsedRef } from "../refs.js";
import { adfToText, arr, rec, str, truncate } from "../text.js";
import type { Kind, Ticket, TicketLink } from "../types.js";
import { encode, must, toComments, type ProviderCtx, type RawComment } from "./common.js";

const FIELDS = "summary,status,issuetype,creator,reporter,assignee,labels,priority,created,updated,description,issuelinks,parent,subtasks";

function name(v: unknown): string | null {
  return str(rec(v)?.displayName) ?? str(rec(v)?.name);
}

function kindOf(typeName: string | null): Kind {
  switch (typeName?.toLowerCase()) {
    case "bug":
      return "bug";
    case "story":
      return "story";
    case "task":
    case "sub-task":
    case "subtask":
      return "task";
    case "epic":
      return "epic";
    default:
      return "other";
  }
}

export async function readJira(ref: Extract<ParsedRef, { provider: "jira" }>, cfg: JiraConfig, ctx: ProviderCtx): Promise<Ticket> {
  const { http, params } = ctx;
  const headers = { Authorization: cfg.authHeader };
  const api = `${cfg.baseUrl}/rest/api/${cfg.apiVersion}/issue/${encode(ref.key)}`;
  const browse = (key: string) => `${cfg.baseUrl}/browse/${encode(key)}`;
  const misses: string[] = [];

  const issue = rec(must(await http.get(`${api}?fields=${FIELDS}`, headers)).body);
  const f = rec(issue?.fields);
  if (!issue || !f) throw new Error("Jira: unexpected response shape");

  const raw: RawComment[] = [];
  if (params.commentLimit > 0) {
    const res = await http.get(`${api}/comment?orderBy=-created&maxResults=${params.commentLimit}`, headers);
    if (res.ok) {
      for (const c of arr(rec(res.body)?.comments)) {
        const o = rec(c);
        if (o) raw.push({ author: name(o.author), createdAt: str(o.created), body: adfToText(o.body) });
      }
    } else misses.push(res.miss);
  }

  const links: TicketLink[] = [];
  const add = (type: string, v: unknown) => {
    const o = rec(v);
    const key = str(o?.key);
    if (!o || !key) return;
    const title = str(rec(o.fields)?.summary);
    links.push({ type, id: key, url: browse(key), ...(title ? { title } : {}) });
  };
  for (const l of arr(f.issuelinks)) {
    const o = rec(l);
    const t = rec(o?.type);
    if (!o) continue;
    if (o.outwardIssue) add(str(t?.outward) ?? str(t?.name) ?? "relates to", o.outwardIssue);
    if (o.inwardIssue) add(str(t?.inward) ?? str(t?.name) ?? "relates to", o.inwardIssue);
  }
  if (f.parent) add("parent", f.parent);
  for (const s of arr(f.subtasks)) add("subtask", s);

  const desc = truncate(adfToText(f.description), params.descriptionMaxChars);
  const priority = str(rec(f.priority)?.name);
  const assignee = name(f.assignee);
  return {
    provider: "jira",
    id: str(issue.key) ?? ref.key,
    url: browse(ref.key),
    kind: kindOf(str(rec(f.issuetype)?.name)),
    title: str(f.summary) ?? "",
    status: str(rec(f.status)?.name),
    author: name(f.creator) ?? name(f.reporter),
    assignees: assignee ? [assignee] : [],
    labels: arr(f.labels).filter((x): x is string => typeof x === "string"),
    ...(priority ? { priority } : {}),
    createdAt: str(f.created),
    updatedAt: str(f.updated),
    description: desc.text,
    truncated: desc.truncated,
    comments: toComments(raw, params.commentLimit),
    links,
    misses,
  };
}
