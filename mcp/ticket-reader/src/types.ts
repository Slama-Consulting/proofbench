export type Provider = "jira" | "github" | "gitlab" | "linear";
export const PROVIDERS: readonly Provider[] = ["jira", "github", "gitlab", "linear"];

export type Kind = "issue" | "pull_request" | "merge_request" | "story" | "bug" | "task" | "epic" | "other";

export interface TicketLink {
  type: string;
  id: string;
  url?: string;
  title?: string;
}

export interface TicketComment {
  author: string | null;
  createdAt: string | null;
  body: string;
  /** Present (true) only when the body was cut at the per-comment limit. */
  truncated?: true;
}

export interface ChangeFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

/** Extra data for a pull request or a merge request. Never contains diffs. */
export interface Change {
  state: string;
  merged: boolean;
  draft: boolean;
  baseBranch: string | null;
  headBranch: string | null;
  changedFiles: number | null;
  files: ChangeFile[];
  filesTruncated: boolean;
}

export interface Ticket {
  provider: Provider;
  id: string;
  url: string;
  kind: Kind;
  title: string;
  status: string | null;
  author: string | null;
  assignees: string[];
  labels: string[];
  priority?: string;
  createdAt: string | null;
  updatedAt: string | null;
  description: string;
  /** True when the description was cut at `descriptionMaxChars`. */
  truncated: boolean;
  comments: TicketComment[];
  links: TicketLink[];
  change?: Change;
  misses: string[];
}

export interface ReadParams {
  commentLimit: number;
  descriptionMaxChars: number;
}

export const COMMENT_MAX_CHARS = 2000;
export const FILE_LIST_MAX = 50;
