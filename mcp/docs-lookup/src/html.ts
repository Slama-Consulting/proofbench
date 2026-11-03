/** Very small HTML-to-Markdown-ish converter for README pages rendered by registries. Output is plain text, never executed. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e: string) => {
    if (e in ENTITIES) return ENTITIES[e]!;
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : e.startsWith("#") ? Number.parseInt(e.slice(1), 10) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => "\n```\n" + code.replace(/<[^>]+>/g, "") + "\n```\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/(p|div|ul|ol|table|tr|blockquote)>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => "`" + t.replace(/<[^>]+>/g, "") + "`");
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
