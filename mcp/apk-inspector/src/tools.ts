import { createHash } from "node:crypto";
import type { Apk } from "./apk.js";
import { ApkError, LIMITS } from "./errors.js";
import { decodeAxml, isAxml, type XmlNode } from "./axml.js";
import { obfuscationHint, type DexClass } from "./dex.js";
import { MAX_PATTERN_CHARS, REGEX_INPUT_CHARS, assertSafeRegex } from "./regexsafe.js";
import { readManifest, type ManifestInfo } from "./manifest.js";
import { releaseReadiness } from "./release.js";
import { NSC_PATH, readNetworkConfig } from "./netconfig.js";
import { SecretScanner, redactSecrets, scanTextEntries } from "./secrets.js";
import { readSignatures, signingSchemes } from "./signature.js";

function sha256OfFile(apk: Apk): string {
  const h = createHash("sha256");
  const size = apk.source.size;
  for (let pos = 0; pos < size; pos += 1024 * 1024) {
    apk.deadline.check();
    h.update(apk.source.read(pos, Math.min(1024 * 1024, size - pos)));
  }
  return h.digest("hex");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Debug-only libraries that are worth a second look in a shipped build. */
const DEBUG_TOOLING: [prefix: string, label: string][] = [
  ["leakcanary.", "LeakCanary"],
  ["com.squareup.leakcanary.", "LeakCanary"],
  ["com.facebook.stetho.", "Stetho"],
  ["com.facebook.flipper.", "Flipper"],
  ["com.chuckerteam.chucker.", "Chucker"],
];

export function apkOverview(apk: Apk): object {
  const out: Record<string, unknown> = {};
  out["fileSize"] = apk.source.size;
  out["sha256"] = sha256OfFile(apk);
  out["entryCount"] = apk.zip.entries.length;

  let manifest: ManifestInfo | undefined;
  let manifestError: string | undefined;
  try {
    const m = readManifest(apk);
    manifest = m;
    out["package"] = m.package;
    out["versionName"] = m.versionName;
    out["versionCode"] = m.versionCode;
    out["minSdk"] = m.sdk.min;
    out["targetSdk"] = m.sdk.target;
    out["compileSdk"] = m.sdk.compile;
    out["debuggable"] = m.application.debuggable;
    out["allowBackup"] = m.application.allowBackup;
    out["usesCleartextTraffic"] = m.application.usesCleartextTraffic;
    out["permissionCount"] = m.permissions.length;
    out["dangerousPermissionCount"] = m.permissions.filter((p) => p.risk === "dangerous").length;
    const count = (k: string): number => m.components.filter((c) => c.kind === k).length;
    out["componentCounts"] = { activities: count("activity") + count("activity-alias"), services: count("service"), receivers: count("receiver"), providers: count("provider"), exported: m.components.filter((c) => c.exported).length };
  } catch (e) {
    manifestError = errText(e);
    out["manifestError"] = manifestError;
  }
  out["networkSecurityConfigPresent"] = apk.zip.byName.has(NSC_PATH);

  const dexInfo = apk.dexEntries().map((e) => ({ name: e.name, size: e.uncompressedSize }));
  out["dexFiles"] = dexInfo;
  const abis = new Set<string>();
  for (const e of apk.zip.entries) {
    const m = /^lib\/([^/]+)\/[^/]+$/.exec(e.name);
    if (m) abis.add(m[1]!);
  }
  out["nativeAbis"] = [...abis].sort();
  out["signingSchemes"] = signingSchemes(apk.zip);

  const classNames: string[] = [];
  let classCount = 0;
  let testClasses = 0;
  let jacocoClasses = 0;
  const tooling = new Set<string>();
  const { errors } = apk.forEachDex((dex) => {
    dex.forEachClass((c) => {
      classCount++;
      if (classNames.length < 200_000) classNames.push(c.name);
      if (c.name.startsWith("androidx.test.")) testClasses++;
      else if (c.name.startsWith("org.jacoco.")) jacocoClasses++;
      else {
        const t = DEBUG_TOOLING.find(([prefix]) => c.name.startsWith(prefix));
        if (t) tooling.add(t[1]);
      }
    });
  });
  out["classCount"] = classCount;
  const obfuscation = obfuscationHint(classNames);
  out["obfuscation"] = obfuscation;
  if (errors.length) out["dexErrors"] = errors;
  out["releaseReadiness"] = releaseReadiness(apk, { manifest, manifestError, testClasses, jacocoClasses, debugToolingClasses: [...tooling].sort(), obfuscationVerdict: obfuscation.verdict });
  return out;
}

export function apkManifest(apk: Apk): object {
  return readManifest(apk);
}

export interface EntryRow {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: string;
  unusual?: string[];
}

const METHODS: Record<number, string> = { 0: "stored", 8: "deflate" };

export function apkEntries(apk: Apk, filter: string | undefined, limit: number): object {
  const dexCount = apk.dexEntries().length;
  const f = filter?.toLowerCase();
  const rows: EntryRow[] = [];
  let matched = 0;
  const unusualAll: { name: string; reasons: string[] }[] = [];
  for (const e of apk.zip.entries) {
    apk.deadline.tick();
    const reasons: string[] = [];
    if (/^classes\d*\.dex$/.test(e.name) && dexCount > 8) reasons.push(`one of ${dexCount} dex files (unusually many)`);
    if (/^classes\d*\.dex$/.test(e.name) === false && /\.dex$/i.test(e.name)) reasons.push("dex file outside the root classesN.dex naming");
    if (/\.dex$/i.test(e.name) === false && !e.name.endsWith("/") && e.uncompressedSize >= 4 && /^(assets\/|res\/raw\/)/.test(e.name)) {
      const head = apk.zip.peek(e, 4);
      if (head.length >= 4) {
        if (head.toString("latin1") === "dex\n") reasons.push("contains DEX magic (hidden executable code)");
        else if (head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF") reasons.push("contains ELF magic (native binary outside lib/)");
        else if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) reasons.push("contains a nested ZIP/APK");
      }
    }
    if (/^assets\//.test(e.name) && /\.(apk|jar|dex|so|zip)$/i.test(e.name) && reasons.length === 0) reasons.push(`executable-looking file extension in assets/`);
    if (/^lib\/[^/]+\/[^/]*\.so$/.test(e.name)) {
      const head = apk.zip.peek(e, 4);
      if (head.length >= 4 && !(head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF")) reasons.push(".so file without ELF magic");
    }
    if (reasons.length) unusualAll.push({ name: e.name, reasons });
    if (f && !e.name.toLowerCase().includes(f)) continue;
    matched++;
    if (rows.length < limit) {
      const row: EntryRow = { name: e.name, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize, method: METHODS[e.method] ?? `method-${e.method}` };
      if (reasons.length) row.unusual = reasons;
      rows.push(row);
    }
  }
  return { total: apk.zip.entries.length, matched, returned: rows.length, truncated: matched > rows.length, entries: rows, unusualEntries: unusualAll.slice(0, 200), unusualCount: unusualAll.length };
}

export function apkStrings(apk: Apk, o: { pattern?: string | undefined; regex: boolean; ignoreCase?: boolean; minLength: number; limit: number }): object {
  let test: (s: string) => boolean = () => true;
  if (o.pattern !== undefined && o.pattern !== "") {
    if (o.pattern.length > MAX_PATTERN_CHARS) throw new ApkError(`pattern is too long (limit ${MAX_PATTERN_CHARS} characters)`);
    if (o.regex) {
      const re = assertSafeRegex(o.pattern, o.ignoreCase === true);
      test = (s) => re.test(s.length > REGEX_INPUT_CHARS ? s.slice(0, REGEX_INPUT_CHARS) : s);
    } else if (o.ignoreCase) {
      const needle = o.pattern.toLowerCase();
      test = (s) => s.toLowerCase().includes(needle);
    } else {
      const needle = o.pattern;
      test = (s) => s.includes(needle);
    }
  }
  const results: { string: string; truncated?: boolean; dex: string; index: number }[] = [];
  let matched = 0;
  let scanned = 0;
  const { errors } = apk.forEachDex((dex) => {
    dex.forEachString((s, index) => {
      scanned++;
      if (s.length < o.minLength) return;
      if (!test(s)) return;
      matched++;
      if (results.length < o.limit) {
        const r: (typeof results)[number] = { string: s.length > LIMITS.maxStringChars ? s.slice(0, LIMITS.maxStringChars) : s, dex: dex.name, index };
        if (s.length > LIMITS.maxStringChars) r.truncated = true;
        results.push(r);
      }
    });
  });
  return { scanned, matched, returned: results.length, truncated: matched > results.length, strings: results, ...(errors.length ? { dexErrors: errors } : {}) };
}

export function apkClasses(apk: Apk, o: { pattern?: string | undefined; limit: number }): object {
  const needle = o.pattern?.toLowerCase();
  const rows: { name: string; superclass: string | null; accessFlags: number; access: string[]; dex: string }[] = [];
  const prefixes = new Map<string, number>();
  let total = 0;
  let matched = 0;
  const { errors } = apk.forEachDex((dex) => {
    dex.forEachClass((c: DexClass) => {
      total++;
      const parts = c.name.split(".");
      const prefix = parts.length > 2 ? parts.slice(0, 2).join(".") : parts.length === 2 ? parts[0]! : "(default package)";
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      if (needle && !c.name.toLowerCase().includes(needle)) return;
      matched++;
      if (rows.length < o.limit) rows.push({ ...c, dex: dex.name });
    });
  });
  const topPackagePrefixes = [...prefixes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25).map(([prefix, count]) => ({ prefix, count }));
  return { total, matched, returned: rows.length, truncated: matched > rows.length, classes: rows, topPackagePrefixes, ...(errors.length ? { dexErrors: errors } : {}) };
}

export function apkSignature(apk: Apk): object {
  return readSignatures(apk.zip);
}

export function apkFindSecrets(apk: Apk): object {
  const scanner = new SecretScanner();
  const { errors } = apk.forEachDex((dex) => {
    dex.forEachString((s) => scanner.scan(s, dex.name));
  });
  const text = scanTextEntries(apk, scanner);
  const order = { high: 0, medium: 1, low: 2 } as const;
  const findings = [...scanner.findings].sort((a, b) => order[a.confidence] - order[b.confidence]);
  const hosts = [...scanner.hosts.values()].sort((a, b) => b.count - a.count).slice(0, 200);
  const countBy: Record<string, number> = {};
  for (const f of findings) countBy[f.type] = (countBy[f.type] ?? 0) + 1;
  return {
    note: "Every match is a lead, not proof that a secret is live or valid. Values are masked (first characters and length only); the full value is never returned.",
    findings,
    findingCountsByType: countBy,
    hosts,
    cleartextHosts: hosts.filter((h) => h.cleartext).map((h) => h.host),
    textEntriesScanned: text.scanned,
    textEntriesSkipped: text.skipped,
    truncated: scanner.truncated,
    ...(errors.length ? { dexErrors: errors } : {}),
  };
}

export function apkNetworkConfig(apk: Apk): object {
  return readNetworkConfig(apk);
}

const MAX_XML_NODES = 5000;

interface TreeBudget {
  nodes: number;
  truncated: boolean;
}

function cutText(v: string | number | boolean): string | number | boolean {
  return typeof v === "string" && v.length > LIMITS.maxStringChars ? v.slice(0, LIMITS.maxStringChars) : v;
}

function copyTree(n: XmlNode, b: TreeBudget): XmlNode {
  b.nodes++;
  const out: XmlNode = { name: n.name, attrs: {}, children: [] };
  for (const [k, v] of Object.entries(n.attrs)) out.attrs[k] = cutText(v);
  if (n.text !== undefined) out.text = String(cutText(n.text));
  for (const c of n.children) {
    if (b.nodes >= MAX_XML_NODES) {
      b.truncated = true;
      break;
    }
    out.children.push(copyTree(c, b));
  }
  return out;
}

const rulePairs = (n: XmlNode, tag: "include" | "exclude"): { domain?: string; path?: string }[] =>
  n.children
    .filter((c) => c.name === tag)
    .map((c) => {
      const r: { domain?: string; path?: string } = {};
      if (c.attrs["domain"] !== undefined) r.domain = String(c.attrs["domain"]);
      if (c.attrs["path"] !== undefined) r.path = String(c.attrs["path"]);
      return r;
    });

const BACKUP_NOTE = "Rules are listed as written, not evaluated. See the Android documentation for how include and exclude combine.";

function backupSummary(root: XmlNode): object | undefined {
  if (root.name === "full-backup-content") return { kind: "full-backup-content", includes: rulePairs(root, "include"), excludes: rulePairs(root, "exclude"), note: BACKUP_NOTE };
  if (root.name !== "data-extraction-rules") return undefined;
  const out: Record<string, unknown> = { kind: "data-extraction-rules", note: BACKUP_NOTE };
  const cloud = root.children.find((c) => c.name === "cloud-backup");
  if (cloud) {
    const section: Record<string, unknown> = { includes: rulePairs(cloud, "include"), excludes: rulePairs(cloud, "exclude") };
    const d = cloud.attrs["disableIfNoEncryptionCapabilities"];
    if (d !== undefined) section["disableIfNoEncryptionCapabilities"] = d === true || d === "true";
    out["cloudBackup"] = section;
  }
  const transfer = root.children.find((c) => c.name === "device-transfer");
  if (transfer) out["deviceTransfer"] = { includes: rulePairs(transfer, "include"), excludes: rulePairs(transfer, "exclude") };
  return out;
}

export function apkXml(apk: Apk, entry: string): object {
  const buf = apk.readEntry(entry);
  if (!isAxml(buf)) throw new ApkError(`entry is not binary XML (use apk_asset_peek to look at it): ${entry}`);
  let root: XmlNode;
  try {
    root = decodeAxml(buf);
  } catch (e) {
    throw e instanceof ApkError ? e : new ApkError(`entry is not a valid binary XML document: ${entry}`);
  }
  const budget: TreeBudget = { nodes: 0, truncated: false };
  const tree = copyTree(root, budget);
  const backupRules = backupSummary(root);
  return { entry, root: root.name, nodeCount: budget.nodes, truncated: budget.truncated, tree, ...(backupRules ? { backupRules } : {}) };
}

type AssetKind = "empty" | "dex" | "elf" | "zip" | "png" | "jpeg" | "gif" | "pdf" | "binary-xml" | "json" | "xml" | "text" | "binary";

const startsWith = (b: Buffer, bytes: number[]): boolean => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);

function utf8Text(b: Buffer): string | null {
  if (b.includes(0)) return null;
  // The prefix may cut a multi-byte character: tolerate up to 3 dangling bytes.
  for (let cut = 0; cut <= 3 && cut < b.length; cut++) {
    try {
      const t = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, b.length - cut));
      let control = 0;
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
      }
      return control / Math.max(1, t.length) < 0.05 ? t : null;
    } catch {
      // try again with one byte fewer
    }
  }
  return null;
}

function sniff(b: Buffer): { kind: AssetKind; text: string | null } {
  if (b.length === 0) return { kind: "empty", text: null };
  if (b.toString("latin1", 0, 4) === "dex\n") return { kind: "dex", text: null };
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return { kind: "elf", text: null };
  if (startsWith(b, [0x50, 0x4b, 3, 4])) return { kind: "zip", text: null };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { kind: "png", text: null };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: "jpeg", text: null };
  if (b.toString("latin1", 0, 4) === "GIF8") return { kind: "gif", text: null };
  if (b.toString("latin1", 0, 4) === "%PDF") return { kind: "pdf", text: null };
  if (isAxml(b)) return { kind: "binary-xml", text: null };
  const text = utf8Text(b);
  if (text === null) return { kind: "binary", text: null };
  const first = text.trimStart()[0];
  return { kind: first === "{" || first === "[" ? "json" : first === "<" ? "xml" : "text", text };
}

export function apkAssetPeek(apk: Apk, entry: string, bytes: number): object {
  const e = apk.zip.get(entry);
  if (!e || entry.endsWith("/")) throw new ApkError(`entry not found: ${entry}`);
  const base = { entry, size: e.uncompressedSize, compressedSize: e.compressedSize, method: e.method === 0 ? "stored" : e.method === 8 ? "deflate" : `method-${e.method}` };
  if (e.uncompressedSize === 0) return { ...base, kind: "empty", returnedBytes: 0 };
  const head = apk.zip.peek(e, bytes);
  if (head.length === 0) throw new ApkError(`entry could not be read (encrypted or unsupported compression): ${entry}`);
  const { kind, text } = sniff(head);
  const out: Record<string, unknown> = { ...base, kind, returnedBytes: head.length, truncated: e.uncompressedSize > head.length };
  if (text !== null) {
    const red = redactSecrets(text);
    out["preview"] = red.text;
    out["redactedSecrets"] = red.count;
  } else {
    out["hexPreview"] = head.toString("hex").replace(/(..)/g, "$1 ").trim();
  }
  return out;
}
