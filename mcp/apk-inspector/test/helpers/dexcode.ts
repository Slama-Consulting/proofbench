import { encodeMutf8 } from "./dexwriter.js";

/** A DEX builder with methods, prototypes, class data and code items, for bytecode tests. Tables are not sorted: the reader does not care. */

const NO_INDEX = 0xffffffff;
const toDescriptor = (dotted: string): string => `L${dotted.replace(/\./g, "/")};`;

export interface MethodSig {
  /** Dotted class name, e.g. `android.os.Binder`. */
  cls: string;
  name: string;
  /** Parameter descriptors, e.g. `["Ljava/lang/String;", "I"]`. */
  params?: string[];
  /** Return descriptor, default `V`. */
  ret?: string;
}

export interface Asm {
  string(s: string): number;
  type(descriptor: string): number;
  method(m: MethodSig): number;
}

export interface CodeSpec {
  registers: number;
  ins: number;
  outs?: number;
  units: number[] | ((a: Asm) => number[]);
}

export interface MethodSpec {
  name: string;
  params?: string[];
  ret?: string;
  /** Access flags, default public (1). */
  flags?: number;
  /** Put the method in the direct list (constructors, static, private); default virtual. */
  direct?: boolean;
  /** Absent or null: no code (abstract or native). */
  code?: CodeSpec | null;
}

export interface CodeClassSpec {
  name: string;
  superclass?: string;
  interfaces?: string[];
  flags?: number;
  methods?: MethodSpec[];
}

export interface CodeDexLayout {
  fileSize: number;
  protoIdsOff: number;
  methodIdsOff: number;
  classDefsOff: number;
  /** `Lcls;->name` to the file offset of its code item. */
  codeItemOff: Record<string, number>;
  /** Dotted class name to the file offset of its class_data_item (0 when none). */
  classDataOff: Record<string, number>;
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

const shortyOf = (d: string): string => (d[0] === "L" || d[0] === "[" ? "L" : d);

export function buildCodeDex(classes: CodeClassSpec[]): { buf: Buffer; layout: CodeDexLayout } {
  const strings: string[] = [];
  const str = (s: string): number => {
    let i = strings.indexOf(s);
    if (i < 0) {
      i = strings.length;
      strings.push(s);
    }
    return i;
  };
  const types: string[] = [];
  const type = (d: string): number => {
    let i = types.indexOf(d);
    if (i < 0) {
      i = types.length;
      types.push(d);
      str(d);
    }
    return i;
  };
  const protos: { ret: string; params: string[] }[] = [];
  const proto = (ret: string, params: string[]): number => {
    const key = `${ret}(${params.join("")})`;
    let i = protos.findIndex((p) => `${p.ret}(${p.params.join("")})` === key);
    if (i < 0) {
      i = protos.length;
      protos.push({ ret, params });
      str(shortyOf(ret) + params.map(shortyOf).join(""));
      type(ret);
      params.forEach(type);
    }
    return i;
  };
  const methodIds: { cls: number; proto: number; name: number }[] = [];
  const methodKeys: string[] = [];
  const method = (m: MethodSig): number => {
    const ret = m.ret ?? "V";
    const params = m.params ?? [];
    const key = `${toDescriptor(m.cls)}->${m.name}(${params.join("")})${ret}`;
    let i = methodKeys.indexOf(key);
    if (i < 0) {
      i = methodKeys.length;
      methodKeys.push(key);
      methodIds.push({ cls: type(toDescriptor(m.cls)), proto: proto(ret, params), name: str(m.name) });
    }
    return i;
  };
  const asm: Asm = { string: str, type, method };

  // Phase 1: declare classes and methods so that their indices exist before any code is generated.
  const declared = classes.map((c) => ({
    c,
    cls: type(toDescriptor(c.name)),
    sup: c.superclass ? type(toDescriptor(c.superclass)) : NO_INDEX,
    ifaces: (c.interfaces ?? []).map((i) => type(toDescriptor(i))),
    methods: (c.methods ?? []).map((m) => ({ m, idx: method({ cls: c.name, name: m.name, params: m.params, ret: m.ret }) })),
  }));
  // Phase 2: code.
  const codes = new Map<number, { regs: number; ins: number; outs: number; units: number[] }>();
  for (const d of declared) {
    for (const { m, idx } of d.methods) {
      if (!m.code) continue;
      const units = typeof m.code.units === "function" ? m.code.units(asm) : m.code.units;
      codes.set(idx, { regs: m.code.registers, ins: m.code.ins, outs: m.code.outs ?? 0, units });
    }
  }

  const headerSize = 0x70;
  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const protoIdsOff = typeIdsOff + types.length * 4;
  const methodIdsOff = protoIdsOff + protos.length * 12;
  const classDefsOff = methodIdsOff + methodIds.length * 8;
  const dataOff = classDefsOff + declared.length * 32;

  const chunks: Buffer[] = [];
  let pos = dataOff;
  const put = (b: Buffer): number => {
    const at = pos;
    chunks.push(b);
    pos += b.length;
    return at;
  };

  const stringOffs = strings.map((s) => put(Buffer.concat([uleb(s.length), encodeMutf8(s), Buffer.from([0])])));
  const typeList = (ids: number[]): number => {
    if (ids.length === 0) return 0;
    const b = Buffer.alloc(4 + ids.length * 2);
    b.writeUInt32LE(ids.length, 0);
    ids.forEach((t, i) => b.writeUInt16LE(t, 4 + i * 2));
    return put(b);
  };
  const protoParamsOff = protos.map((p) => typeList(p.params.map((d) => types.indexOf(d))));
  const ifaceOffs = declared.map((d) => typeList(d.ifaces));

  const codeItemOff: Record<string, number> = {};
  const classDataOff: Record<string, number> = {};
  const codeOffByMethod = new Map<number, number>();
  for (const [idx, c] of codes) {
    const b = Buffer.alloc(16 + c.units.length * 2);
    b.writeUInt16LE(c.regs, 0);
    b.writeUInt16LE(c.ins, 2);
    b.writeUInt16LE(c.outs, 4);
    b.writeUInt32LE(c.units.length, 12);
    c.units.forEach((u, i) => b.writeUInt16LE(u & 0xffff, 16 + i * 2));
    const at = put(b);
    codeOffByMethod.set(idx, at);
    codeItemOff[methodKeys[idx]!.replace(/\(.*$/, "")] = at;
  }
  const classDataOffs = declared.map((d) => {
    if (d.methods.length === 0) {
      classDataOff[d.c.name] = 0;
      return 0;
    }
    const encode = (list: { m: MethodSpec; idx: number }[]): Buffer => {
      let prev = 0;
      return Buffer.concat(
        [...list]
          .sort((a, b) => a.idx - b.idx)
          .map(({ m, idx }) => {
            const out = Buffer.concat([uleb(idx - prev), uleb(m.flags ?? 1), uleb(codeOffByMethod.get(idx) ?? 0)]);
            prev = idx;
            return out;
          }),
      );
    };
    const direct = d.methods.filter((x) => x.m.direct);
    const virtual = d.methods.filter((x) => !x.m.direct);
    const at = put(Buffer.concat([uleb(0), uleb(0), uleb(direct.length), uleb(virtual.length), encode(direct), encode(virtual)]));
    classDataOff[d.c.name] = at;
    return at;
  });

  const fileSize = pos;
  const buf = Buffer.alloc(fileSize);
  buf.write("dex\n035\0", 0, "latin1");
  buf.writeUInt32LE(fileSize, 32);
  buf.writeUInt32LE(headerSize, 36);
  buf.writeUInt32LE(0x12345678, 40);
  buf.writeUInt32LE(strings.length, 56);
  buf.writeUInt32LE(strings.length ? stringIdsOff : 0, 60);
  buf.writeUInt32LE(types.length, 64);
  buf.writeUInt32LE(types.length ? typeIdsOff : 0, 68);
  buf.writeUInt32LE(protos.length, 72);
  buf.writeUInt32LE(protos.length ? protoIdsOff : 0, 76);
  buf.writeUInt32LE(0, 80);
  buf.writeUInt32LE(0, 84);
  buf.writeUInt32LE(methodIds.length, 88);
  buf.writeUInt32LE(methodIds.length ? methodIdsOff : 0, 92);
  buf.writeUInt32LE(declared.length, 96);
  buf.writeUInt32LE(declared.length ? classDefsOff : 0, 100);
  buf.writeUInt32LE(fileSize - dataOff, 104);
  buf.writeUInt32LE(dataOff, 108);
  stringOffs.forEach((o, i) => buf.writeUInt32LE(o, stringIdsOff + i * 4));
  types.forEach((t, i) => buf.writeUInt32LE(strings.indexOf(t), typeIdsOff + i * 4));
  protos.forEach((p, i) => {
    const o = protoIdsOff + i * 12;
    buf.writeUInt32LE(strings.indexOf(shortyOf(p.ret) + p.params.map(shortyOf).join("")), o);
    buf.writeUInt32LE(types.indexOf(p.ret), o + 4);
    buf.writeUInt32LE(protoParamsOff[i]!, o + 8);
  });
  methodIds.forEach((m, i) => {
    const o = methodIdsOff + i * 8;
    buf.writeUInt16LE(m.cls, o);
    buf.writeUInt16LE(m.proto, o + 2);
    buf.writeUInt32LE(m.name, o + 4);
  });
  declared.forEach((d, i) => {
    const o = classDefsOff + i * 32;
    buf.writeUInt32LE(d.cls, o);
    buf.writeUInt32LE(d.c.flags ?? 1, o + 4);
    buf.writeUInt32LE(d.sup, o + 8);
    buf.writeUInt32LE(ifaceOffs[i]!, o + 12);
    buf.writeUInt32LE(NO_INDEX, o + 16);
    buf.writeUInt32LE(classDataOffs[i]!, o + 24);
  });
  let p = dataOff;
  for (const c of chunks) {
    c.copy(buf, p);
    p += c.length;
  }
  return { buf, layout: { fileSize, protoIdsOff, methodIdsOff, classDefsOff, codeItemOff, classDataOff } };
}

type InvokeKind = "virtual" | "super" | "direct" | "static" | "interface";
const INVOKE_OPS: Record<InvokeKind, number> = { virtual: 0x6e, super: 0x6f, direct: 0x70, static: 0x71, interface: 0x72 };
const INVOKE_RANGE_OPS: Record<InvokeKind, number> = { virtual: 0x74, super: 0x75, direct: 0x76, static: 0x77, interface: 0x78 };

/** A tiny assembler for the instructions the tests need. Registers must fit their format (4 or 8 bits). */
export const op = {
  nop: (): number[] => [0x0000],
  returnVoid: (): number[] => [0x000e],
  ret: (a: number): number[] => [0x000f | (a << 8)],
  retObject: (a: number): number[] => [0x0011 | (a << 8)],
  const4: (a: number, v: number): number[] => [0x0012 | (a << 8) | ((v & 0xf) << 12)],
  constString: (a: number, s: number): number[] => [0x001a | (a << 8), s],
  constStringJumbo: (a: number, s: number): number[] => [0x001b | (a << 8), s & 0xffff, s >>> 16],
  constWide: (a: number): number[] => [0x0018 | (a << 8), 0, 0, 0, 0],
  move: (a: number, b: number): number[] => [0x0001 | (a << 8) | (b << 12)],
  moveObject: (a: number, b: number): number[] => [0x0007 | (a << 8) | (b << 12)],
  moveResult: (a: number): number[] => [0x000a | (a << 8)],
  moveResultObject: (a: number): number[] => [0x000c | (a << 8)],
  newInstance: (a: number, t: number): number[] => [0x0022 | (a << 8), t],
  checkCast: (a: number, t: number): number[] => [0x001f | (a << 8), t],
  ifEqz: (a: number, off: number): number[] => [0x0038 | (a << 8), off & 0xffff],
  goto: (off: number): number[] => [0x0028 | ((off & 0xff) << 8)],
  iget: (a: number, b: number, field: number): number[] => [0x0052 | (a << 8) | (b << 12), field],
  addInt: (a: number, b: number, c: number): number[] => [0x0090 | (a << 8), b | (c << 8)],
  invoke: (kind: InvokeKind, method: number, regs: number[]): number[] => {
    const g = regs[4] ?? 0;
    return [(regs.length << 12) | (g << 8) | INVOKE_OPS[kind], method, (regs[0] ?? 0) | ((regs[1] ?? 0) << 4) | ((regs[2] ?? 0) << 8) | ((regs[3] ?? 0) << 12)];
  },
  invokeRange: (kind: InvokeKind, method: number, first: number, count: number): number[] => [(count << 8) | INVOKE_RANGE_OPS[kind], method, first],
  /** invoke-polymorphic: 4 units. */
  invokePolymorphic: (method: number, proto: number, regs: number[]): number[] => [(regs.length << 12) | 0xfa, method, regs[0] ?? 0, proto],
  packedSwitchPayload: (n: number): number[] => [0x0100, n, 0, 0, ...new Array<number>(n * 2).fill(0)],
  sparseSwitchPayload: (n: number): number[] => [0x0200, n, ...new Array<number>(n * 4).fill(0)],
  fillArrayDataPayload: (width: number, n: number): number[] => [0x0300, width, n & 0xffff, n >>> 16, ...new Array<number>(Math.ceil((width * n) / 2)).fill(0)],
  const16: (a: number, v: number): number[] => [0x0013 | (a << 8), v & 0xffff],
  const32: (a: number, v: number): number[] => [0x0014 | (a << 8), v & 0xffff, (v >>> 16) & 0xffff],
  /** const/high16: the value is `v << 16`. */
  constHigh16: (a: number, v: number): number[] => [0x0015 | (a << 8), v & 0xffff],
  moveWide: (a: number, b: number): number[] => [0x0004 | (a << 8) | (b << 12)],
  addIntLit8: (a: number, b: number, lit: number): number[] => [0x00d8 | (a << 8), b | ((lit & 0xff) << 8)],
  /** packed-switch vA with the signed offset (in code units) of its payload. */
  packedSwitch: (a: number, payloadOff: number): number[] => [0x002b | (a << 8), payloadOff & 0xffff, (payloadOff >>> 16) & 0xffff],
  /** A packed-switch payload whose case targets are the given offsets (in code units, relative to the switch). */
  packedSwitchPayloadTo: (targets: number[]): number[] => [0x0100, targets.length, 0, 0, ...targets.flatMap((t) => [t & 0xffff, (t >>> 16) & 0xffff])],
};
