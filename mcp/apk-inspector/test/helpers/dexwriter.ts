export interface DexClassSpec {
  /** Dotted name, e.g. `com.example.Foo`. */
  name: string;
  superclass?: string;
  accessFlags?: number;
}

export interface DexSpec {
  strings?: string[];
  classes?: DexClassSpec[];
  /** Override the declared string_ids_size, to build hostile files. */
  declaredStringCount?: number;
}

const toDescriptor = (dotted: string): string => `L${dotted.replace(/\./g, "/")};`;

/** Modified UTF-8: NUL is C0 80 and supplementary characters are two 3-byte surrogates. */
export function encodeMutf8(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

function uleb(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** A minimal but structurally valid DEX: header, string_ids, type_ids, class_defs, string data. */
export function buildDex(spec: DexSpec = {}): Buffer {
  const strings: string[] = [...(spec.strings ?? [])];
  const idx = (s: string): number => {
    let i = strings.indexOf(s);
    if (i < 0) {
      i = strings.length;
      strings.push(s);
    }
    return i;
  };
  const classes = spec.classes ?? [];
  const types: string[] = [];
  const typeIdx = (dotted: string): number => {
    const d = toDescriptor(dotted);
    let i = types.indexOf(d);
    if (i < 0) {
      i = types.length;
      types.push(d);
      idx(d);
    }
    return i;
  };
  const defs = classes.map((c) => ({ cls: typeIdx(c.name), sup: c.superclass ? typeIdx(c.superclass) : 0xffffffff, flags: c.accessFlags ?? 1 }));

  const headerSize = 0x70;
  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const classDefsOff = typeIdsOff + types.length * 4;
  const dataOff = classDefsOff + defs.length * 32;

  const datas = strings.map((s) => {
    const m = encodeMutf8(s);
    return Buffer.concat([uleb(s.length), m, Buffer.from([0])]);
  });
  const offsets: number[] = [];
  let pos = dataOff;
  for (const d of datas) {
    offsets.push(pos);
    pos += d.length;
  }
  const fileSize = pos;

  const buf = Buffer.alloc(fileSize);
  buf.write("dex\n035\0", 0, "latin1");
  buf.writeUInt32LE(fileSize, 32);
  buf.writeUInt32LE(headerSize, 36);
  buf.writeUInt32LE(0x12345678, 40);
  buf.writeUInt32LE(spec.declaredStringCount ?? strings.length, 56);
  buf.writeUInt32LE(strings.length ? stringIdsOff : 0, 60);
  buf.writeUInt32LE(types.length, 64);
  buf.writeUInt32LE(types.length ? typeIdsOff : 0, 68);
  buf.writeUInt32LE(defs.length, 96);
  buf.writeUInt32LE(defs.length ? classDefsOff : 0, 100);
  buf.writeUInt32LE(fileSize - dataOff, 104);
  buf.writeUInt32LE(dataOff, 108);
  offsets.forEach((o, i) => buf.writeUInt32LE(o, stringIdsOff + i * 4));
  types.forEach((t, i) => buf.writeUInt32LE(strings.indexOf(t), typeIdsOff + i * 4));
  defs.forEach((d, i) => {
    const o = classDefsOff + i * 32;
    buf.writeUInt32LE(d.cls, o);
    buf.writeUInt32LE(d.flags, o + 4);
    buf.writeUInt32LE(d.sup, o + 8);
    buf.writeUInt32LE(0xffffffff, o + 16);
  });
  let p = dataOff;
  for (const d of datas) {
    d.copy(buf, p);
    p += d.length;
  }
  return buf;
}
