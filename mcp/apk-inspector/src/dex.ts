import { ApkError, type Deadline } from "./errors.js";

const NO_INDEX = 0xffffffff;
const MAX_STRING_BYTES = 1024 * 1024;

export interface DexClass {
  name: string;
  superclass: string | null;
  accessFlags: number;
  access: string[];
}

const ACCESS: [number, string][] = [
  [0x1, "public"],
  [0x2, "private"],
  [0x4, "protected"],
  [0x8, "static"],
  [0x10, "final"],
  [0x200, "interface"],
  [0x400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
];

export const accessNames = (flags: number): string[] => ACCESS.filter(([bit]) => (flags & bit) !== 0).map(([, n]) => n);

/** `Lcom/example/Foo;` becomes `com.example.Foo`. Array and primitive descriptors are left as written. */
export function descriptorToName(d: string): string {
  if (d.length > 2 && d[0] === "L" && d.endsWith(";")) return d.slice(1, -1).replace(/\//g, ".");
  return d;
}

/** Decodes modified UTF-8 (as used by DEX) into a JS string. Malformed bytes become U+FFFD. */
export function decodeMutf8(buf: Buffer, start: number, end: number): string {
  const units: number[] = [];
  let out = "";
  let i = start;
  const flush = (): void => {
    if (units.length) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  };
  while (i < end) {
    const a = buf[i++]!;
    if (a < 0x80) units.push(a);
    else if ((a & 0xe0) === 0xc0 && i < end) units.push(((a & 0x1f) << 6) | (buf[i++]! & 0x3f));
    else if ((a & 0xf0) === 0xe0 && i + 1 < end) {
      units.push(((a & 0x0f) << 12) | ((buf[i]! & 0x3f) << 6) | (buf[i + 1]! & 0x3f));
      i += 2;
    } else units.push(0xfffd);
    if (units.length >= 4096) flush();
  }
  flush();
  return out;
}

export class DexFile {
  readonly stringCount: number;
  readonly typeCount: number;
  readonly classCount: number;
  private readonly stringIdsOff: number;
  private readonly typeIdsOff: number;
  private readonly classDefsOff: number;

  constructor(
    readonly name: string,
    private readonly buf: Buffer,
    private readonly deadline: Deadline,
  ) {
    if (buf.length < 0x70) throw new ApkError(`${name}: file is too short to be a DEX`);
    if (buf.toString("latin1", 0, 4) !== "dex\n" || buf[7] !== 0) throw new ApkError(`${name}: bad DEX magic`);
    if (buf.readUInt32LE(40) !== 0x12345678) throw new ApkError(`${name}: unsupported DEX endianness`);
    this.stringCount = buf.readUInt32LE(56);
    this.stringIdsOff = buf.readUInt32LE(60);
    this.typeCount = buf.readUInt32LE(64);
    this.typeIdsOff = buf.readUInt32LE(68);
    this.classCount = buf.readUInt32LE(96);
    this.classDefsOff = buf.readUInt32LE(100);
    // Every table must fit inside the file: this also bounds the work for a hostile declared count.
    this.table("string_ids", this.stringCount, this.stringIdsOff, 4);
    this.table("type_ids", this.typeCount, this.typeIdsOff, 4);
    this.table("class_defs", this.classCount, this.classDefsOff, 32);
  }

  private table(label: string, count: number, off: number, entry: number): void {
    if (count === 0) return;
    if (off < 0x70 || off + count * entry > this.buf.length) throw new ApkError(`${this.name}: ${label} table lies outside the file (malformed DEX)`);
  }

  /** The string at `idx`, or null if its data offset is invalid. At most 1 MiB of it is decoded. */
  string(idx: number): string | null {
    if (idx < 0 || idx >= this.stringCount) return null;
    const dataOff = this.buf.readUInt32LE(this.stringIdsOff + idx * 4);
    if (dataOff >= this.buf.length) return null;
    let p = dataOff;
    // uleb128 utf16 length: skipped, we scan for the NUL terminator instead
    for (let n = 0; n < 5; n++) {
      if (p >= this.buf.length) return null;
      if ((this.buf[p++]! & 0x80) === 0) break;
    }
    const limit = Math.min(this.buf.length, p + MAX_STRING_BYTES);
    let e = p;
    while (e < limit && this.buf[e] !== 0) e++;
    return decodeMutf8(this.buf, p, e);
  }

  forEachString(cb: (s: string, index: number) => void): void {
    for (let i = 0; i < this.stringCount; i++) {
      this.deadline.tick();
      const s = this.string(i);
      if (s !== null) cb(s, i);
    }
  }

  typeName(typeIdx: number): string | null {
    if (typeIdx === NO_INDEX || typeIdx >= this.typeCount) return null;
    const sIdx = this.buf.readUInt32LE(this.typeIdsOff + typeIdx * 4);
    const s = this.string(sIdx);
    return s === null ? null : descriptorToName(s);
  }

  forEachClass(cb: (c: DexClass) => void): void {
    for (let i = 0; i < this.classCount; i++) {
      this.deadline.tick();
      const o = this.classDefsOff + i * 32;
      const name = this.typeName(this.buf.readUInt32LE(o));
      if (name === null) continue;
      const accessFlags = this.buf.readUInt32LE(o + 4);
      cb({ name, superclass: this.typeName(this.buf.readUInt32LE(o + 8)), accessFlags, access: accessNames(accessFlags) });
    }
  }
}

export const isDexName = (name: string): boolean => /^classes\d*\.dex$/.test(name);

/** Orders classes.dex, classes2.dex, classes3.dex, ... numerically. */
export function dexOrder(a: string, b: string): number {
  const n = (s: string): number => Number(/\d+/.exec(s)?.[0] ?? "1");
  return n(a) - n(b);
}

/** Share of classes whose simple name is 1-2 letters, a typical shrinker/obfuscator signature. */
export function obfuscationHint(classNames: string[]): { shortNameRatio: number; sampled: number; verdict: "unlikely" | "possible" | "likely" } {
  let short = 0;
  let sampled = 0;
  for (const full of classNames) {
    const simple = full.slice(Math.max(full.lastIndexOf("."), full.lastIndexOf("$")) + 1);
    if (simple === "" || /^\d+$/.test(simple)) continue; // anonymous classes say nothing
    sampled++;
    if (/^[A-Za-z]{1,2}$/.test(simple)) short++;
  }
  const ratio = sampled === 0 ? 0 : Math.round((short / sampled) * 1000) / 1000;
  return { shortNameRatio: ratio, sampled, verdict: ratio >= 0.3 ? "likely" : ratio >= 0.1 ? "possible" : "unlikely" };
}
