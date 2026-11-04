import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { cleanupTmp } from "./helpers/fixtures.js";
import { serviceApk } from "./helpers/svc.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

interface EntryMethod {
  declaredIn: string;
  name: string;
  parameters: { index: number; type: string; readCount: number; passedTo: string[] }[];
  callerChecks: { api: string; category: string; via: string[] }[];
  allowListCandidates: string[];
  permissionStrings: string[];
}
interface Component {
  name: string;
  kind: string;
  permission: string | null;
  found: boolean;
  assessment: string;
  entryMethods: EntryMethod[];
  observed: string[];
  unknown: string[];
}

async function checks(opts: Parameters<typeof serviceApk>[0], args: Record<string, unknown> = {}): Promise<{ components: Component[]; depth: number; limits: string[] }> {
  const { path } = serviceApk(opts);
  const r = await c.call("apk_entrypoint_checks", { path, ...args });
  expect(r.isError, r.text).toBe(false);
  return r.data;
}
const service = (r: { components: Component[] }): Component => r.components.find((x) => x.name === "com.example.app.MyService")!;
const onGetRoot = (r: { components: Component[] }): EntryMethod => service(r).entryMethods.find((m) => m.name === "onGetRoot")!;

describe("apk_entrypoint_checks", () => {
  it("analyses exported components only and skips the launcher activity", async () => {
    const r = await checks({ check: "none" });
    const names = r.components.map((x) => x.name);
    expect(names).toContain("com.example.app.MyService");
    expect(names).toContain("com.example.app.DataProvider");
    expect(names).toContain("com.example.app.BootReceiver");
    expect(names).not.toContain("com.example.app.SyncService");
    expect(names).not.toContain("com.example.app.MainActivity");
    expect(r.depth).toBe(3);
    expect(r.limits.length).toBeGreaterThan(0);
  });

  it("finds an inherited entry point and observes no caller check when there is none", async () => {
    const r = await checks({ check: "none" });
    const s = service(r);
    expect(s.found).toBe(true);
    expect(s.assessment).toBe("no-caller-check-observed");
    const m = onGetRoot(r);
    expect(m.declaredIn).toBe("com.example.app.Base");
    expect(m.callerChecks).toEqual([]);
    expect(m.parameters.map((p) => p.readCount)).toEqual([0, 0, 1]);
    expect(s.observed.join("\n")).toMatch(/clientPackageName|parameter/i);
    expect(s.unknown.length).toBeGreaterThan(0);
  });

  it("sees a caller-check API called directly by the entry point", async () => {
    const m = onGetRoot(await checks({ check: "direct" }));
    expect(m.callerChecks).toEqual([{ api: "Landroid/os/Binder;->getCallingUid()I", category: "uid", via: ["Lcom/example/app/Base;->onGetRoot(Ljava/lang/String;ILandroid/os/Bundle;)Landroid/service/media/MediaBrowserService$BrowserRoot;"] }]);
  });

  it("follows a helper, reports the path, the arguments passed on and the allow-list strings", async () => {
    const r = await checks({ check: "helper" });
    expect(service(r).assessment).toBe("caller-check-apis-observed");
    const m = onGetRoot(r);
    expect(m.callerChecks).toHaveLength(1);
    expect(m.callerChecks[0]).toMatchObject({ api: "Landroid/content/pm/PackageManager;->getPackagesForUid(I)[Ljava/lang/String;", category: "package" });
    expect(m.callerChecks[0]!.via.map((x) => x.split("->")[1]!.split("(")[0])).toEqual(["onGetRoot", "isAllowed"]);
    expect(m.parameters.map((p) => p.readCount)).toEqual([1, 1, 1]);
    expect(m.parameters[1]!.passedTo.some((x) => x.includes("Validator;->isAllowed"))).toBe(true);
    expect(m.allowListCandidates).toEqual(["com.android.systemui"]);
  });

  it("respects the depth", async () => {
    const shallow = onGetRoot(await checks({ check: "helper" }, { depth: 1 }));
    expect(shallow.callerChecks).toEqual([]);
  });

  it("resolves a call through an interface to its app implementation", async () => {
    const m = onGetRoot(await checks({ check: "interface" }));
    expect(m.callerChecks.map((x) => x.api)).toEqual(["Landroid/os/Binder;->getCallingUid()I"]);
    expect(m.callerChecks[0]!.via.some((x) => x.includes("GateImpl;->allow"))).toBe(true);
  });

  it("resolves a lambda-style class instantiated by the entry point", async () => {
    const m = onGetRoot(await checks({ check: "lambda" }));
    expect(m.callerChecks.map((x) => x.api)).toEqual(["Landroid/os/Binder;->getCallingUid()I"]);
    expect(m.callerChecks[0]!.via.some((x) => x.includes("Lambda;->run"))).toBe(true);
  });

  it("does not loop on a call cycle and still finds what is behind it", async () => {
    const m = onGetRoot(await checks({ check: "cycle" }));
    expect(m.callerChecks.map((x) => x.api)).toEqual(["Landroid/os/Binder;->getCallingPid()I"]);
  });

  it("analyses provider and receiver entry points and the permission strings they use", async () => {
    const r = await checks({ check: "none" });
    const provider = r.components.find((x) => x.name === "com.example.app.DataProvider")!;
    const query = provider.entryMethods.find((x) => x.name === "query")!;
    expect(query.callerChecks.map((x) => `${x.category}:${x.api.split("->")[1]!.split("(")[0]}`)).toEqual(["permission:enforceCallingPermission"]);
    expect(query.permissionStrings).toEqual(["renault.car.permission.RADIO"]);
    expect(query.allowListCandidates).toEqual([]);
    const receiver = r.components.find((x) => x.name === "com.example.app.BootReceiver")!;
    expect(receiver.permission).toBe("android.permission.RECEIVE_BOOT_COMPLETED");
    expect(receiver.entryMethods[0]!.name).toBe("onReceive");
  });

  it("says when the component class is not in the dex files instead of guessing", async () => {
    const r = await checks({ check: "none" });
    const missing = r.components.find((x) => x.name === "com.example.app.DeepLinkActivity")!;
    expect(missing.found).toBe(false);
    expect(missing.assessment).toBe("entry-point-not-found");
    expect(missing.entryMethods).toEqual([]);
  });

  it("reports the manifest permission of a component", async () => {
    const r = await checks({ check: "none", servicePermission: "com.example.app.permission.USE" });
    expect(service(r).permission).toBe("com.example.app.permission.USE");
  });

  it("filters by component and validates the depth", async () => {
    const { path } = serviceApk({ check: "none" });
    const one = (await c.call("apk_entrypoint_checks", { path, component: "myservice" })).data;
    expect(one.components.map((x: Component) => x.name)).toEqual(["com.example.app.MyService"]);
    expect((await c.call("apk_entrypoint_checks", { path, depth: 0 })).isError).toBe(true);
    expect((await c.call("apk_entrypoint_checks", { path, depth: 6 })).isError).toBe(true);
  });
});
