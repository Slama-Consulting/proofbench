import { createHash } from "node:crypto";
import type { Apk } from "./apk.js";
import { ApkError, LIMITS } from "./errors.js";
import { obfuscationHint, type DexClass } from "./dex.js";
import { MAX_PATTERN_CHARS, REGEX_INPUT_CHARS, assertSafeRegex } from "./regexsafe.js";
import { readManifest } from "./manifest.js";
import { NSC_PATH, readNetworkConfig } from "./netconfig.js";
import { SecretScanner, scanTextEntries } from "./secrets.js";
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

export function apkOverview(apk: Apk): object {
  const out: Record<string, unknown> = {};
  out["fileSize"] = apk.source.size;
  out["sha256"] = sha256OfFile(apk);
  out["entryCount"] = apk.zip.entries.length;

  try {
    const m = readManifest(apk);
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
    out["manifestError"] = errText(e);
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
  const { errors } = apk.forEachDex((dex) => {
    dex.forEachClass((c) => {
      classCount++;
      if (classNames.length < 200_000) classNames.push(c.name);
    });
  });
  out["classCount"] = classCount;
  out["obfuscation"] = obfuscationHint(classNames);
  if (errors.length) out["dexErrors"] = errors;
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

export function apkStrings(apk: Apk, o: { pattern?: string | undefined; regex: boolean; minLength: number; limit: number }): object {
  let test: (s: string) => boolean = () => true;
  if (o.pattern !== undefined && o.pattern !== "") {
    if (o.pattern.length > MAX_PATTERN_CHARS) throw new ApkError(`pattern is too long (limit ${MAX_PATTERN_CHARS} characters)`);
    if (o.regex) {
      const re = assertSafeRegex(o.pattern);
      test = (s) => re.test(s.length > REGEX_INPUT_CHARS ? s.slice(0, REGEX_INPUT_CHARS) : s);
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
