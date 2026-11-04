import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { buildApk, cleanupTmp } from "./helpers/fixtures.js";
import { buildCodeDex, op, type CodeClassSpec } from "./helpers/dexcode.js";
import { PM_PACKAGES, serviceApk } from "./helpers/svc.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

const apkOf = (buf: Buffer): string => buildApk({ dex: [], extra: [{ name: "classes.dex", data: buf }] });
const GETPKG_SIG = "Landroid/content/pm/PackageManager;->getPackagesForUid(I)[Ljava/lang/String;";

describe("apk_methods", () => {
  it("lists the methods of a class with prototype, access, kind and code size", async () => {
    const { path } = serviceApk({ check: "interface" });
    const r = (await c.call("apk_methods", { path, class: "com.example.app.Base" })).data;
    const cls = r.classes.find((x: { name: string }) => x.name === "com.example.app.Base");
    expect(cls.superclass).toBe("android.service.media.MediaBrowserService");
    const m = cls.methods.find((x: { name: string }) => x.name === "onGetRoot");
    expect(m.proto).toBe("(Ljava/lang/String;ILandroid/os/Bundle;)Landroid/service/media/MediaBrowserService$BrowserRoot;");
    expect(m.kind).toBe("virtual");
    expect(m.access).toContain("public");
    expect(m.code).toMatchObject({ registers: 8, ins: 4, outs: 3 });
    expect(m.code.units).toBeGreaterThan(5);
    expect(r.untrusted).toBe(true);
  });

  it("shows interfaces, abstract methods without code, and honours the limit", async () => {
    const { path } = serviceApk({ check: "interface" });
    const impl = (await c.call("apk_methods", { path, class: "com.example.app.GateImpl" })).data.classes[0];
    expect(impl.interfaces).toEqual(["com.example.app.Gate"]);
    const gate = (await c.call("apk_methods", { path, class: "com.example.app.Gate" })).data.classes.find((x: { name: string }) => x.name === "com.example.app.Gate");
    expect(gate.methods[0]).toMatchObject({ name: "allow", code: null });
    expect(gate.methods[0].access).toContain("abstract");
    const limited = (await c.call("apk_methods", { path, class: "com.example", limit: 2 })).data;
    expect(limited.returnedMethods).toBe(2);
    expect(limited.truncated).toBe(true);
  });

  it("reports a damaged class_data_item as an error on that class, not a crash", async () => {
    const { buf, layout } = buildCodeDex([{ name: "com.example.Broken", methods: [{ name: "m", code: { registers: 1, ins: 1, units: op.returnVoid() } }] }]);
    buf.writeUInt32LE(layout.fileSize + 50, layout.classDefsOff + 24);
    const r = await c.call("apk_methods", { path: apkOf(buf), class: "Broken" });
    expect(r.isError).toBe(false);
    expect(r.data.classes[0].error).toMatch(/class data/);
  });

  it("survives a ULEB128 that never ends", async () => {
    const { buf, layout } = buildCodeDex([{ name: "com.example.Broken", methods: [{ name: "m", code: { registers: 1, ins: 1, units: op.returnVoid() } }] }]);
    const at = layout.classDataOff["com.example.Broken"]!;
    buf.fill(0xff, at, Math.min(buf.length, at + 12));
    const r = await c.call("apk_methods", { path: apkOf(buf), class: "Broken" });
    expect(r.isError).toBe(false);
    expect(r.data.classes[0].error).toMatch(/class data/);
  });

  it("reports a dex whose prototype table lies outside the file", async () => {
    const { buf, layout } = buildCodeDex([{ name: "com.example.Broken", methods: [{ name: "m", code: { registers: 1, ins: 1, units: op.returnVoid() } }] }]);
    buf.writeUInt32LE(layout.fileSize + 100, 76);
    const r = await c.call("apk_methods", { path: apkOf(buf), class: "Broken" });
    expect(r.isError).toBe(false);
    expect(r.data.classes).toEqual([]);
    expect(r.data.dexErrors[0].error).toMatch(/proto_ids/);
  });
});

describe("apk_calls", () => {
  it("lists callees, strings and parameter usage of a method", async () => {
    const { path } = serviceApk({ check: "helper" });
    const r = (await c.call("apk_calls", { path, class: "com.example.app.Validator", method: "isAllowed" })).data;
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0];
    expect(m.sig).toBe("Lcom/example/app/Validator;->isAllowed(Ljava/lang/String;I)Z");
    expect(m.calls).toEqual([{ callee: GETPKG_SIG, op: "invoke-virtual", inApp: false, count: 1 }]);
    expect(m.strings).toEqual(["com.android.systemui"]);
    expect(m.code).toMatchObject({ registers: 6, ins: 2, instructions: 4, complete: true });
    expect(m.parameters).toEqual([
      { index: 0, type: "Ljava/lang/String;", register: 4, readCount: 0, passedTo: [] },
      { index: 1, type: "I", register: 5, readCount: 1, passedTo: [GETPKG_SIG] },
    ]);
    expect(m.transitive).toBeUndefined();
  });

  it("marks calls into the app and follows them with depth", async () => {
    const { path } = serviceApk({ check: "helper" });
    const r = (await c.call("apk_calls", { path, class: "com.example.app.Base", method: "onGetRoot", depth: 2 })).data.matches[0];
    const validator = r.calls.find((x: { callee: string }) => x.callee.includes("Validator;->isAllowed"));
    expect(validator).toMatchObject({ op: "invoke-static", inApp: true });
    expect(r.transitive.appMethods.map((x: { sig: string; depth: number }) => `${x.depth}:${x.sig}`)).toContain("1:Lcom/example/app/Validator;->isAllowed(Ljava/lang/String;I)Z");
    expect(r.transitive.externalCalls.map((x: { callee: string }) => x.callee)).toContain(GETPKG_SIG);
    expect(r.transitive.strings).toContain("com.android.systemui");
    const shallow = (await c.call("apk_calls", { path, class: "com.example.app.Base", method: "onGetRoot", depth: 1 })).data.matches[0];
    expect(shallow.transitive.externalCalls.map((x: { callee: string }) => x.callee)).not.toContain(GETPKG_SIG);
  });

  it("walks every kind of instruction to exactly the end of the code, payloads included", async () => {
    const methods: CodeClassSpec["methods"] = [
      {
        name: "mix",
        code: {
          registers: 8,
          ins: 1,
          outs: 4,
          units: (a) => [
            ...op.const4(0, 1),
            ...op.constWide(2),
            ...op.constStringJumbo(1, a.string("jumbo")),
            ...op.invokePolymorphic(a.method({ cls: "java.lang.invoke.MethodHandle", name: "invoke" }), 0, [1, 2]),
            ...op.invokeRange("virtual", a.method(PM_PACKAGES), 3, 2),
            ...op.addInt(0, 1, 2),
            ...op.ifEqz(0, 3),
            ...op.goto(1),
            ...op.returnVoid(),
            ...op.packedSwitchPayload(3),
            ...op.sparseSwitchPayload(2),
            ...op.fillArrayDataPayload(4, 5),
          ],
        },
      },
    ];
    const { buf } = buildCodeDex([{ name: "com.example.Mix", methods }]);
    const m = (await c.call("apk_calls", { path: apkOf(buf), class: "com.example.Mix", method: "mix" })).data.matches[0];
    expect(m.code.complete).toBe(true);
    expect(m.code.instructions).toBe(12);
    expect(m.strings).toEqual(["jumbo"]);
    expect(m.calls.map((x: { op: string }) => x.op).sort()).toEqual(["invoke-polymorphic", "invoke-virtual/range"]);
  });

  it("flags code that does not end where it should, with the reason", async () => {
    const { buf } = buildCodeDex([{ name: "com.example.Bad", methods: [{ name: "m", code: { registers: 2, ins: 1, units: [...op.const4(0, 1), 0x0100, 0x7fff] } }] }]);
    const m = (await c.call("apk_calls", { path: apkOf(buf), class: "com.example.Bad", method: "m" })).data.matches[0];
    expect(m.code.complete).toBe(false);
    expect(m.code.error).toMatch(/payload|past the end/);
  });

  it("rejects a code item that claims more instructions than the file holds", async () => {
    const { buf, layout } = buildCodeDex([{ name: "com.example.Big", methods: [{ name: "m", code: { registers: 1, ins: 1, units: op.returnVoid() } }] }]);
    buf.writeUInt32LE(0x7fffffff, layout.codeItemOff["Lcom/example/Big;->m"]! + 12);
    const m = (await c.call("apk_calls", { path: apkOf(buf), class: "com.example.Big", method: "m" })).data.matches[0];
    expect(m.code.complete).toBe(false);
    expect(m.code.error).toMatch(/past the end of the file/);
  });

  it("counts references to methods and strings that do not exist instead of failing", async () => {
    const { buf } = buildCodeDex([{ name: "com.example.Ghost", methods: [{ name: "m", code: { registers: 2, ins: 1, units: [...op.invoke("static", 0xfff0, []), ...op.constString(0, 0xfff1), ...op.returnVoid()] } }] }]);
    const r = await c.call("apk_calls", { path: apkOf(buf), class: "com.example.Ghost", method: "m" });
    expect(r.isError).toBe(false);
    expect(r.data.matches[0].unresolvedRefs).toBe(2);
    expect(r.data.matches[0].calls).toEqual([]);
  });

  it("terminates on a call cycle and clamps the depth", async () => {
    const { path } = serviceApk({ check: "cycle" });
    const r = await c.call("apk_calls", { path, class: "com.example.app.Base", method: "onGetRoot", depth: 5 });
    const names = r.data.matches[0].transitive.appMethods.map((x: { sig: string }) => x.sig);
    expect(names).toContain("Lcom/example/app/A;->a()V");
    expect(names).toContain("Lcom/example/app/B;->b()V");
    expect(new Set(names).size).toBe(names.length);
    expect((await c.call("apk_calls", { path, class: "com.example.app.Base", method: "onGetRoot", depth: 6 })).isError).toBe(true);
  });

  it("finds nothing for an unknown class or method, and says so", async () => {
    const { path } = serviceApk();
    expect((await c.call("apk_calls", { path, class: "com.example.Nope", method: "x" })).data.matches).toEqual([]);
    expect((await c.call("apk_calls", { path, class: "com.example.app.Base", method: "nope" })).data.matches).toEqual([]);
  });
});

describe("apk_xrefs", () => {
  it("finds the callers of a method and the users of a string", async () => {
    const { path } = serviceApk({ check: "helper" });
    const byMethod = (await c.call("apk_xrefs", { path, method: "getPackagesForUid" })).data;
    expect(byMethod.callers.map((x: { method: string }) => x.method)).toEqual(["Lcom/example/app/Validator;->isAllowed(Ljava/lang/String;I)Z"]);
    expect(byMethod.callers[0].hits).toEqual([`invoke-virtual ${GETPKG_SIG}`]);
    const byString = (await c.call("apk_xrefs", { path, string: "systemui" })).data;
    expect(byString.callers[0].hits).toEqual(['string "com.android.systemui"']);
  });

  it("needs a method or a string, and caps the answer", async () => {
    const { path } = serviceApk({ check: "helper" });
    const none = await c.call("apk_xrefs", { path });
    expect(none.isError).toBe(true);
    expect(none.data.error).toMatch(/method and\/or string/);
    const capped = (await c.call("apk_xrefs", { path, method: "->", limit: 1 })).data;
    expect(capped.callers).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });
});
