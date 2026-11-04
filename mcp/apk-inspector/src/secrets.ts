import { collectXmlStrings, decodeAxml, isAxml } from "./axml.js";
import type { Apk } from "./apk.js";
import { LIMITS } from "./errors.js";

export type Confidence = "high" | "medium" | "low";

export interface Finding {
  type: string;
  maskedValue: string;
  location: string;
  confidence: Confidence;
}

export interface HostSummary {
  host: string;
  count: number;
  cleartext: boolean;
  /** Well-known XML namespace / schema hosts: usually not network endpoints. */
  likelyNamespace: boolean;
  samples: string[];
}

/** First characters, an ellipsis and the length. Never the whole value. */
export function mask(value: string): string {
  const keep = Math.max(1, Math.min(4, Math.floor(value.length / 2)));
  return `${value.slice(0, keep)}…[${value.length}]`;
}

interface Rule {
  type: string;
  re: RegExp;
  confidence: Confidence;
  /** Index of the capture group holding the secret (default: whole match). */
  group?: number;
}

// Every pattern is linear-time (no nested quantifiers) and scanned over bounded input.
const RULES: Rule[] = [
  { type: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, confidence: "high" },
  { type: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: "high" },
  { type: "firebase-database-url", re: /https:\/\/[a-z0-9-]{3,}(?:-default-rtdb)?(?:\.[a-z0-9-]+)?\.firebaseio\.com/g, confidence: "medium" },
  { type: "gcp-service-account-json", re: /"type"\s*:\s*"service_account"/g, confidence: "high" },
  { type: "private-key-pem", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, confidence: "high" },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, confidence: "medium" },
  { type: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, confidence: "high" },
  { type: "stripe-secret-key", re: /\b[sr]k_live_[0-9A-Za-z]{16,}/g, confidence: "high" },
  { type: "stripe-publishable-key", re: /\bpk_live_[0-9A-Za-z]{16,}/g, confidence: "low" },
  { type: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g, confidence: "high" },
  { type: "twilio-api-key", re: /\bSK[0-9a-f]{32}\b/g, confidence: "medium" },
  { type: "twilio-account-sid", re: /\bAC[0-9a-f]{32}\b/g, confidence: "low" },
  { type: "bearer-authorization", re: /Authorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, confidence: "medium", group: 1 },
  { type: "generic-secret-assignment", re: /(?:api[_-]?key|apikey|secret|passw(?:or)?d|token|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi, confidence: "low", group: 1 },
];

const URL_RE = /\b(https?|wss?):\/\/([^\s/@"'<>\\?#]+@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(?::(\d{1,5}))?([^\s"'<>\\)]*)/g;

const NAMESPACE_HOSTS = new Set([
  "schemas.android.com", "www.w3.org", "xmlpull.org", "www.xmlpull.org", "ns.adobe.com", "xml.org", "www.apache.org",
  "apache.org", "java.sun.com", "schemas.microsoft.com", "purl.org", "www.opengis.net", "localhost", "example.com", "www.example.com",
]);

/** Scans many strings and keeps findings and host summaries. */
export class SecretScanner {
  readonly findings: Finding[] = [];
  readonly hosts = new Map<string, HostSummary>();
  truncated = false;
  private readonly seen = new Set<string>();

  scan(text: string, location: string, big = false): void {
    if (text.length < 8) return;
    const cap = big ? LIMITS.maxTextScanBytes : 8192;
    const maxHits = big ? 500 : 20;
    const s = text.length > cap ? text.slice(0, cap) : text;
    for (const rule of RULES) {
      if (this.findings.length >= LIMITS.maxSecretFindings) {
        this.truncated = true;
        break;
      }
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = rule.re.exec(s)) !== null && guard++ < maxHits) {
        if (m[0].length === 0) rule.re.lastIndex++;
        const value = m[rule.group ?? 0] ?? m[0];
        this.add({ type: rule.type, maskedValue: mask(value), location, confidence: rule.confidence }, value);
      }
    }
    if (s.includes("://")) this.scanUrls(s, location, big ? 5000 : 50);
  }

  /** `value` only feeds the de-duplication key; it is never stored in a finding. */
  private add(f: Finding, value: string): void {
    const key = `${f.type}|${f.location}|${value}`;
    if (this.seen.has(key)) return;
    if (this.findings.length >= LIMITS.maxSecretFindings) {
      this.truncated = true;
      return;
    }
    this.seen.add(key);
    this.findings.push(f);
  }

  private scanUrls(s: string, location: string, maxHits: number): void {
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = URL_RE.exec(s)) !== null && guard++ < maxHits) {
      const scheme = m[1]!.toLowerCase();
      const host = m[3]!.toLowerCase().replace(/\.$/, "");
      if (m[2]) {
        this.add({ type: "url-with-credentials", maskedValue: mask(m[2].slice(0, -1)), location, confidence: "high" }, m[2]);
      }
      if (host.length < 3 || !/[a-z0-9]/.test(host)) continue;
      // Drop the query string and fragment: they often carry tokens.
      const path = (m[5] ?? "").split(/[?#]/)[0]!;
      const shown = `${scheme}://${host}${m[4] ? ":" + m[4] : ""}${path}`.slice(0, 200);
      let h = this.hosts.get(host);
      if (!h) {
        if (this.hosts.size >= 5000) {
          this.truncated = true;
          continue;
        }
        h = { host, count: 0, cleartext: false, likelyNamespace: NAMESPACE_HOSTS.has(host), samples: [] };
        this.hosts.set(host, h);
      }
      h.count++;
      if ((scheme === "http" || scheme === "ws") && !h.likelyNamespace) h.cleartext = true;
      if (h.samples.length < 5 && !h.samples.includes(shown)) h.samples.push(shown);
    }
  }
}

const TEXT_DIRS = /^(assets\/|res\/raw\/|res\/xml\/)/;
const MAX_TEXT_ENTRIES = 3000;
const MAX_TEXT_TOTAL = 64 * 1024 * 1024;

/** Scans small text-like entries (and decodes binary XML among them). */
export function scanTextEntries(apk: Apk, scanner: SecretScanner): { scanned: number; skipped: number } {
  let scanned = 0;
  let skipped = 0;
  let total = 0;
  for (const e of apk.zip.entries) {
    if (!TEXT_DIRS.test(e.name) || e.name.endsWith("/")) continue;
    apk.deadline.check();
    if (e.uncompressedSize === 0 || e.uncompressedSize > LIMITS.maxTextScanBytes || scanned >= MAX_TEXT_ENTRIES || total + e.uncompressedSize > MAX_TEXT_TOTAL) {
      skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = apk.zip.read(e, LIMITS.maxTextScanBytes);
    } catch {
      skipped++;
      continue;
    }
    total += buf.length;
    if (isAxml(buf)) {
      try {
        for (const s of collectXmlStrings(decodeAxml(buf))) scanner.scan(s, e.name);
        scanned++;
      } catch {
        skipped++;
      }
      continue;
    }
    const head = buf.subarray(0, Math.min(buf.length, 4096));
    if (head.includes(0)) {
      skipped++;
      continue;
    }
    scanner.scan(buf.toString("utf8"), e.name, true);
    scanned++;
  }
  return { scanned, skipped };
}

/** Replaces every secret-shaped value in `text` with its masked form. Used before showing raw file content. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(new RegExp(rule.re.source, rule.re.flags), (...args: unknown[]) => {
      const whole = args[0] as string;
      count++;
      const secret = rule.group === undefined ? undefined : (args[rule.group] as string | undefined);
      return secret === undefined ? mask(whole) : whole.replace(secret, () => mask(secret));
    });
  }
  out = out.replace(/\b(https?|wss?):\/\/([^\s/@"'<>\\?#]+)@/g, (_m, scheme: string, cred: string) => {
    count++;
    return `${scheme}://${mask(cred)}@`;
  });
  return { text: out, count };
}
