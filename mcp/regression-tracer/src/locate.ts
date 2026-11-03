import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";
import { addEvidence, type Investigation, type Snapshot } from "./investigation.js";
import { readConfig } from "./repo.js";

export interface LocateHit {
  file: string;
  line?: number;
  via: "frame" | "retrace" | "log_text";
  /** Several files with the same name, or a package with no match: to be confirmed. */
  ambiguous?: boolean;
}

export interface LocateResult {
  hits: LocateHit[];
  obfuscated: boolean;
  needsInput?: string;
  history?: { firstSeen?: string; lastRemoved?: string };
  evidenceIds: string[];
}

const IS_WIN = process.platform === "win32";
const MAX_HITS = 50;
const MAX_LOG_LINES = 5;
const RETRACE_TIMEOUT_MS = 60_000;
const FRAME_RE = /\bat\s+((?:[\p{L}\p{N}_$<>-]+\.)*[\p{L}\p{N}_$<>-]+)\(([^():\s][^():]*?)(?::(\d+))?\)/gu;

interface Frame {
  pkg: string;
  file: string;
  line?: number;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const m of text.matchAll(FRAME_RE)) {
    const parts = m[1]!.split(".");
    parts.pop(); // method
    parts.pop(); // class
    frames.push({ pkg: parts.join("."), file: m[2]!, line: m[3] ? Number(m[3]) : undefined });
  }
  return frames;
}

/** Only `SourceFile` frames (file name lost by R8) count as obfuscated. */
function isObfuscated(f: Frame): boolean {
  return f.file === "SourceFile";
}

/** Usable source file name: excludes `Native Method`, `Unknown Source`, `<generated>`, D8 synthetic names. */
function isResolvable(f: Frame): boolean {
  return !isObfuscated(f) && /^[^<\s][^\s]*\.[^\s.]+$/.test(f.file);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function insideDir(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Looks up retrace in the absolute directories of PATH, never in the repository, the copy or the cwd (same rule as git.ts). */
function findOnPath(forbidden: string[]): string | null {
  const names = IS_WIN ? ["retrace.exe", "retrace.bat", "retrace.cmd"] : ["retrace"];
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathVar.split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir)) continue;
    if (forbidden.some((f) => insideDir(f, dir))) continue;
    if (resolve(dir).toLowerCase() === resolve(process.cwd()).toLowerCase()) continue;
    for (const n of names) {
      const c = join(dir, n);
      if (existsSync(c) && isFile(c)) return c;
    }
  }
  return null;
}

type Retraced = { ok: true; text: string } | { ok: false; needsInput: string };

/** Runs retrace without a shell, from a temporary folder outside the copy; the trace goes through a file. */
async function runRetrace(exe: string | null, mappingPath: string, trace: string): Promise<Retraced> {
  if (!exe) {
    return {
      ok: false,
      needsInput: "retrace not found: give its native path in retracePath of ~/.proofbench/config.json, or add it to PATH.",
    };
  }
  const ext = extname(exe).toLowerCase();
  if (ext === ".bat" || ext === ".cmd") {
    return {
      ok: false,
      needsInput:
        "retrace is a .bat/.cmd script, which cannot be launched without a shell: give a native (executable) path in retracePath of ~/.proofbench/config.json.",
    };
  }
  if (!isAbsolute(mappingPath) || !isFile(mappingPath)) {
    return { ok: false, needsInput: "The mapping file was not found: provide its absolute path." };
  }
  const dir = await mkdtemp(join(tmpdir(), "rt-retrace-"));
  try {
    const traceFile = join(dir, "trace.txt");
    await writeFile(traceFile, trace, "utf8");
    return await new Promise<Retraced>((done) => {
      execFile(
        exe,
        [mappingPath, traceFile],
        { cwd: dir, timeout: RETRACE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true },
        (error, stdout) => {
          if (error) done({ ok: false, needsInput: "retrace failed: check the mapping and the retrace installation." });
          else done({ ok: true, text: stdout });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/**
 * Tells apart files with the same name by their package. Ambiguous when several candidates remain or when
 * the package matches none of them (R8 can keep a real source name under a renamed package).
 * A package that matches and rules out the other files with the same name is not ambiguous.
 */
function resolveFrame(f: Frame, files: string[], via: "frame" | "retrace"): { hits: LocateHit[]; candidates: string[] } {
  const named = files.filter((p) => p.split("/").pop() === f.file);
  const pkgPath = f.pkg.split(".").join("/");
  const byPkg = pkgPath
    ? named.filter((p) => {
        const dir = p.slice(0, p.lastIndexOf("/"));
        return dir === pkgPath || dir.endsWith(`/${pkgPath}`);
      })
    : [];
  const chosen = byPkg.length > 0 ? byPkg : named;
  const ambiguous = chosen.length > 1 || (named.length > 0 && byPkg.length === 0 && pkgPath !== "");
  const hits = chosen.map((file): LocateHit => {
    const h: LocateHit = f.line === undefined ? { file, via } : { file, line: f.line, via };
    if (ambiguous) h.ambiguous = true;
    return h;
  });
  return { hits, candidates: ambiguous ? chosen : [] };
}

/** Literal search (-F, text passed via -e: a text starting with "-" stays data). */
async function grepLiteral(cwd: string, text: string): Promise<LocateHit[]> {
  const r = await git(cwd, ["grep", "-n", "-F", "-I", "-e", text, "--"]);
  if (r.code !== 0) return [];
  const hits: LocateHit[] = [];
  for (const row of r.stdout.split("\n")) {
    const m = /^(.+?):(\d+):/.exec(row);
    if (m) hits.push({ file: m[1]!, line: Number(m[2]), via: "log_text" });
  }
  return hits;
}

/** Commits (full shas, newest to oldest) that change the number of occurrences of the text. */
async function pickaxe(cwd: string, ref: string, text: string): Promise<string[]> {
  const r = await git(cwd, [
    "log", "--no-ext-diff", "--no-textconv", "--format=%H", `-S${text}`, "--end-of-options", ref, "--",
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s));
}

function dedupe(hits: LocateHit[]): LocateHit[] {
  const seen = new Set<string>();
  const out: LocateHit[] = [];
  for (const h of hits) {
    const k = `${h.via}|${h.file}|${h.line ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

export async function locateCode(
  inv: Investigation,
  snapshot: Snapshot,
  input: { trace?: string; logText?: string; mappingPath?: string },
  configPath?: string,
): Promise<LocateResult> {
  const hits: LocateHit[] = [];
  const needs: string[] = [];
  let obfuscated = false;
  let history: LocateResult["history"];

  const lsr = await git(snapshot.path, ["ls-files"]);
  const files = lsr.code === 0 ? lsr.stdout.split("\n").filter(Boolean) : [];
  const ambiguousFiles = new Set<string>();
  const addFrame = (f: Frame, via: "frame" | "retrace"): void => {
    const r = resolveFrame(f, files, via);
    hits.push(...r.hits);
    for (const c of r.candidates) ambiguousFiles.add(c);
  };
  if (input.trace && lsr.code !== 0) {
    needs.push("The list of files in the copy is unreadable (git ls-files failed): check the working copy.");
  }

  if (input.trace) {
    const frames = parseFrames(input.trace);
    for (const f of frames) if (isResolvable(f)) addFrame(f, "frame");
    if (frames.some(isObfuscated)) {
      obfuscated = true;
      if (!input.mappingPath) {
        needs.push("The trace is obfuscated (R8): provide the mapping.txt file for this version (mappingPath).");
      } else {
        const repoPath = inv.repos.find((r) => r.repoId === snapshot.repoId)?.path ?? snapshot.path;
        let retracePath: string | undefined;
        try {
          retracePath = readConfig(repoPath, configPath).retracePath;
        } catch {
          retracePath = undefined;
        }
        let exe: string | null;
        if (retracePath) exe = isAbsolute(retracePath) && isFile(retracePath) ? retracePath : null;
        else exe = findOnPath([snapshot.path, repoPath]);
        const out = await runRetrace(exe, input.mappingPath, input.trace);
        if (!out.ok) needs.push(out.needsInput);
        else for (const f of parseFrames(out.text)) if (isResolvable(f)) addFrame(f, "retrace");
      }
    }
  }

  if (input.logText !== undefined) {
    const lines = input.logText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 3 && l.length <= 300)
      .slice(0, MAX_LOG_LINES);
    const perLine: { line: string; found: LocateHit[] }[] = [];
    for (const line of lines) {
      const found = await grepLiteral(snapshot.path, line);
      perLine.push({ line, found });
      hits.push(...found);
    }
    // presence and history come from the same line: the first one with results,
    // otherwise the first whose text has a commit history
    const withHits = perLine.find((l) => l.found.length > 0);
    if (withHits) {
      const shas = await pickaxe(snapshot.path, snapshot.ref, withHits.line);
      if (shas.length > 0) history = { firstSeen: shas[shas.length - 1] };
    } else {
      for (const l of perLine) {
        const shas = await pickaxe(snapshot.path, snapshot.ref, l.line);
        if (shas.length > 0) {
          history = { lastRemoved: shas[0] };
          break;
        }
      }
    }
  }

  const unique = dedupe(hits).slice(0, MAX_HITS);
  const evidenceIds: string[] = [];
  if (unique.length > 0) {
    evidenceIds.push(
      addEvidence(inv, {
        kind: "code_reading",
        summary: `${unique.length} code location(s) found from a trace or a log`,
        source: "locate",
        data: { hits: unique },
        untrusted: true,
      }).id,
    );
  }
  if (history) {
    evidenceIds.push(
      addEvidence(inv, {
        kind: "code_reading",
        summary: history.firstSeen ? "First commit introducing the log text" : "Last commit that removed the log text",
        source: "locate",
        data: { history },
        untrusted: true,
      }).id,
    );
  }

  if (ambiguousFiles.size > 0) {
    needs.push(`Several possible files, say which is right: ${[...ambiguousFiles].join(", ")}`);
  }

  const result: LocateResult = { hits: unique, obfuscated, evidenceIds };
  if (needs.length > 0) result.needsInput = needs.join(" ");
  if (history) result.history = history;
  return result;
}
