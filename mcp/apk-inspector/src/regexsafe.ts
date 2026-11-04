import { ApkError } from "./errors.js";

export const MAX_PATTERN_CHARS = 200;
/** Regex input is truncated to this many characters per string to bound the work. */
export const REGEX_INPUT_CHARS = 512;
const MAX_UNBOUNDED = 3;

/**
 * Rejects patterns that can backtrack catastrophically. This is a conservative syntactic check, not a proof:
 * it forbids backreferences, quantified groups that themselves contain a quantifier or an alternation,
 * and more than a few unbounded quantifiers. The input is also truncated by the caller.
 */
export function assertSafeRegex(pattern: string, ignoreCase = false): RegExp {
  if (pattern.length > MAX_PATTERN_CHARS) throw new ApkError(`pattern is too long (limit ${MAX_PATTERN_CHARS} characters)`);
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "iu" : "u");
  } catch {
    // JavaScript has no inline flag groups such as (?i): say so instead of a bare "invalid".
    if (/^\(\?[a-z]+(?:-[a-z]+)?\)/.test(pattern)) throw new ApkError("regular expression rejected: inline flags such as (?i) are not supported; use the ignoreCase parameter");
    throw new ApkError("invalid regular expression");
  }
  const groups: { quant: boolean; alt: boolean }[] = [];
  let unbounded = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      if (/[1-9]/.test(n) || (n === "k" && pattern[i + 2] === "<")) throw new ApkError("regular expression rejected: backreferences are not allowed");
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      groups.push({ quant: false, alt: false });
      continue;
    }
    if (c === "|") {
      const g = groups[groups.length - 1];
      if (g) g.alt = true;
      continue;
    }
    const isUnbounded = c === "*" || c === "+" || (c === "{" && /^\{\d+,\}/.test(pattern.slice(i)));
    if (isUnbounded) {
      unbounded++;
      if (unbounded > MAX_UNBOUNDED) throw new ApkError(`regular expression rejected: more than ${MAX_UNBOUNDED} unbounded quantifiers`);
      const g = groups[groups.length - 1];
      if (g) g.quant = true;
      continue;
    }
    if (c === ")") {
      const g = groups.pop();
      if (!g) continue;
      const next = pattern[i + 1] ?? "";
      const quantified = next === "*" || next === "+" || (next === "{" && /^\{\d+,\d*\}/.test(pattern.slice(i + 1)));
      if (quantified && (g.quant || g.alt)) throw new ApkError("regular expression rejected: a quantified group containing a quantifier or alternation can cause catastrophic backtracking");
      const parent = groups[groups.length - 1];
      if (parent) {
        parent.quant ||= g.quant;
        parent.alt ||= g.alt;
      }
    }
  }
  return re;
}
