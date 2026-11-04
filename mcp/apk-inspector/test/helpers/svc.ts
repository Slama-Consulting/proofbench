import { attr, buildAxml, type AxmlEl } from "./axmlwriter.js";
import { RES_IDS, buildApk, manifestTree } from "./fixtures.js";
import { buildCodeDex, op, type Asm, type CodeClassSpec, type CodeDexLayout, type MethodSig } from "./dexcode.js";

export const BINDER_UID: MethodSig = { cls: "android.os.Binder", name: "getCallingUid", ret: "I" };
export const BINDER_PID: MethodSig = { cls: "android.os.Binder", name: "getCallingPid", ret: "I" };
export const PM_PACKAGES: MethodSig = { cls: "android.content.pm.PackageManager", name: "getPackagesForUid", params: ["I"], ret: "[Ljava/lang/String;" };
export const CTX_ENFORCE: MethodSig = { cls: "android.content.Context", name: "enforceCallingPermission", params: ["Ljava/lang/String;", "Ljava/lang/String;"] };

export type Check = "none" | "direct" | "helper" | "interface" | "lambda" | "cycle";

export interface SvcOpts {
  check?: Check;
  /** `android:permission` on the exported service. */
  servicePermission?: string;
  /** Replace the generated classes entirely. */
  classes?: CodeClassSpec[];
}

const ROOT = "android.service.media.MediaBrowserService$BrowserRoot";
const ROOT_D = `L${ROOT.replace(/\./g, "/")};`;
const GET_ROOT_PARAMS = ["Ljava/lang/String;", "I", "Landroid/os/Bundle;"];

/** onGetRoot is instance code: v4 = this, v5 = clientPackageName, v6 = clientUid, v7 = rootHints. */
function onGetRoot(check: Check): CodeClassSpec["methods"] {
  const body = (a: Asm): number[] => {
    const build = [...op.newInstance(0, a.type(ROOT_D)), ...op.constString(1, a.string("root")), ...op.invoke("direct", a.method({ cls: ROOT, name: "<init>", params: ["Ljava/lang/String;", "Landroid/os/Bundle;"] }), [0, 1, 7]), ...op.retObject(0)];
    switch (check) {
      case "direct":
        return [...op.invoke("static", a.method(BINDER_UID), []), ...op.moveResult(2), ...build];
      case "helper":
        return [...op.invoke("static", a.method({ cls: "com.example.app.Validator", name: "isAllowed", params: ["Ljava/lang/String;", "I"], ret: "Z" }), [5, 6]), ...op.moveResult(2), ...op.ifEqz(2, 8), ...build];
      case "interface":
        return [...op.iget(3, 4, 0), ...op.invoke("interface", a.method({ cls: "com.example.app.Gate", name: "allow", params: ["I"], ret: "Z" }), [3, 6]), ...op.moveResult(2), ...build];
      case "lambda":
        return [...op.newInstance(3, a.type("Lcom/example/app/Base$$Lambda;")), ...op.invoke("interface", a.method({ cls: "java.lang.Runnable", name: "run" }), [3]), ...build];
      case "cycle":
        return [...op.invoke("static", a.method({ cls: "com.example.app.A", name: "a" }), []), ...build];
      default:
        return build;
    }
  };
  return [{ name: "onGetRoot", params: GET_ROOT_PARAMS, ret: ROOT_D, code: { registers: 8, ins: 4, outs: 3, units: body } }];
}

export function serviceClasses(check: Check): CodeClassSpec[] {
  const classes: CodeClassSpec[] = [
    { name: "com.example.app.Base", superclass: "android.service.media.MediaBrowserService", methods: onGetRoot(check) },
    { name: "com.example.app.MyService", superclass: "com.example.app.Base" },
    {
      name: "com.example.app.DataProvider",
      superclass: "android.content.ContentProvider",
      methods: [
        {
          name: "query",
          params: ["Landroid/net/Uri;"],
          ret: "Landroid/database/Cursor;",
          code: { registers: 6, ins: 2, outs: 3, units: (a) => [...op.constString(0, a.string("renault.car.permission.RADIO")), ...op.invoke("virtual", a.method(CTX_ENFORCE), [2, 0, 0]), ...op.constString(1, a.string("not a package name")), ...op.retObject(1)] },
        },
      ],
    },
    { name: "com.example.app.BootReceiver", superclass: "android.content.BroadcastReceiver", methods: [{ name: "onReceive", params: ["Landroid/content/Context;", "Landroid/content/Intent;"], code: { registers: 4, ins: 3, units: op.returnVoid() } }] },
  ];
  if (check === "helper") {
    classes.push({
      name: "com.example.app.Validator",
      methods: [
        {
          name: "isAllowed",
          params: ["Ljava/lang/String;", "I"],
          ret: "Z",
          flags: 0x9,
          direct: true,
          code: { registers: 6, ins: 2, outs: 2, units: (a) => [...op.constString(0, a.string("com.android.systemui")), ...op.invoke("virtual", a.method(PM_PACKAGES), [1, 5]), ...op.moveResultObject(2), ...op.ret(0)] },
        },
      ],
    });
  }
  if (check === "interface") {
    classes.push(
      { name: "com.example.app.Gate", flags: 0x601, methods: [{ name: "allow", params: ["I"], ret: "Z", flags: 0x401 }] },
      { name: "com.example.app.GateImpl", interfaces: ["com.example.app.Gate"], methods: [{ name: "allow", params: ["I"], ret: "Z", code: { registers: 4, ins: 2, outs: 0, units: (a) => [...op.invoke("static", a.method(BINDER_UID), []), ...op.moveResult(0), ...op.ret(0)] } }] },
    );
  }
  if (check === "lambda") {
    classes.push({ name: "com.example.app.Base$$Lambda", interfaces: ["java.lang.Runnable"], methods: [{ name: "run", code: { registers: 2, ins: 1, units: (a) => [...op.invoke("static", a.method(BINDER_UID), []), ...op.moveResult(0), ...op.returnVoid()] } }] });
  }
  if (check === "cycle") {
    classes.push(
      { name: "com.example.app.A", methods: [{ name: "a", flags: 0x9, direct: true, code: { registers: 2, ins: 0, units: (a) => [...op.invoke("static", a.method({ cls: "com.example.app.B", name: "b" }), []), ...op.returnVoid()] } }] },
      { name: "com.example.app.B", methods: [{ name: "b", flags: 0x9, direct: true, code: { registers: 2, ins: 0, units: (a) => [...op.invoke("static", a.method({ cls: "com.example.app.A", name: "a" }), []), ...op.invoke("static", a.method(BINDER_PID), []), ...op.returnVoid()] } }] },
    );
  }
  return classes;
}

/** The fixture manifest plus one exported service. */
export function manifestWithService(permission?: string): Buffer {
  const tree = manifestTree();
  const app = tree.children!.find((x) => x.name === "application")!;
  const svc: AxmlEl = { name: "service", attrs: [attr("name", "com.example.app.MyService"), attr("exported", true), ...(permission ? [attr("permission", permission)] : [])] };
  app.children = [...(app.children ?? []), svc];
  return buildAxml(tree, { resIds: RES_IDS });
}

export function serviceApk(o: SvcOpts = {}): { path: string; buf: Buffer; layout: CodeDexLayout } {
  const { buf, layout } = buildCodeDex(o.classes ?? serviceClasses(o.check ?? "none"));
  const path = buildApk({ manifest: manifestWithService(o.servicePermission), dex: [], extra: [{ name: "classes.dex", data: buf }], signing: "v2" });
  return { path, buf, layout };
}

/** The fixture manifest where the exported provider carries the given permissions. */
export function providerApk(perms: { permission?: string; read?: string; write?: string }): { path: string } {
  const tree = manifestTree();
  const app = tree.children!.find((x) => x.name === "application")!;
  const provider = app.children!.find((x) => x.name === "provider")!;
  provider.attrs = [...(provider.attrs ?? [])];
  if (perms.permission) provider.attrs.push(attr("permission", perms.permission));
  if (perms.read) provider.attrs.push(attr("readPermission", perms.read));
  if (perms.write) provider.attrs.push(attr("writePermission", perms.write));
  const { buf } = buildCodeDex(serviceClasses("none"));
  return { path: buildApk({ manifest: buildAxml(tree, { resIds: RES_IDS }), dex: [], extra: [{ name: "classes.dex", data: buf }], signing: "v2" }) };
}
