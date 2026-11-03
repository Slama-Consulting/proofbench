export type Json = Record<string, unknown>;

export function rec(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

const MAX_ADF_DEPTH = 40;
const BLOCKS = new Set(["paragraph", "heading", "blockquote", "panel", "expand", "nestedExpand", "mediaSingle", "mediaGroup"]);
const CELLS = new Set(["listItem", "tableCell", "tableHeader"]);

function inlineText(n: Json, depth: number): string {
  return arr(n.content)
    .map((c) => render(c, depth + 1))
    .join("");
}

function render(node: unknown, depth: number): string {
  const n = rec(node);
  if (!n || depth > MAX_ADF_DEPTH) return "";
  const type = str(n.type) ?? "";
  const attrs = rec(n.attrs) ?? {};
  switch (type) {
    case "text":
      return str(n.text) ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return str(attrs.text) ?? "@user";
    case "emoji":
      return str(attrs.text) ?? str(attrs.shortName) ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return str(attrs.url) ?? "";
    case "status":
      return str(attrs.text) ?? "";
    case "date": {
      const t = Number(attrs.timestamp);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
    }
    case "media":
    case "mediaInline":
      return "[attachment]";
    case "rule":
      return "---\n\n";
    case "codeBlock":
      return "```\n" + inlineText(n, depth) + "\n```\n\n";
    case "bulletList":
    case "orderedList": {
      const ordered = type === "orderedList";
      const lines = arr(n.content).map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${render(li, depth + 1).trim().replace(/\n/g, "\n  ")}`);
      return `${lines.join("\n")}\n\n`;
    }
    case "table": {
      const rows = arr(n.content).map((row) =>
        arr(rec(row)?.content)
          .map((cell) => render(cell, depth + 2).trim().replace(/\s*\n+\s*/g, " "))
          .join(" | "),
      );
      return `${rows.join("\n")}\n\n`;
    }
    default:
      if (BLOCKS.has(type)) return `${inlineText(n, depth)}\n\n`;
      if (CELLS.has(type)) return inlineText(n, depth);
      return inlineText(n, depth);
  }
}

/** Atlassian Document Format to plain text. A plain string (Jira v2 wiki text) passes through unchanged. */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!rec(value)) return "";
  return render(value, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
