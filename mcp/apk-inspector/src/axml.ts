import { ApkError } from "./errors.js";

/** A decoded element of an Android binary XML (AXML) document. */
export interface XmlNode {
  name: string;
  /** Attributes keyed `android:name` (framework namespace) or `name`. */
  attrs: Record<string, string | number | boolean>;
  children: XmlNode[];
  /** Concatenated character data, if any. */
  text?: string;
}

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const MAX_DEPTH = 128;
const MAX_NODES = 200_000;
const MAX_STRINGS = 2_000_000;

/** Framework attribute resource ids, used when the attribute name was stripped from the string pool. */
const ATTR_IDS: Record<number, string> = {
  0x01010000: "theme",
  0x01010001: "label",
  0x01010002: "icon",
  0x01010003: "name",
  0x01010006: "permission",
  0x01010007: "readPermission",
  0x01010008: "writePermission",
  0x0101000c: "hasCode",
  0x0101000e: "enabled",
  0x0101000f: "debuggable",
  0x01010010: "exported",
  0x01010011: "process",
  0x01010012: "taskAffinity",
  0x01010018: "authorities",
  0x0101001b: "grantUriPermissions",
  0x0101001d: "launchMode",
  0x01010026: "mimeType",
  0x01010027: "scheme",
  0x01010028: "host",
  0x01010029: "port",
  0x0101002a: "path",
  0x0101002b: "pathPrefix",
  0x0101002c: "pathPattern",
  0x0101020c: "minSdkVersion",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x01010270: "targetSdkVersion",
  0x01010271: "maxSdkVersion",
  0x01010280: "allowBackup",
  0x01010281: "glEsVersion",
  0x0101028e: "required",
  0x010104ea: "extractNativeLibs",
  0x010104ec: "usesCleartextTraffic",
  0x01010527: "networkSecurityConfig",
  0x01010572: "compileSdkVersion",
  0x01010573: "compileSdkVersionCodename",
  0x01010603: "requestLegacyExternalStorage",
};

const hex8 = (n: number): string => "0x" + (n >>> 0).toString(16).padStart(8, "0");

function decodeStringPool(buf: Buffer, off: number, chunkSize: number): string[] {
  if (chunkSize < 28 || off + chunkSize > buf.length) throw new ApkError("string pool is truncated");
  const headerSize = buf.readUInt16LE(off + 2);
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  if (count > MAX_STRINGS || headerSize < 28 || headerSize + count * 4 > chunkSize) throw new ApkError("string pool declares more strings than it can hold");
  if (stringsStart > chunkSize) throw new ApkError("string pool data offset is out of range");
  const utf8 = (flags & 0x100) !== 0;
  const end = off + chunkSize;
  const out: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const rel = buf.readUInt32LE(off + headerSize + i * 4);
    let p = off + stringsStart + rel;
    if (rel >= chunkSize || p >= end) {
      out[i] = "";
      continue;
    }
    try {
      if (utf8) {
        let b = buf[p++];
        if (b === undefined) throw new Error("oob");
        if (b & 0x80) p++; // utf16 length (1 or 2 bytes), not needed
        b = buf[p++];
        if (b === undefined) throw new Error("oob");
        let len = b;
        if (b & 0x80) len = ((b & 0x7f) << 8) | buf[p++]!;
        if (p + len > end) throw new Error("oob");
        out[i] = buf.toString("utf8", p, p + len);
      } else {
        let len = buf.readUInt16LE(p);
        p += 2;
        if (len & 0x8000) {
          len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
          p += 2;
        }
        if (p + len * 2 > end) throw new Error("oob");
        out[i] = buf.toString("utf16le", p, p + len * 2);
      }
    } catch {
      out[i] = "";
    }
  }
  return out;
}

function typedValue(pool: string[], rawIdx: number, dataType: number, data: number): string | number | boolean {
  switch (dataType) {
    case 0x03:
      return pool[data] ?? "";
    case 0x12:
      return data !== 0;
    case 0x10:
      return data | 0;
    case 0x11:
      return data >>> 0;
    case 0x01:
      return "@" + hex8(data);
    case 0x02:
      return "?" + hex8(data);
    case 0x04: {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(data >>> 0);
      return b.readFloatLE(0);
    }
    case 0x05: // dimension
    case 0x06: // fraction
      return hex8(data);
    case 0x1c:
    case 0x1d:
    case 0x1e:
    case 0x1f:
      return "#" + (data >>> 0).toString(16).padStart(8, "0");
    case 0x00:
      return rawIdx >= 0 ? (pool[rawIdx] ?? "") : "";
    default:
      return rawIdx >= 0 && pool[rawIdx] !== undefined ? pool[rawIdx]! : hex8(data);
  }
}

/** Decodes an Android binary XML document into a tree. Throws ApkError on any malformed input. */
export function decodeAxml(buf: Buffer): XmlNode {
  if (buf.length < 8) throw new ApkError("binary XML is too short");
  if (buf.readUInt16LE(0) !== 0x0003) throw new ApkError("not an Android binary XML document (bad magic)");
  const total = Math.min(buf.readUInt32LE(4), buf.length);
  let pool: string[] = [];
  let resMap: number[] = [];
  const nsPrefix = new Map<string, string>();
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;

  const nameOf = (idx: number): string => (idx >= 0 && idx < pool.length ? (pool[idx] ?? "") : "");

  let off = buf.readUInt16LE(2);
  while (off + 8 <= total) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || headerSize < 8 || headerSize > size || off + size > total) throw new ApkError("binary XML chunk is malformed (size out of range)");
    switch (type) {
      case 0x0001:
        pool = decodeStringPool(buf, off, size);
        break;
      case 0x0180: {
        const n = Math.floor((size - headerSize) / 4);
        resMap = [];
        for (let i = 0; i < n; i++) resMap.push(buf.readUInt32LE(off + headerSize + i * 4));
        break;
      }
      case 0x0100: {
        if (size >= 24) nsPrefix.set(nameOf(buf.readInt32LE(off + 20)), nameOf(buf.readInt32LE(off + 16)));
        break;
      }
      case 0x0102: {
        if (size < 36) throw new ApkError("start element chunk is too short");
        if (++nodes > MAX_NODES) throw new ApkError("binary XML has too many elements");
        if (stack.length >= MAX_DEPTH) throw new ApkError("binary XML is nested too deeply");
        const base = off + 16;
        const nameIdx = buf.readInt32LE(base + 4);
        const attrStart = buf.readUInt16LE(base + 8);
        const attrSize = buf.readUInt16LE(base + 10);
        const attrCount = buf.readUInt16LE(base + 12);
        if (attrSize < 20 || base + attrStart + attrCount * attrSize > off + size) throw new ApkError("element attributes run past the chunk");
        const node: XmlNode = { name: nameOf(nameIdx), attrs: {}, children: [] };
        for (let i = 0; i < attrCount; i++) {
          const a = base + attrStart + i * attrSize;
          const ns = buf.readInt32LE(a);
          const nIdx = buf.readInt32LE(a + 4);
          const raw = buf.readInt32LE(a + 8);
          const dType = buf.readUInt8(a + 15);
          const data = buf.readUInt32LE(a + 16);
          let name = nameOf(nIdx);
          if (name === "" && nIdx >= 0 && nIdx < resMap.length) name = ATTR_IDS[resMap[nIdx]!] ?? "attr_" + hex8(resMap[nIdx]!);
          const nsUri = ns >= 0 ? nameOf(ns) : "";
          const prefix = nsUri === ANDROID_NS ? "android" : nsUri ? (nsPrefix.get(nsUri) ?? "") : "";
          const key = prefix ? `${prefix}:${name}` : name;
          node.attrs[key === "__proto__" ? "_proto_" : key] = typedValue(pool, raw, dType, data);
        }
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else if (!root) root = node;
        else throw new ApkError("binary XML has more than one root element");
        stack.push(node);
        break;
      }
      case 0x0103:
        if (stack.length === 0) throw new ApkError("unbalanced end element in binary XML");
        stack.pop();
        break;
      case 0x0104: {
        const cur = stack[stack.length - 1];
        if (cur && size >= 20) {
          const t = nameOf(buf.readInt32LE(off + 16)).trim();
          if (t) cur.text = (cur.text ?? "") + t;
        }
        break;
      }
      default:
        break; // end namespace, unknown chunks: skipped
    }
    off += size;
  }
  if (!root) throw new ApkError("binary XML has no root element");
  return root;
}

export const isAxml = (buf: Buffer): boolean => buf.length >= 8 && buf.readUInt16LE(0) === 0x0003 && buf.readUInt16LE(2) === 8;

/** All string attribute values and text in the tree, for secret scanning. */
export function collectXmlStrings(node: XmlNode, out: string[] = []): string[] {
  for (const v of Object.values(node.attrs)) if (typeof v === "string") out.push(v);
  if (node.text) out.push(node.text);
  for (const c of node.children) collectXmlStrings(c, out);
  return out;
}
