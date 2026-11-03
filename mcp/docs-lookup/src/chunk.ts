/** Heading-based chunking and a small BM25-style ranking. No dependencies, no network. */

export const MAX_CHUNK_CHARS = 1500;

export interface Chunk {
  /** Heading path, e.g. "Install > Gradle". Empty for text before the first heading. */
  heading: string;
  text: string;
  /** Position in the document order (stable tie-break). */
  order: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ADOC_HEADING = /^(={1,6})\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

interface Section {
  path: string[];
  lines: string[];
}

function splitSections(text: string, adoc: boolean): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let cur: Section = { path: [], lines: [] };
  let inFence = false;
  let inAdocBlock = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (adoc && /^(----|\.\.\.\.)\s*$/.test(line)) inAdocBlock = !inAdocBlock;
    const m = !inFence && !inAdocBlock ? (adoc ? ADOC_HEADING.exec(line) : HEADING.exec(line)) : null;
    if (m) {
      sections.push(cur);
      const level = m[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: m[2]!.replace(/[*_`]/g, "").trim() });
      cur = { path: stack.map((s) => s.title), lines: [line] };
    } else cur.lines.push(line);
  }
  sections.push(cur);
  return sections;
}

/** Splits an over-long block on blank lines (outside code fences), then on lines, then hard. */
function splitLong(text: string, max: number): string[] {
  const paragraphs: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    buf.push(line);
    if (!inFence && line.trim() === "") {
      paragraphs.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length) paragraphs.push(buf.join("\n"));
  const out: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const p of paragraphs) {
    if (p.length > max) {
      flush();
      let piece = "";
      for (const line of p.split("\n")) {
        if (line.length > max) {
          if (piece.trim()) out.push(piece.trim());
          piece = "";
          for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
        } else if (piece.length + line.length + 1 > max) {
          if (piece.trim()) out.push(piece.trim());
          piece = line + "\n";
        } else piece += line + "\n";
      }
      if (piece.trim()) out.push(piece.trim());
    } else if (cur.length + p.length + 1 > max) {
      flush();
      cur = p + "\n";
    } else cur += p + "\n";
  }
  flush();
  return out;
}

export function chunkText(text: string, opts: { adoc?: boolean; maxChars?: number } = {}): Chunk[] {
  const max = opts.maxChars ?? MAX_CHUNK_CHARS;
  const chunks: Chunk[] = [];
  let order = 0;
  for (const s of splitSections(text, opts.adoc === true)) {
    const body = s.lines.join("\n").trim();
    // A heading with nothing under it (its children carry the content) is not worth a chunk.
    if (!(s.path.length ? s.lines.slice(1) : s.lines).join("").trim()) continue;
    const heading = s.path.join(" > ");
    const pieces = body.length <= max ? [body] : splitLong(body, max);
    for (const piece of pieces) {
      if (piece.trim()) chunks.push({ heading, text: piece, order: order++ });
    }
  }
  return chunks;
}

// ------------------------------------------------------------------ ranking

const STOP_WORDS = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its of on or so such that the their then there these this to use used using was what when where which who why will with without you your should would could not no yes").split(" "),
);

function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  return t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t;
}

/** Lower-cased tokens; identifiers (camelCase, snake_case, dotted) also contribute their parts. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_$.-]*[A-Za-z0-9_$]/g) ?? []) {
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_.$-]+/).map((p) => p.toLowerCase()).filter(Boolean);
    const whole = raw.toLowerCase().replace(/[$]/g, "");
    if (parts.length > 1 && whole.length > 2 && !STOP_WORDS.has(whole)) out.push(stem(whole));
    for (const p of parts) if (p.length > 1 && !STOP_WORDS.has(p)) out.push(stem(p));
  }
  return out;
}

const HEADING_WEIGHT = 4;
const CODE_WEIGHT = 1.5;

function weightedTerms(chunk: Chunk): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (tokens: string[], w: number): void => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + w);
  };
  add(tokenize(chunk.heading), HEADING_WEIGHT);
  let inFence = false;
  const prose: string[] = [];
  const code: string[] = [];
  for (const line of chunk.text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) code.push(line);
    else {
      prose.push(line);
      for (const m of line.matchAll(/`([^`]+)`/g)) code.push(m[1]!);
    }
  }
  add(tokenize(prose.join("\n")), 1);
  add(tokenize(code.join("\n")), CODE_WEIGHT);
  return tf;
}

export interface Ranked<T extends Chunk> {
  chunk: T;
  score: number;
}

/** BM25 over the weighted term frequencies. Chunks with no query term score 0. */
export function rank<T extends Chunk>(chunks: T[], query: string): Ranked<T>[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return chunks.map((chunk) => ({ chunk, score: 0 }));
  const docs = chunks.map((c) => {
    const tf = weightedTerms(c);
    let len = 0;
    for (const n of tf.values()) len += n;
    return { c, tf, len };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, docs.filter((d) => d.tf.has(term)).length);
  const k1 = 1.2;
  const b = 0.75;
  const phrase = query.trim().toLowerCase();
  const ranked = docs.map((d) => {
    let score = 0;
    for (const term of q) {
      const f = d.tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg));
    }
    if (score > 0 && phrase.length > 3 && d.c.heading.toLowerCase().includes(phrase)) score *= 1.5;
    return { chunk: d.c, score };
  });
  return ranked.sort((x, y) => y.score - x.score || x.chunk.order - y.chunk.order);
}
