import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { buildApk, cleanupTmp } from "./helpers/fixtures.js";
import { buildCodeDex, op, type Asm } from "./helpers/dexcode.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

const apkOf = (buf: Buffer): string => buildApk({ dex: [], extra: [{ name: "classes.dex", data: buf }] });
const T = { cls: "com.example.T", name: "f", params: ["I", "I", "I", "I"] };
const PENDING = { cls: "android.app.PendingIntent", name: "getActivity", params: ["Landroid/content/Context;", "I", "Landroid/content/Intent;", "I"], ret: "Landroid/app/PendingIntent;" };

interface Site {
  callee: string;
  op: string;
  known: { arg: number; int?: number; hex?: string; string?: string }[];
}

/** Builds a class with one method `m` (10 registers, `ins` incoming) and returns what apk_calls says about its constants. */
async function constants(units: (a: Asm) => number[], ins = 0): Promise<{ sites: Site[]; complete: boolean; all: Record<string, unknown> }> {
  const { buf } = buildCodeDex([{ name: "com.example.C", methods: [{ name: "m", code: { registers: 10, ins, outs: 5, units } }] }]);
  const r = await c.call("apk_calls", { path: apkOf(buf), class: "com.example.C", method: "m" });
  expect(r.isError, r.text).toBe(false);
  const m = r.data.matches[0];
  return { sites: m.callConstants, complete: m.constantsComplete, all: m };
}

describe("apk_calls: constants passed to calls", () => {
  it("reports integer constants of every const form, with sign and shift applied", async () => {
    const r = await constants((a) => [...op.const4(0, 5), ...op.const16(1, -2), ...op.const32(2, 0x12345678), ...op.constHigh16(3, 0x0400), ...op.invoke("static", a.method(T), [0, 1, 2, 3]), ...op.returnVoid()]);
    expect(r.complete).toBe(true);
    expect(r.sites).toEqual([
      {
        callee: "Lcom/example/T;->f(IIII)V",
        op: "invoke-static",
        known: [
          { arg: 0, int: 5, hex: "0x5" },
          { arg: 1, int: -2, hex: "0xfffffffe" },
          { arg: 2, int: 0x12345678, hex: "0x12345678" },
          { arg: 3, int: 0x04000000, hex: "0x4000000" },
        ],
      },
    ]);
  });

  it("reads a negative const/4", async () => {
    const r = await constants((a) => [...op.const4(0, -1), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(r.sites[0]!.known).toEqual([{ arg: 0, int: -1, hex: "0xffffffff" }]);
  });

  it("reports a string constant given as an argument", async () => {
    const r = await constants((a) => [...op.constString(0, a.string("com.example.ACTION")), ...op.invoke("virtual", a.method({ cls: "android.content.Intent", name: "setAction", params: ["Ljava/lang/String;"] }), [1, 0]), ...op.returnVoid()]);
    expect(r.sites[0]!.known).toEqual([{ arg: 1, string: "com.example.ACTION" }]);
  });

  it("follows plain moves and loses the value when the source is unknown", async () => {
    const moved = await constants((a) => [...op.const4(0, 7), ...op.move(1, 0), ...op.invoke("static", a.method(T), [1]), ...op.returnVoid()]);
    expect(moved.sites[0]!.known).toEqual([{ arg: 0, int: 7, hex: "0x7" }]);
    const lost = await constants((a) => [...op.const4(1, 9), ...op.move(1, 2), ...op.invoke("static", a.method(T), [1]), ...op.returnVoid()]);
    expect(lost.sites).toEqual([]);
  });

  it("forgets a register that arithmetic or a call result overwrote", async () => {
    const arithmetic = await constants((a) => [...op.const4(0, 1), ...op.addIntLit8(0, 0, 4), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(arithmetic.sites).toEqual([]);
    const result = await constants((a) => [...op.const4(0, 1), ...op.invoke("static", a.method({ cls: "com.example.T", name: "g", ret: "I" }), []), ...op.moveResult(0), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(result.sites).toEqual([]);
  });

  it("forgets both registers of a wide write", async () => {
    const r = await constants((a) => [...op.const4(1, 3), ...op.constWide(0), ...op.invoke("static", a.method(T), [1]), ...op.returnVoid()]);
    expect(r.sites).toEqual([]);
  });

  it("handles a range call", async () => {
    const r = await constants((a) => [...op.const4(0, 1), ...op.const4(1, 2), ...op.invokeRange("static", a.method(T), 0, 2), ...op.returnVoid()]);
    expect(r.sites[0]!.op).toBe("invoke-static/range");
    expect(r.sites[0]!.known.map((k) => k.int)).toEqual([1, 2]);
  });

  it("never treats a parameter register as a constant and lists nothing for a call with no known argument", async () => {
    const r = await constants((a) => [...op.invoke("static", a.method(T), [9, 8]), ...op.returnVoid()], 2);
    expect(r.sites).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it("does not claim a value where two paths meet", async () => {
    // @0 const v0=1; @1 if-eqz v2 -> @4; @3 const v0=2; @4 invoke f(v0): the call is a branch target.
    const r = await constants((a) => [...op.const4(0, 1), ...op.ifEqz(2, 3), ...op.const4(0, 2), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(r.sites).toEqual([]);
  });

  it("still reports a constant set after the join", async () => {
    const r = await constants((a) => [...op.const4(0, 1), ...op.ifEqz(2, 3), ...op.const4(0, 2), ...op.const4(0, 6), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(r.sites[0]!.known).toEqual([{ arg: 0, int: 6, hex: "0x6" }]);
  });

  it("does not trust straight-line order across a goto target", async () => {
    // @0 const v0=1; @1 goto -> @3; @2 const v0=2 (dead); @3 invoke f(v0)
    const r = await constants((a) => [...op.const4(0, 1), ...op.goto(2), ...op.const4(0, 2), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(r.sites).toEqual([]);
  });

  it("does not trust a packed-switch case target", async () => {
    // @0 const v0=1; @1 packed-switch v2 (payload @9); @4 const v2=0; @5 invoke f(v0) <- case target; @8 return; @9 payload
    const r = await constants((a) => [...op.const4(0, 1), ...op.packedSwitch(2, 8), ...op.const4(2, 0), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid(), ...op.packedSwitchPayloadTo([4])]);
    expect(r.sites).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it("gives up on a switch whose payload is outside the code, without failing", async () => {
    const r = await constants((a) => [...op.const4(0, 1), ...op.packedSwitch(2, 5000), ...op.invoke("static", a.method(T), [0]), ...op.returnVoid()]);
    expect(r.sites).toEqual([]);
    expect(r.complete).toBe(false);
    expect((r.all["code"] as { complete: boolean }).complete).toBe(true);
  });
});

describe("apk_calls: constants and exception handlers", () => {
  /**
   * @0 const v0=1; try { @1 const v0=2; @2 invoke g(); } @5 return; handler @6: invoke f(v0); @9 return.
   * The try table and the handler list are written into reserved padding units, after the real code.
   */
  async function withHandler(patch?: (buf: Buffer, tableAt: number) => void): Promise<{ sites: Site[]; complete: boolean }> {
    const code = (a: Asm): number[] => [
      ...op.const4(0, 1),
      ...op.const4(0, 2),
      ...op.invoke("static", a.method({ cls: "com.example.T", name: "g" }), []),
      ...op.returnVoid(),
      ...op.invoke("static", a.method(T), [0]),
      ...op.returnVoid(),
      ...new Array<number>(8).fill(0),
    ];
    const { buf, layout } = buildCodeDex([{ name: "com.example.C", methods: [{ name: "m", code: { registers: 10, ins: 0, outs: 5, units: code } }] }]);
    const item = layout.codeItemOff["Lcom/example/C;->m"]!;
    const realUnits = 10;
    buf.writeUInt32LE(realUnits, item + 12);
    buf.writeUInt16LE(1, item + 6);
    const tableAt = item + 16 + realUnits * 2;
    buf.writeUInt32LE(1, tableAt); // try_item.start_addr
    buf.writeUInt16LE(4, tableAt + 4); // insn_count
    buf.writeUInt16LE(1, tableAt + 6); // handler_off, after the list size byte
    buf[tableAt + 8] = 1; // encoded_catch_handler_list.size
    buf[tableAt + 9] = 0; // encoded_catch_handler.size: catch-all only
    buf[tableAt + 10] = 6; // catch_all_addr
    patch?.(buf, tableAt);
    const r = await c.call("apk_calls", { path: apkOf(buf), class: "com.example.C", method: "m" });
    expect(r.isError, r.text).toBe(false);
    return { sites: r.data.matches[0].callConstants, complete: r.data.matches[0].constantsComplete };
  }

  it("does not trust a constant at the entry of a catch handler", async () => {
    const r = await withHandler();
    expect(r.complete).toBe(true);
    expect(r.sites).toEqual([]);
  });

  it("gives up, without failing, when the try table does not fit in the file", async () => {
    const r = await withHandler((buf, tableAt) => buf.writeUInt16LE(60000, tableAt - 16 - 20 + 6));
    expect(r.complete).toBe(false);
    expect(r.sites).toEqual([]);
  });

  it("gives up when the handler list is cut short", async () => {
    const r = await withHandler((buf, tableAt) => buf.fill(0xff, tableAt + 8, tableAt + 11));
    expect(r.complete).toBe(false);
  });
});

describe("apk_xrefs: constants in the hits", () => {
  it("appends the known constants of a call site to its hit, and only then", async () => {
    const { buf } = buildCodeDex([
      {
        name: "com.example.C",
        methods: [
          { name: "known", code: { registers: 8, ins: 0, outs: 4, units: (a) => [...op.const4(1, 0), ...op.constHigh16(3, 0x0400), ...op.invoke("static", a.method(PENDING), [0, 1, 2, 3]), ...op.returnVoid()] } },
          { name: "unknown", code: { registers: 8, ins: 1, outs: 4, units: (a) => [...op.invoke("static", a.method(PENDING), [0, 1, 2, 7]), ...op.returnVoid()] } },
        ],
      },
    ]);
    const r = (await c.call("apk_xrefs", { path: apkOf(buf), method: "PendingIntent;->getActivity" })).data;
    const sig = "Landroid/app/PendingIntent;->getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;";
    const byMethod = Object.fromEntries(r.callers.map((x: { method: string; hits: string[] }) => [x.method.split("->")[1]!.split("(")[0], x.hits]));
    expect(byMethod["known"]).toEqual([`invoke-static ${sig} [arg1=0x0, arg3=0x4000000]`]);
    expect(byMethod["unknown"]).toEqual([`invoke-static ${sig}`]);
  });

  it("is bounded when a method has thousands of call sites with constants", async () => {
    const many = (a: Asm): number[] => {
      const out: number[] = [...op.const4(0, 1)];
      for (let i = 0; i < 1500; i++) out.push(...op.invoke("static", a.method(T), [0]));
      return [...out, ...op.returnVoid()];
    };
    const { buf } = buildCodeDex([{ name: "com.example.C", methods: [{ name: "m", code: { registers: 4, ins: 0, outs: 1, units: many } }] }]);
    const r = (await c.call("apk_calls", { path: apkOf(buf), class: "com.example.C", method: "m" })).data.matches[0];
    expect(r.callConstants.length).toBeLessThanOrEqual(200);
    expect(r.callConstants.length).toBeGreaterThan(0);
  });
});
