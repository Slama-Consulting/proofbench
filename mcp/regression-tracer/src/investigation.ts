import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Forge = "gitlab" | "github" | "bitbucket" | "azure" | "unknown";

export interface Capabilities {
  mrLookup: boolean;
  tickets: boolean;
}

export interface Snapshot {
  path: string;
  repoId: string;
  ref: string;
  /** Files copied when the investigation is opened, relative to the copy: absent from an older investigation. */
  copyFiles?: string[];
  /** Folder that keeps the content of `copyFiles`, to restore them after a cleanup. */
  filesDir?: string;
  /** Assisted bisect in progress in this copy: git refs keep none of this. */
  assisted?: AssistedBisect;
}

/** An answer given during an earlier test and reused without redoing it. */
export interface ReusedAnswer {
  sha: string;
  outcome: "good" | "bad";
  evidenceId: string;
  statement?: string;
}

export interface AssistedBisect {
  /** How the bug reproduces, stated at the start: an answer is only valid for its scenario. */
  scenario: string;
  reuseAnswers: boolean;
  reused: ReusedAnswer[];
  /** Evidence for the answers given to this bisect: an abort removes them. */
  answerIds: string[];
  /** Culprit found thanks to a reuse, awaiting `bisect_confirm`. */
  pendingCulprit?: string;
}

export type EvidenceKind = "execution" | "attestation" | "code_reading" | "claim";

/** What a piece of evidence says about a commit: the commit tested or classified, and the result. */
export interface EvidenceSubject {
  sha: string;
  outcome: "bad" | "good" | "culprit" | "cosmetic";
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  summary: string;
  source: string;
  data: unknown;
  untrusted: boolean;
  subject?: EvidenceSubject;
  /** Culprit of a bisect replaced by a more recent bisect: it no longer proves anything. */
  superseded?: boolean;
}

export interface RepoRef {
  repoId: string;
  path: string;
  forge: Forge;
  capabilities: Capabilities;
  misses: string[];
}

export interface Investigation {
  id: string;
  repos: RepoRef[];
  evidence: Evidence[];
  startMode: "exact_version" | "from_logs" | null;
  /** `null` until the user has answered. */
  intermittent: boolean | null;
  snapshots: Snapshot[];
  coverage: { examined: string[]; notExamined: string[] };
  /** Repository, file and excerpt of the last fix search: the `target:` lines are only valid for them. */
  fixQuery?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultRoot(): string {
  return join(homedir(), ".proofbench", "investigations");
}

export function isInvestigationId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/** An id is accepted only if it has the shape of a UUID: no separator, hence no escape from the root folder. */
function fileFor(id: string, root: string): string {
  if (!isInvestigationId(id)) {
    throw new Error(`Invalid investigation id: ${JSON.stringify(id)}`);
  }
  return join(root, `${id}.json`);
}

export function createInvestigation(root: string = defaultRoot()): Investigation {
  const inv: Investigation = {
    id: randomUUID(),
    repos: [],
    evidence: [],
    startMode: null,
    intermittent: null,
    snapshots: [],
    coverage: { examined: [], notExamined: [] },
  };
  saveInvestigation(inv, root);
  return inv;
}

export function saveInvestigation(inv: Investigation, root: string = defaultRoot()): void {
  const file = fileFor(inv.id, root);
  mkdirSync(root, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(inv, null, 2), "utf8");
  renameSync(tmp, file);
}

export function loadInvestigation(id: string, root: string = defaultRoot()): Investigation {
  const file = fileFor(id, root);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Investigation not found: ${id}`);
    }
    throw e;
  }
  return JSON.parse(raw) as Investigation;
}

export function addEvidence(inv: Investigation, e: Omit<Evidence, "id">): Evidence {
  const evidence: Evidence = { ...e, id: `E${inv.evidence.length + 1}` };
  inv.evidence.push(evidence);
  return evidence;
}

export function getEvidence(inv: Investigation, id: string): Evidence {
  const found = inv.evidence.find((e) => e.id === id);
  if (!found) {
    const known = inv.evidence.map((e) => e.id).join(", ") || "none";
    throw new Error(`Unknown evidence: ${id} (existing evidence: ${known})`);
  }
  return found;
}
