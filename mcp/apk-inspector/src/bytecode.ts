import { ApkError, type Deadline } from "./errors.js";
import type { DexFile } from "./dex.js";

/**
 * A reader for the parts of a DEX file that hold code: prototypes, method ids, class data, code items and the
 * Dalvik instructions themselves. It never executes anything. Every offset and count read from the file is checked.
 */

const MAX_ULEB_BYTES = 5;

export interface MethodRef {
  /** Declaring class descriptor, `Landroid/os/Binder;`. */
  cls: string;
  name: string;
  /** `(Ljava/lang/String;I)V` */
  proto: string;
  /** `Landroid/os/Binder;->getCallingUid()I` */
  sig: string;
}

export interface ClassDef {
  descriptor: string;
  superDescriptor: string | null;
  interfaces: string[];
  accessFlags: number;
  classDataOff: number;
}

export interface DefinedMethod {
  methodIdx: number;
  ref: MethodRef;
  accessFlags: number;
  direct: boolean;
  codeOff: number;
}

export interface CodeItem {
  registers: number;
  ins: number;
  outs: number;
  insnsOff: number;
  units: number;
}

export interface ProtoInfo {
  ret: string;
  params: string[];
  text: string;
}

const METHOD_ACCESS: [number, string][] = [
  [0x1, "public"],
  [0x2, "private"],
  [0x4, "protected"],
  [0x8, "static"],
  [0x10, "final"],
  [0x20, "synchronized"],
  [0x40, "bridge"],
  [0x80, "varargs"],
  [0x100, "native"],
  [0x400, "abstract"],
  [0x800, "strict"],
  [0x1000, "synthetic"],
  [0x10000, "constructor"],
  [0x20000, "declared-synchronized"],
];

export const methodAccessNames = (flags: number): string[] => METHOD_ACCESS.filter(([bit]) => (flags & bit) !== 0).map(([, n]) => n);

export class DexCode {
  private readonly buf: Buffer;
  private readonly protoCount: number;
  private readonly protoOff: number;
  private readonly methodCount: number;
  private readonly methodOff: number;
  private readonly classCount: number;
  private readonly classDefsOff: number;
  private readonly refs = new Map<number, MethodRef | null>();
  private readonly protos = new Map<number, ProtoInfo | null>();

  constructor(
    readonly dex: DexFile,
    private readonly deadline: Deadline,
  ) {
    this.buf = dex.bytes;
    const b = this.buf;
    this.protoCount = b.readUInt32LE(72);
    this.protoOff = b.readUInt32LE(76);
    this.methodCount = b.readUInt32LE(88);
    this.methodOff = b.readUInt32LE(92);
    this.classCount = b.readUInt32LE(96);
    this.classDefsOff = b.readUInt32LE(100);
    this.table("proto_ids", this.protoCount, this.protoOff, 12);
    this.table("method_ids", this.methodCount, this.methodOff, 8);
  }

  get name(): string {
    return this.dex.name;
  }

  private table(label: string, count: number, off: number, entry: number): void {
    if (count === 0) return;
    if (off < 0x70 || off + count * entry > this.buf.length) throw new ApkError(`${this.dex.name}: ${label} table lies outside the file (malformed DEX)`);
  }

  private uleb(pos: number): [value: number, next: number] {
    let value = 0;
    let shift = 0;
    for (let n = 0; n < MAX_ULEB_BYTES; n++) {
      if (pos >= this.buf.length) throw new ApkError("class data is truncated");
      const byte = this.buf[pos++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return [value, pos];
      shift += 7;
    }
    throw new ApkError("class data holds a number that never ends (malformed)");
  }

  proto(idx: number): ProtoInfo | null {
    const cached = this.protos.get(idx);
    if (cached !== undefined) return cached;
    let info: ProtoInfo | null = null;
    if (idx >= 0 && idx < this.protoCount) {
      const o = this.protoOff + idx * 12;
      const ret = this.dex.typeDescriptor(this.buf.readUInt32LE(o + 4));
      const params = this.typeList(this.buf.readUInt32LE(o + 8));
      if (ret !== null && params !== null) info = { ret, params, text: `(${params.join("")})${ret}` };
    }
    this.protos.set(idx, info);
    return info;
  }

  /** A `type_list` (size, then 16-bit type indices) as descriptors; offset 0 is an empty list. */
  private typeList(off: number): string[] | null {
    if (off === 0) return [];
    if (off + 4 > this.buf.length) return null;
    const size = this.buf.readUInt32LE(off);
    if (off + 4 + size * 2 > this.buf.length) return null;
    const out: string[] = [];
    for (let i = 0; i < size; i++) {
      const d = this.dex.typeDescriptor(this.buf.readUInt16LE(off + 4 + i * 2));
      if (d === null) return null;
      out.push(d);
    }
    return out;
  }

  methodRef(idx: number): MethodRef | null {
    const cached = this.refs.get(idx);
    if (cached !== undefined) return cached;
    let ref: MethodRef | null = null;
    if (idx >= 0 && idx < this.methodCount) {
      const o = this.methodOff + idx * 8;
      const cls = this.dex.typeDescriptor(this.buf.readUInt16LE(o));
      const proto = this.proto(this.buf.readUInt16LE(o + 2));
      const name = this.dex.string(this.buf.readUInt32LE(o + 4));
      if (cls !== null && proto !== null && name !== null) ref = { cls, name, proto: proto.text, sig: `${cls}->${name}${proto.text}` };
    }
    this.refs.set(idx, ref);
    return ref;
  }

  string(idx: number): string | null {
    return this.dex.string(idx);
  }

  typeDescriptor(idx: number): string | null {
    return this.dex.typeDescriptor(idx);
  }

  forEachClassDef(cb: (c: ClassDef) => void): void {
    for (let i = 0; i < this.classCount; i++) {
      this.deadline.tick();
      const o = this.classDefsOff + i * 32;
      if (o + 32 > this.buf.length) return;
      const descriptor = this.dex.typeDescriptor(this.buf.readUInt32LE(o));
      if (descriptor === null) continue;
      const interfaces = this.typeList(this.buf.readUInt32LE(o + 12)) ?? [];
      cb({ descriptor, superDescriptor: this.dex.typeDescriptor(this.buf.readUInt32LE(o + 8)), interfaces, accessFlags: this.buf.readUInt32LE(o + 4), classDataOff: this.buf.readUInt32LE(o + 24) });
    }
  }

  /** The methods a class declares. Throws ApkError when the class data is damaged. */
  methodsOf(c: ClassDef): DefinedMethod[] {
    if (c.classDataOff === 0) return [];
    if (c.classDataOff >= this.buf.length) throw new ApkError("class data lies outside the file");
    let pos = c.classDataOff;
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [v, next] = this.uleb(pos);
      sizes.push(v);
      pos = next;
    }
    const [staticFields, instanceFields, directMethods, virtualMethods] = sizes as [number, number, number, number];
    // Every entry takes at least two bytes: a declared count that cannot fit is hostile.
    if ((staticFields + instanceFields) * 2 + (directMethods + virtualMethods) * 3 > this.buf.length - pos) throw new ApkError("class data declares more members than the file can hold");
    for (let i = 0; i < staticFields + instanceFields; i++) {
      this.deadline.tick();
      pos = this.uleb(this.uleb(pos)[1])[1];
    }
    const out: DefinedMethod[] = [];
    for (const [count, direct] of [[directMethods, true], [virtualMethods, false]] as const) {
      let idx = 0;
      for (let i = 0; i < count; i++) {
        this.deadline.tick();
        const [diff, p1] = this.uleb(pos);
        const [flags, p2] = this.uleb(p1);
        const [codeOff, p3] = this.uleb(p2);
        pos = p3;
        idx += diff;
        const ref = this.methodRef(idx);
        if (!ref) continue;
        out.push({ methodIdx: idx, ref, accessFlags: flags, direct, codeOff });
      }
    }
    return out;
  }

  /** The code item header of a method, or null for abstract and native methods. Throws ApkError if it does not fit in the file. */
  codeItem(m: DefinedMethod): CodeItem | null {
    if (m.codeOff === 0) return null;
    if (m.codeOff + 16 > this.buf.length) throw new ApkError("code item lies outside the file");
    const units = this.buf.readUInt32LE(m.codeOff + 12);
    if (m.codeOff + 16 + units * 2 > this.buf.length) throw new ApkError("code item runs past the end of the file");
    return { registers: this.buf.readUInt16LE(m.codeOff), ins: this.buf.readUInt16LE(m.codeOff + 2), outs: this.buf.readUInt16LE(m.codeOff + 4), insnsOff: m.codeOff + 16, units };
  }

  walk(code: CodeItem, h: Handlers): WalkResult {
    return walkCode(this.buf, code.insnsOff, code.units, h, this.deadline);
  }
}

// ---- instructions -------------------------------------------------------

/** Length in 16-bit code units of each opcode (payload pseudo-instructions are sized separately). */
const LEN = new Uint8Array(256).fill(1);
for (const o of [0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29, 0xfe, 0xff]) LEN[o] = 2;
for (let o = 0x2d; o <= 0x3d; o++) LEN[o] = 2;
for (let o = 0x44; o <= 0x6d; o++) LEN[o] = 2;
for (let o = 0x90; o <= 0xaf; o++) LEN[o] = 2;
for (let o = 0xd0; o <= 0xe2; o++) LEN[o] = 2;
for (const o of [0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c, 0xfc, 0xfd]) LEN[o] = 3;
for (let o = 0x6e; o <= 0x72; o++) LEN[o] = 3;
for (let o = 0x74; o <= 0x78; o++) LEN[o] = 3;
LEN[0xfa] = 4;
LEN[0xfb] = 4;
LEN[0x18] = 5;

const INVOKE_NAMES: Record<number, string> = {
  0x6e: "invoke-virtual",
  0x6f: "invoke-super",
  0x70: "invoke-direct",
  0x71: "invoke-static",
  0x72: "invoke-interface",
  0x74: "invoke-virtual/range",
  0x75: "invoke-super/range",
  0x76: "invoke-direct/range",
  0x77: "invoke-static/range",
  0x78: "invoke-interface/range",
  0xfa: "invoke-polymorphic",
  0xfb: "invoke-polymorphic/range",
};

export const invokeName = (opcode: number): string => INVOKE_NAMES[opcode] ?? `invoke-0x${opcode.toString(16)}`;

export interface Handlers {
  invoke?(opcode: number, methodIdx: number, regs: number[]): void;
  constString?(stringIdx: number): void;
  newInstance?(typeIdx: number): void;
  /** A register read as an operand. A register that was overwritten and read again is counted too. */
  read?(reg: number): void;
}

export interface WalkResult {
  instructions: number;
  complete: boolean;
  error?: string;
}

/** Walks the instructions of one method. Stops with `complete: false` at the first thing that does not fit. */
export function walkCode(buf: Buffer, insnsOff: number, units: number, h: Handlers, deadline: Deadline): WalkResult {
  const unit = (i: number): number => buf.readUInt16LE(insnsOff + i * 2);
  const read = h.read;
  const r = (reg: number): void => {
    if (read) read(reg);
  };
  let i = 0;
  let n = 0;
  const stop = (error: string): WalkResult => ({ instructions: n, complete: false, error });
  while (i < units) {
    deadline.tick();
    const u = unit(i);
    const opc = u & 0xff;
    let len: number;
    if (opc === 0 && u !== 0) {
      if (u === 0x0100) {
        if (i + 1 >= units) return stop("packed-switch payload is cut short");
        len = unit(i + 1) * 2 + 4;
      } else if (u === 0x0200) {
        if (i + 1 >= units) return stop("sparse-switch payload is cut short");
        len = unit(i + 1) * 4 + 2;
      } else if (u === 0x0300) {
        if (i + 3 >= units) return stop("fill-array-data payload is cut short");
        len = Math.floor(((unit(i + 2) + unit(i + 3) * 65536) * unit(i + 1) + 1) / 2) + 4;
      } else return stop(`unknown pseudo-instruction 0x${u.toString(16)} at unit ${i}`);
      if (i + len > units) return stop(`payload at unit ${i} runs past the end of the code`);
    } else {
      len = LEN[opc]!;
      if (i + len > units) return stop(`instruction 0x${opc.toString(16)} at unit ${i} runs past the end of the code`);
      const a4 = (u >> 8) & 0xf;
      const b4 = (u >> 12) & 0xf;
      const a8 = (u >> 8) & 0xff;
      if (opc === 0x01 || opc === 0x04 || opc === 0x07) r(b4);
      else if (opc === 0x02 || opc === 0x05 || opc === 0x08) r(unit(i + 1));
      else if (opc === 0x03 || opc === 0x06 || opc === 0x09) r(unit(i + 2));
      else if (opc >= 0x0f && opc <= 0x11) r(a8);
      else if (opc === 0x1d || opc === 0x1e || opc === 0x1f || opc === 0x26 || opc === 0x27 || opc === 0x2b || opc === 0x2c) r(a8);
      else if (opc === 0x1a) h.constString?.(unit(i + 1));
      else if (opc === 0x1b) h.constString?.(unit(i + 1) + unit(i + 2) * 65536);
      else if (opc === 0x20 || opc === 0x21 || opc === 0x23) r(b4);
      else if (opc === 0x22) h.newInstance?.(unit(i + 1));
      else if (opc >= 0x2d && opc <= 0x31) {
        const w = unit(i + 1);
        r(w & 0xff);
        r(w >> 8);
      } else if (opc >= 0x32 && opc <= 0x37) {
        r(a4);
        r(b4);
      } else if (opc >= 0x38 && opc <= 0x3d) r(a8);
      else if (opc >= 0x44 && opc <= 0x51) {
        const w = unit(i + 1);
        if (opc >= 0x4b) r(a8);
        r(w & 0xff);
        r(w >> 8);
      } else if (opc >= 0x52 && opc <= 0x58) r(b4);
      else if (opc >= 0x59 && opc <= 0x5f) {
        r(a4);
        r(b4);
      } else if (opc >= 0x67 && opc <= 0x6d) r(a8);
      else if ((opc >= 0x6e && opc <= 0x72) || opc === 0x24 || opc === 0xfa || opc === 0xfc) {
        // 35c / 45cc: count in the high nibble, up to five registers C D E F G.
        const count = Math.min(u >> 12, 5);
        const w = unit(i + 2);
        const regs = [w & 0xf, (w >> 4) & 0xf, (w >> 8) & 0xf, (w >> 12) & 0xf, a4].slice(0, count);
        for (const x of regs) r(x);
        if (opc !== 0x24 && opc !== 0xfc) h.invoke?.(opc, unit(i + 1), regs);
      } else if ((opc >= 0x74 && opc <= 0x78) || opc === 0x25 || opc === 0xfb || opc === 0xfd) {
        // 3rc / 4rcc: a run of `count` registers starting at C.
        const count = a8;
        const first = unit(i + 2);
        const regs: number[] = [];
        for (let k = 0; k < count; k++) regs.push(first + k);
        for (const x of regs) r(x);
        if (opc !== 0x25 && opc !== 0xfd) h.invoke?.(opc, unit(i + 1), regs);
      } else if (opc >= 0x7b && opc <= 0x8f) r(b4);
      else if (opc >= 0x90 && opc <= 0xaf) {
        const w = unit(i + 1);
        r(w & 0xff);
        r(w >> 8);
      } else if (opc >= 0xb0 && opc <= 0xcf) {
        r(a4);
        r(b4);
      } else if (opc >= 0xd0 && opc <= 0xd7) r(b4);
      else if (opc >= 0xd8 && opc <= 0xe2) r(unit(i + 1) & 0xff);
    }
    n++;
    i += len;
  }
  return { instructions: n, complete: true };
}

