export const ANDROID_NS = "http://schemas.android.com/apk/res/android";

export type AttrValue = string | number | boolean | { ref: number } | { hex: number };

export interface AxmlAttr {
  /** `android` for the framework namespace, absent for none. */
  ns?: "android";
  name: string;
  value: AttrValue;
}

export interface AxmlEl {
  name: string;
  attrs?: AxmlAttr[];
  children?: AxmlEl[];
  text?: string;
}

export interface AxmlOptions {
  utf8?: boolean;
  /** Attribute name -> framework resource id. Listed names go first in the pool and in the id map. */
  resIds?: Record<string, number>;
  /** Replace the pool entry of attributes that have a resource id by an empty string (obfuscated names). */
  stripNames?: boolean;
}

const pad4 = (n: number): number => (n + 3) & ~3;

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

function encodePool(strings: string[], utf8: boolean): Buffer {
  const datas: Buffer[] = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, "utf8");
      const lenEnc = (n: number): Buffer => (n > 0x7f ? Buffer.from([0x80 | (n >> 8), n & 0xff]) : Buffer.from([n]));
      return Buffer.concat([lenEnc(s.length), lenEnc(bytes.length), bytes, Buffer.from([0])]);
    }
    return Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)]);
  });
  const offsets: number[] = [];
  let pos = 0;
  for (const d of datas) {
    offsets.push(pos);
    pos += d.length;
  }
  const data = Buffer.concat(datas);
  const dataPadded = Buffer.concat([data, Buffer.alloc(pad4(data.length) - data.length)]);
  const headerSize = 28;
  const stringsStart = headerSize + strings.length * 4;
  const size = stringsStart + dataPadded.length;
  return Buffer.concat([u16(0x0001), u16(headerSize), u32(size), u32(strings.length), u32(0), u32(utf8 ? 0x100 : 0), u32(strings.length ? stringsStart : 0), u32(0), ...offsets.map(u32), dataPadded]);
}

export function buildAxml(root: AxmlEl, opts: AxmlOptions = {}): Buffer {
  const pool: string[] = [];
  const idsInPool: number[] = [];
  const index = new Map<string, number>();
  const intern = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = pool.length;
      pool.push(s);
      index.set(s, i);
    }
    return i;
  };

  // Attribute names with a resource id come first (the id map is parallel to the start of the pool).
  const idIndex = new Map<string, number>();
  if (opts.resIds) {
    for (const [name, id] of Object.entries(opts.resIds)) {
      idIndex.set(name, pool.length);
      pool.push(opts.stripNames ? "" : name);
      idsInPool.push(id);
    }
  }
  const nameIdx = (n: string): number => idIndex.get(n) ?? intern(n);

  const androidIdx = intern(ANDROID_NS);
  const prefixIdx = intern("android");

  const body: Buffer[] = [];
  const startNs = Buffer.concat([u16(0x0100), u16(16), u32(24), u32(1), i32(-1), u32(prefixIdx), u32(androidIdx)]);
  const endNs = Buffer.concat([u16(0x0101), u16(16), u32(24), u32(1), i32(-1), u32(prefixIdx), u32(androidIdx)]);

  const walk = (el: AxmlEl): void => {
    const attrs = el.attrs ?? [];
    const size = 36 + 20 * attrs.length;
    const parts: Buffer[] = [u16(0x0102), u16(16), u32(size), u32(1), i32(-1), i32(-1), u32(nameIdx(el.name)), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0)];
    for (const a of attrs) {
      const ns = a.ns === "android" ? androidIdx : -1;
      let raw = -1;
      let type = 0x03;
      let data = 0;
      const v = a.value;
      if (typeof v === "string") {
        raw = intern(v);
        data = raw;
      } else if (typeof v === "boolean") {
        type = 0x12;
        data = v ? 0xffffffff : 0;
      } else if (typeof v === "number") {
        type = 0x10;
        data = v >>> 0;
      } else if ("ref" in v) {
        type = 0x01;
        data = v.ref;
      } else {
        type = 0x11;
        data = v.hex;
      }
      parts.push(i32(ns), u32(nameIdx(a.name)), i32(raw), u16(8), Buffer.from([0, type]), u32(data));
    }
    body.push(Buffer.concat(parts));
    if (el.text) body.push(Buffer.concat([u16(0x0104), u16(16), u32(28), u32(1), i32(-1), u32(intern(el.text)), u16(8), Buffer.from([0, 0]), u32(0)]));
    for (const c of el.children ?? []) walk(c);
    body.push(Buffer.concat([u16(0x0103), u16(16), u32(24), u32(1), i32(-1), i32(-1), u32(nameIdx(el.name))]));
  };
  walk(root);

  const poolChunk = encodePool(pool, opts.utf8 ?? false);
  const resChunk = idsInPool.length ? Buffer.concat([u16(0x0180), u16(8), u32(8 + idsInPool.length * 4), ...idsInPool.map(u32)]) : Buffer.alloc(0);
  const inner = Buffer.concat([poolChunk, resChunk, startNs, ...body, endNs]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + inner.length), inner]);
}

export const attr = (name: string, value: AttrValue, ns: "android" | null = "android"): AxmlAttr => (ns ? { ns, name, value } : { name, value });
