import type { LinearConfig } from "../config.js";
import type { ParsedRef } from "../refs.js";
import { arr, num, rec, str, truncate } from "../text.js";
import type { Ticket, TicketLink } from "../types.js";
import { must, toComments, type ProviderCtx, type RawComment } from "./common.js";

export const LINEAR_API = "https://api.linear.app/graphql";

/** One read-only query. Linear has no write path in this package: only `query` is ever sent. */
const QUERY = `query TicketRead($id: String!, $first: Int!) {
  issue(id: $id) {
    identifier title url description priority priorityLabel createdAt updatedAt
    state { name }
    creator { name displayName }
    assignee { name displayName }
    labels { nodes { name } }
    comments(first: $first) { nodes { body createdAt user { name displayName } } }
    parent { identifier url title }
    children { nodes { identifier url title } }
    relations { nodes { type relatedIssue { identifier url title } } }
    attachments { nodes { url title sourceType } }
  }
}`;

function who(v: unknown): string | null {
  const o = rec(v);
  return str(o?.displayName) ?? str(o?.name);
}

function nodes(v: unknown): unknown[] {
  return arr(rec(v)?.nodes);
}

function issueLink(type: string, v: unknown): TicketLink | null {
  const o = rec(v);
  const id = str(o?.identifier);
  if (!o || !id) return null;
  const url = str(o.url);
  const title = str(o.title);
  return { type, id, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

export async function readLinear(ref: Extract<ParsedRef, { provider: "linear" }>, cfg: LinearConfig, ctx: ProviderCtx): Promise<Ticket> {
  const { http, params } = ctx;
  const res = must(await http.post(LINEAR_API, { Authorization: cfg.apiKey }, { query: QUERY, variables: { id: ref.key, first: Math.max(1, params.commentLimit) } }));
  const body = rec(res.body);
  const errors = arr(body?.errors);
  const issue = rec(rec(body?.data)?.issue);
  if (!issue) {
    const notFound = errors.some((e) => /not found/i.test(str(rec(e)?.message) ?? ""));
    throw new Error(errors.length > 0 && !notFound ? "Linear: the query was rejected" : "Linear: not found, or not visible with this key");
  }

  const raw: RawComment[] = [];
  if (params.commentLimit > 0) {
    for (const c of nodes(issue.comments)) {
      const o = rec(c);
      if (o) raw.push({ author: who(o.user), createdAt: str(o.createdAt), body: str(o.body) ?? "" });
    }
  }

  const links: TicketLink[] = [];
  const parent = issueLink("parent", issue.parent);
  if (parent) links.push(parent);
  for (const c of nodes(issue.children)) {
    const l = issueLink("subtask", c);
    if (l) links.push(l);
  }
  for (const r of nodes(issue.relations)) {
    const l = issueLink(str(rec(r)?.type) ?? "related", rec(r)?.relatedIssue);
    if (l) links.push(l);
  }
  for (const a of nodes(issue.attachments)) {
    const o = rec(a);
    const url = str(o?.url);
    if (!o || !url) continue;
    const title = str(o.title);
    links.push({ type: str(o.sourceType) ? `attachment:${str(o.sourceType)}` : "attachment", id: url, url, ...(title ? { title } : {}) });
  }

  const desc = truncate(str(issue.description) ?? "", params.descriptionMaxChars);
  const priority = num(issue.priority) ? str(issue.priorityLabel) : null;
  const assignee = who(issue.assignee);
  const id = str(issue.identifier) ?? ref.key;
  return {
    provider: "linear",
    id,
    url: str(issue.url) ?? `https://linear.app/issue/${id}`,
    kind: "issue",
    title: str(issue.title) ?? "",
    status: str(rec(issue.state)?.name),
    author: who(issue.creator),
    assignees: assignee ? [assignee] : [],
    labels: nodes(issue.labels)
      .map((l) => str(rec(l)?.name))
      .filter((x): x is string => x !== null),
    ...(priority ? { priority } : {}),
    createdAt: str(issue.createdAt),
    updatedAt: str(issue.updatedAt),
    description: desc.text,
    truncated: desc.truncated,
    comments: toComments(raw, params.commentLimit),
    links,
    misses: [],
  };
}
