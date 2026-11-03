import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Warnings {
  count: number;
  errors?: number;
  parser: "marker" | "android" | "generic";
}

export interface TestCounts {
  total: number;
  failed: number;
  skipped: number;
  parser: string;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?|androidTest|androidInstrumentedTest)\/|(^|\/)(test|spec)\.[^/]+$|_test\.[^/]+$|\.(test|spec)\.[^/]+$|(Test|Tests|Spec)\.(kt|java|swift)$/;
/** What decides what the commands do: scripts, build, lint, dotfiles. Not ordinary source. */
const CONTROL_PATH_RE = /(^|\/)scripts\/|(^|\/)package\.json$|\.config\.[^/]+$|(^|\/)\.[^/]|\.gradle(\.kts)?$|\.toml$|(^|\/)lint[^/]*\.xml$|(^|\/)lint[^/]*\/.*\.xml$|baseline|(^|\/)biome\.jsonc?$|(^|\/)detekt[^/]*\.ya?ml$|(^|\/)\.?eslintrc[^/]*$/i;
const JUNIT_XML_RE = /(^|\/)build\/test-results\/.*TEST-[^/]*\.xml$/;
const ANSI_RE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

export const isTestPath = (path: string) => TEST_PATH_RE.test(path);

export function controlKind(path: string, commandFiles: ReadonlySet<string>): "test" | "control" | null {
  if (TEST_PATH_RE.test(path)) return "test";
  return commandFiles.has(path) || CONTROL_PATH_RE.test(path) ? "control" : null;
}

/** A count comes from a recognised format; the generic reader at zero read nothing. */
export const hasLintCount = (w: Warnings | undefined) => w !== undefined && (w.parser !== "generic" || w.count + (w.errors ?? 0) > 0);
export const isJunitXml = (path: string) => JUNIT_XML_RE.test(path);

/** The count comes from the full output: the stored version is truncated. */
export function parseWarnings(text: string, marker?: string): Warnings {
  const lines = text.split(/\r?\n/);
  if (marker !== undefined) return { count: lines.filter((l) => l.includes(marker)).length, parser: "marker" };
  // One summary per module: a multi-module build has several.
  const summaries = [...text.matchAll(/\b(\d+) errors?, (\d+) warnings?\b/g)];
  if (summaries.length > 0) {
    return {
      count: summaries.reduce((n, m) => n + Number(m[2]), 0),
      errors: summaries.reduce((n, m) => n + Number(m[1]), 0),
      parser: "android",
    };
  }
  const warnings = lines.filter((l) => l.includes(": Warning: ")).length;
  const errors = lines.filter((l) => l.includes(": Error: ")).length;
  if (warnings + errors > 0) return { count: warnings, errors, parser: "android" };
  return {
    count: lines.filter((l) => /\bwarning\b/i.test(l) && !/\b0 warnings?\b/i.test(l)).length,
    errors: lines.filter((l) => /\berror\b/i.test(l) && !/\b0 errors?\b/i.test(l)).length,
    parser: "generic",
  };
}

const num = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? 0);

function parseSummaryLine(text: string, total: number, parser: string): TestCounts {
  return { total, failed: num(text, /(\d+) failed/), skipped: num(text, /(\d+) skipped/) + num(text, /(\d+) todo/), parser };
}

export function parseTests(raw: string): TestCounts | null {
  const text = raw.replace(ANSI_RE, "");
  const jest = [...text.matchAll(/^Tests:\s+(.*?(\d+) total)\s*$/gm)].at(-1);
  if (jest) return parseSummaryLine(jest[1] as string, Number(jest[2]), "jest");
  const vitest = [...text.matchAll(/^\s*Tests\s+(.*)\((\d+)\)\s*$/gm)].at(-1);
  if (vitest) return parseSummaryLine(vitest[1] as string, Number(vitest[2]), "vitest");
  const nodeTotal = [...text.matchAll(/^[#ℹ] tests (\d+)\s*$/gm)].at(-1);
  if (nodeTotal) {
    return { total: Number(nodeTotal[1]), failed: num(text, /^[#ℹ] fail (\d+)\s*$/m), skipped: num(text, /^[#ℹ] skipped (\d+)\s*$/m) + num(text, /^[#ℹ] todo (\d+)\s*$/m), parser: "node" };
  }
  const gradle = [...text.matchAll(/^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/gm)];
  if (gradle.length > 0) {
    const sum = (i: number) => gradle.reduce((n, m) => n + Number(m[i] ?? 0), 0);
    return { total: sum(1), failed: sum(2), skipped: sum(3), parser: "gradle" };
  }
  // Per-class lines carry "Time elapsed"; only the module totals count.
  const surefire = [...text.matchAll(/^.*Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)];
  if (surefire.length > 0) {
    const sum = (i: number) => surefire.reduce((n, m) => n + Number(m[i]), 0);
    return { total: sum(1), failed: sum(2) + sum(3), skipped: sum(4), parser: "junit" };
  }
  const found = /(\d+) tests found/.exec(text);
  if (found) return { total: Number(found[1]), failed: num(text, /(\d+) tests failed/), skipped: num(text, /(\d+) tests skipped/), parser: "junit" };
  return null;
}

/** Gradle stays silent when everything passes. Only files written by this run count: `sinceMs` rules out an up-to-date test. */
export function readJunitXml(repo: string, paths: readonly string[], sinceMs: number): TestCounts | null {
  const counts = { total: 0, failed: 0, skipped: 0, parser: "junit-xml" };
  let read = 0;
  for (const path of paths.filter(isJunitXml)) {
    const full = join(repo, path);
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st?.isFile() || st.mtimeMs < sinceMs) continue;
    const head = /<testsuite\b[^>]*>/.exec(readFileSync(full, "utf8"))?.[0];
    if (!head) continue;
    const attr = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(head)?.[1] ?? 0);
    counts.total += attr("tests");
    counts.failed += attr("failures") + attr("errors");
    counts.skipped += attr("skipped");
    read += 1;
  }
  return read > 0 ? counts : null;
}
