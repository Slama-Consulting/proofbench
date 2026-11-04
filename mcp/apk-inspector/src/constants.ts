import { ApkError, type Deadline } from "./errors.js";
import { opcodeLength } from "./bytecode.js";

/**
 * A conservative constant tracker for one method. It answers a narrow question: at this call, which argument
 * registers certainly hold a constant that the method itself loaded? Knowledge is dropped on every write, at every
 * branch, switch and exception-handler target, so a value that depends on the path taken is never reported.
 * Anything it cannot follow makes it give up on the method (complete: false) instead of guessing.
 */

export interface KnownArg {
  /** Position among the call's registers (the receiver of an instance call is position 0). */
  arg: number;
  int?: number;
  hex?: string;
  string?: string;
}

export interface ConstResult {
  /** Instruction position (code units) to the known arguments of the call there; calls with none are absent. */
  sites: Map<number, KnownArg[]>;
  complete: boolean;
}

type Val = { int: number } | { str: string };

const MAX_HANDLERS = 4096;
const MAX_STRING = 300;

const s16 = (x: number): number => (x << 16) >> 16;
const hex = (v: number): string => `0x${(v >>> 0).toString(16)}`;

class GiveUp extends Error {}

export function trackConstants(buf: Buffer, insnsOff: number, units: number, tries: number, string: (idx: number) => string | null, deadline: Deadline): ConstResult {
  try {
    return run(buf, insnsOff, units, tries, string, deadline);
  } catch (e) {
    if (e instanceof GiveUp) return { sites: new Map(), complete: false };
    if (e instanceof ApkError) throw e;
    return { sites: new Map(), complete: false };
  }
}

function run(buf: Buffer, insnsOff: number, units: number, tries: number, string: (idx: number) => string | null, deadline: Deadline): ConstResult {
  const u = (i: number): number => {
    if (i < 0 || i >= units) throw new GiveUp();
    return buf.readUInt16LE(insnsOff + i * 2);
  };
  const s32 = (i: number): number => (u(i) | (u(i + 1) << 16)) | 0;

  /** Length of the payload pseudo-instruction at `i`, or 0 when `i` is a regular instruction. */
  const payloadLength = (i: number): number => {
    const w = u(i);
    if ((w & 0xff) !== 0 || w === 0) return 0;
    if (w === 0x0100) return u(i + 1) * 2 + 4;
    if (w === 0x0200) return u(i + 1) * 4 + 2;
    if (w === 0x0300) return Math.floor(((u(i + 2) + u(i + 3) * 65536) * u(i + 1) + 1) / 2) + 4;
    throw new GiveUp();
  };

  // ---- pass 1: where can control arrive other than by falling through? ----
  const targets = new Set<number>();
  const target = (t: number): void => {
    if (t < 0 || t >= units) throw new GiveUp();
    targets.add(t);
  };
  for (let i = 0; i < units; ) {
    deadline.tick();
    const pl = payloadLength(i);
    if (pl) {
      i += pl;
      continue;
    }
    const w = u(i);
    const opc = w & 0xff;
    if (opc === 0x28) target(i + (((w >> 8) << 24) >> 24));
    else if (opc === 0x29) target(i + s16(u(i + 1)));
    else if (opc === 0x2a) target(i + s32(i + 1));
    else if (opc >= 0x32 && opc <= 0x3d) target(i + s16(u(i + 1)));
    else if (opc === 0x2b || opc === 0x2c) {
      const p = i + s32(i + 1);
      const packed = opc === 0x2b;
      if (u(p) !== (packed ? 0x0100 : 0x0200)) throw new GiveUp();
      const size = u(p + 1);
      const first = packed ? p + 4 : p + 2 + size * 2;
      for (let k = 0; k < size; k++) target(i + s32(first + k * 2));
    }
    i += opcodeLength(opc);
  }
  if (tries > 0) {
    const tableAt = insnsOff + units * 2 + (units % 2 ? 2 : 0);
    let pos = tableAt + tries * 8;
    if (pos >= buf.length) throw new GiveUp();
    const uleb = (): number => {
      let v = 0;
      for (let n = 0; n < 5; n++) {
        if (pos >= buf.length) throw new GiveUp();
        const b = buf[pos++]!;
        v += (b & 0x7f) * 2 ** (7 * n);
        if ((b & 0x80) === 0) return v;
      }
      throw new GiveUp();
    };
    const sleb = (): number => {
      let v = 0;
      let shift = 0;
      for (let n = 0; n < 5; n++) {
        if (pos >= buf.length) throw new GiveUp();
        const b = buf[pos++]!;
        v |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) return shift < 32 && (b & 0x40) !== 0 ? v | (-1 << shift) : v;
      }
      throw new GiveUp();
    };
    const handlers = uleb();
    if (handlers > MAX_HANDLERS) throw new GiveUp();
    for (let h = 0; h < handlers; h++) {
      deadline.tick();
      const size = sleb();
      for (let k = 0; k < Math.abs(size); k++) {
        uleb();
        target(uleb());
      }
      if (size <= 0) target(uleb());
    }
  }

  // ---- pass 2: forward, forgetting everything at a join ----
  const known = new Map<number, Val>();
  const sites = new Map<number, KnownArg[]>();
  const del = (r: number): void => void known.delete(r);
  const delWide = (r: number): void => {
    known.delete(r);
    known.delete(r + 1);
  };
  const set = (r: number, v: Val): void => void known.set(r, v);
  const copy = (dst: number, src: number): void => {
    const v = known.get(src);
    if (v) known.set(dst, v);
    else known.delete(dst);
  };
  const isWideUnop = (o: number): boolean => o === 0x7d || o === 0x7e || o === 0x80 || o === 0x81 || o === 0x83 || o === 0x86 || o === 0x88 || o === 0x89 || o === 0x8b;
  const isWideBinop = (o: number): boolean => (o >= 0x9b && o <= 0xa5) || (o >= 0xab && o <= 0xaf);
  const isWide2addr = (o: number): boolean => (o >= 0xbb && o <= 0xc5) || (o >= 0xcb && o <= 0xcf);

  for (let i = 0; i < units; ) {
    deadline.tick();
    if (targets.has(i)) known.clear();
    const pl = payloadLength(i);
    if (pl) {
      i += pl;
      continue;
    }
    const w = u(i);
    const opc = w & 0xff;
    const a4 = (w >> 8) & 0xf;
    const b4 = (w >> 12) & 0xf;
    const a8 = (w >> 8) & 0xff;
    if (opc === 0x01 || opc === 0x07) copy(a4, b4);
    else if (opc === 0x02 || opc === 0x08) copy(a8, u(i + 1));
    else if (opc === 0x03 || opc === 0x09) copy(u(i + 1), u(i + 2));
    else if (opc === 0x04) delWide(a4);
    else if (opc === 0x05) delWide(a8);
    else if (opc === 0x06) delWide(u(i + 1));
    else if (opc === 0x0a || opc === 0x0c || opc === 0x0d) del(a8);
    else if (opc === 0x0b) delWide(a8);
    else if (opc === 0x12) set(a4, { int: (b4 << 28) >> 28 });
    else if (opc === 0x13) set(a8, { int: s16(u(i + 1)) });
    else if (opc === 0x14) set(a8, { int: s32(i + 1) });
    else if (opc === 0x15) set(a8, { int: (u(i + 1) << 16) | 0 });
    else if (opc >= 0x16 && opc <= 0x19) delWide(a8);
    else if (opc === 0x1a || opc === 0x1b) {
      const idx = opc === 0x1a ? u(i + 1) : u(i + 1) + u(i + 2) * 65536;
      const str = string(idx);
      if (str === null) del(a8);
      else set(a8, { str: str.length > MAX_STRING ? str.slice(0, MAX_STRING) : str });
    } else if (opc === 0x1c || opc === 0x1f || opc === 0x22) del(a8);
    else if (opc === 0x20 || opc === 0x21 || opc === 0x23) del(a4);
    else if (opc >= 0x2d && opc <= 0x31) del(a8);
    else if (opc >= 0x44 && opc <= 0x4a) (opc === 0x45 ? delWide : del)(a8);
    else if (opc >= 0x52 && opc <= 0x58) (opc === 0x53 ? delWide : del)(a4);
    else if (opc >= 0x60 && opc <= 0x66) (opc === 0x61 ? delWide : del)(a8);
    else if (opc >= 0x7b && opc <= 0x8f) (isWideUnop(opc) ? delWide : del)(a4);
    else if (opc >= 0x90 && opc <= 0xaf) (isWideBinop(opc) ? delWide : del)(a8);
    else if (opc >= 0xb0 && opc <= 0xcf) (isWide2addr(opc) ? delWide : del)(a4);
    else if (opc >= 0xd0 && opc <= 0xd7) del(a4);
    else if (opc >= 0xd8 && opc <= 0xe2) del(a8);
    else if (opc === 0xfe || opc === 0xff) del(a8);
    else if ((opc >= 0x6e && opc <= 0x72) || opc === 0xfa) {
      const count = Math.min(w >> 12, 5);
      const x = u(i + 2);
      snapshot(i, [x & 0xf, (x >> 4) & 0xf, (x >> 8) & 0xf, (x >> 12) & 0xf, a4].slice(0, count));
    } else if ((opc >= 0x74 && opc <= 0x78) || opc === 0xfb) {
      const regs: number[] = [];
      for (let k = 0; k < a8; k++) regs.push(u(i + 2) + k);
      snapshot(i, regs);
    }
    i += opcodeLength(opc);
  }

  function snapshot(at: number, regs: number[]): void {
    const out: KnownArg[] = [];
    regs.forEach((r, arg) => {
      const v = known.get(r);
      if (!v) return;
      out.push("int" in v ? { arg, int: v.int, hex: hex(v.int) } : { arg, string: v.str });
    });
    if (out.length) sites.set(at, out);
  }

  return { sites, complete: true };
}
