import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { evaluate, missingOf, otherGates, repoState, scoreOf, type Finding, type Gate, type Proof, type StepResult } from "./gate.js";
import { git } from "./git.js";
import { redact } from "./secrets.js";

const EXCLUDE_ENTRY = ".proofbench/";
const NONE_FOUND = "no flaw found by these tests";

/** A single line, with nothing Markdown interprets: the text comes from the repo, a note or an output. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .replace(/[\\`*_[\]<>|~&@#]/g, "\\$&")
    .replace(/:\/\//g, "\\://")
    .replace(/(www)\./gi, "$1\\.");
}

/** Nothing under `.proofbench/reports` may be a link or anything other than a folder. */
function checkReportsDir(repo: string): void {
  let current = repo;
  for (const part of [".proofbench", "reports"]) {
    current = join(current, part);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`Report refused: ${current} is a link, or not a folder`);
  }
}

/** Adds the entry only once, by plain append: no other line is rewritten. */
async function excludeProofbench(repo: string): Promise<void> {
  const r = await git(repo, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) throw new Error(`Exclude file not found: ${r.stderr.trim()}`);
  const file = resolve(repo, r.stdout.trim());
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${EXCLUDE_ENTRY}\n`, "utf8");
}

/** The rename replaces any link planted at that spot instead of following it. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  renameSync(tmp, file);
}

/** Findings from the latest proof of each step; for the network, from all of them, since each request is one. */
function findingsOf(gate: Gate): Finding[] {
  const latest = new Map(gate.proofs.filter((p) => p.step !== "api_staging").map((p) => [p.step, p]));
  const http = gate.proofs.filter((p) => p.step === "api_staging");
  const failed = [...latest.values()].filter((p) => p.step === "deps_audit" && p.exitCode !== 0 && p.exitCode !== null);
  return [
    ...[...latest.values(), ...http].flatMap((p) => p.findings ?? []),
    ...failed.map((p) => ({ rule: "deps_audit", detail: `dependency audit: code ${String(p.exitCode)}` })),
  ];
}

function conclusionOf(gate: Gate, steps: readonly StepResult[], findings: readonly Finding[]): string | null {
  if (gate.workflow !== "security-audit") return null;
  if (findings.length > 0) return `${findings.length} finding(s), listed below.`;
  // An optional step attempted without success counts: otherwise a lost request would allow a conclusion.
  const tried = (id: string) => gate.proofs.some((p) => p.step === id);
  const incomplete = steps.some((s) => s.status === "missing" && (s.required || tried(s.id)));
  return incomplete ? "Checks incomplete: no conclusion." : `Result: ${NONE_FOUND}. This does not mean "safe".`;
}

function renderFinding(f: Finding): string {
  const place = [f.file, f.commit?.slice(0, 12), f.line].filter(Boolean).join(" ");
  const what = [f.kind ?? f.rule, f.component, f.masked, f.detail].filter(Boolean).join(" ");
  return `- ${escapeMarkdown(place ? `${place}: ${what}` : what)}`;
}

function numbersOf(proof: Proof | undefined): string | undefined {
  const parts: string[] = [];
  if (proof?.tests) {
    const { total, failed, skipped } = proof.tests;
    parts.push(`tests run ${total}, passed ${total - failed - skipped}, skipped ${skipped}, failed ${failed}`);
  }
  if (proof?.warnings) parts.push(`warnings ${proof.warnings.count}, errors ${proof.warnings.errors ?? 0}`);
  return parts.length > 0 ? parts.join(" ; ") : undefined;
}

function renderStep(gate: Gate, s: StepResult): string {
  const mark = s.status === "missing" ? (s.required ? "missing" : "optional, not done") : s.status === "noted" ? "noted" : s.status === "na" ? "not applicable" : "proved";
  const note = gate.notes[s.id];
  const proof = gate.proofs.filter((p) => p.step === s.id).at(-1);
  const argv = proof?.command;
  const detail = [numbersOf(proof), s.reason, note, argv && `command: ${JSON.stringify(argv)}`].filter(Boolean).map((t) => escapeMarkdown(t as string)).join(" ; ");
  return `- ${escapeMarkdown(s.id)} (${s.kind}): ${mark}${detail ? `. ${detail}` : ""}`;
}

function renderReport(gate: Gate, data: { sha: string; score: number; missing: string[]; warnings: string[]; others: { gateId: string; score: number | null }[]; steps: StepResult[]; findings: Finding[]; conclusion: string | null }): string {
  const list = (lines: string[]) => (lines.length > 0 ? lines.join("\n") : "- none");
  return `${[
    `# Gate ${escapeMarkdown(gate.workflow)}: ${data.score}/10`,
    `Final commit: ${data.sha}. Score computed by the server.${gate.authorizedBy ? ` Network tests authorized by: ${escapeMarkdown(gate.authorizedBy)}.` : ""}`,
    ...(data.conclusion ? [`## Conclusion\n\n${data.conclusion}`] : []),
    `## Steps\n\n${data.steps.map((s) => renderStep(gate, s)).join("\n")}`,
    `## What is missing\n\n${list(data.missing.map((m) => `- ${escapeMarkdown(m)}`))}`,
    ...(data.warnings.length > 0 ? [`## Warnings\n\n${data.warnings.map((w) => `- ${escapeMarkdown(w)}`).join("\n")}`] : []),
    ...(data.others.length > 0 ? [`## Other gates on this repo in the last 24 h\n\n${data.others.map((o) => `- ${o.gateId}: ${o.score === null ? "never closed" : `${o.score}/10`}`).join("\n")}`] : []),
    ...(data.findings.length > 0 ? [`## Findings\n\n${data.findings.map(renderFinding).join("\n")}`] : []),
    `## Limits\n\nThis score is computed from the recorded proofs. A 10 means the listed commands ran and the listed numbers held; it does not prove the tests test the right thing. Files ignored by git outside watchIgnored are excluded from the hash.`,
  ].join("\n\n")}\n`;
}

/** The state is re-read before any write: it is the one being scored. Several closes: the last report replaces the others. */
export async function closeGate(gate: Gate, gatesDir?: string) {
  checkReportsDir(gate.repo);
  await excludeProofbench(gate.repo);
  const state = await repoState(gate.repo, gate.watchIgnored);
  const { steps, caps, warnings } = await evaluate(gate, state);
  const score = scoreOf(steps, caps);
  const missing = missingOf(steps, caps);
  const others = otherGates(gate, gatesDir);
  gate.lastScore = score;
  const findings = findingsOf(gate);
  const conclusion = conclusionOf(gate, steps, findings);
  const data = { sha: state.sha, score, missing, warnings, others, steps, findings, conclusion };

  const dir = join(gate.repo, ".proofbench", "reports");
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `gate-${gate.id}.md`);
  const jsonPath = join(dir, `gate-${gate.id}.json`);
  writeAtomic(reportPath, redact(renderReport(gate, data)));
  writeAtomic(jsonPath, redact(JSON.stringify({ gateId: gate.id, workflow: gate.workflow, repo: gate.repo, authorizedBy: gate.authorizedBy, proofs: gate.proofs, ...data }, null, 2)));
  return { gateId: gate.id, score, max: 10, missing, warnings, others, conclusion, findings: findings.length, reportPath, jsonPath };
}
