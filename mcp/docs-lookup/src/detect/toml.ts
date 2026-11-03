/** A deliberately small TOML reader: enough for version catalogs, pyproject.toml and Cargo.toml. */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

/** Keys that would reach Object.prototype if used on a plain object. Untrusted manifests may contain them. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Tables have no prototype, so a key can never resolve to an inherited member. */
function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

/** Net bracket/brace depth change of a line, ignoring quoted strings and comments. */
function depthDelta(line: string): number {
  let d = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") break;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return d;
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function splitKey(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  for (const c of s.trim()) {
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ".") {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

class ValueParser {
  private i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }

  parse(): TomlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.str();
    if (c === "[") return this.arr();
    if (c === "{") return this.tbl();
    const start = this.i;
    while (this.i < this.s.length && !/[\s,\]}]/.test(this.s[this.i]!)) this.i++;
    const raw = this.s.slice(start, this.i);
    if (raw === "true") return true;
    if (raw === "false") return false;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }

  private str(): string {
    const q = this.s[this.i++]!;
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === q) return out;
      if (c === "\\" && q === '"') out += this.s[this.i++] ?? "";
      else out += c;
    }
    return out;
  }

  private arr(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return out;
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.parse());
    }
  }

  private tbl(): TomlTable {
    this.i++;
    const out: TomlTable = newTable();
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return out;
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      let key = "";
      let quote = "";
      while (this.i < this.s.length) {
        const c = this.s[this.i]!;
        if (quote) {
          if (c === quote) quote = "";
          key += c;
        } else if (c === '"' || c === "'") {
          quote = c;
          key += c;
        } else if (c === "=") break;
        else key += c;
        this.i++;
      }
      this.i++;
      const value = this.parse();
      setPath(out, splitKey(key), value);
    }
  }
}

function setPath(root: TomlTable, path: string[], value: TomlValue): void {
  if (path.length === 0 || path.some((p) => FORBIDDEN_KEYS.has(p))) return;
  let cur = root;
  for (let k = 0; k < path.length - 1; k++) {
    const p = path[k]!;
    const next = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
    if (typeof next !== "object" || next === null || Array.isArray(next)) cur[p] = newTable();
    cur = cur[p] as TomlTable;
  }
  cur[path[path.length - 1]!] = value;
}

export function parseTomlValue(raw: string): TomlValue {
  return new ValueParser(raw).parse();
}

/** Parses the document into a flat map: section name -> table. Arrays of tables share their section name (last one wins). */
export function parseToml(text: string): Record<string, TomlTable> {
  const out: Record<string, TomlTable> = Object.create(null) as Record<string, TomlTable>;
  out[""] = newTable();
  let section = "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]!).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header && line.startsWith("[")) {
      const parts = splitKey(header[1]!);
      // A section named after a prototype member is dropped, and the keys below it go to a throwaway table.
      section = parts.some((p) => FORBIDDEN_KEYS.has(p)) ? "\u0000ignored" : parts.join(".");
      out[section] = newTable();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const keyRaw = line.slice(0, eq);
    let valueRaw = line.slice(eq + 1);
    let depth = depthDelta(valueRaw);
    while (depth > 0 && n + 1 < lines.length) {
      const next = stripComment(lines[++n]!);
      valueRaw += "\n" + next;
      depth += depthDelta(next);
    }
    setPath(out[section]!, splitKey(keyRaw), parseTomlValue(valueRaw.trim()));
  }
  return out;
}

export function asString(v: TomlValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asTable(v: TomlValue | undefined): TomlTable | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}

export function asStringArray(v: TomlValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
