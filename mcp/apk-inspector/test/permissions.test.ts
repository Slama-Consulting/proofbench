import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { cleanupTmp } from "./helpers/fixtures.js";
import { providerApk, serviceApk } from "./helpers/svc.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

interface Comp {
  name: string;
  permission: string | null;
  readPermission: string | null;
  writePermission: string | null;
  observed: string[];
}

async function provider(perms: Parameters<typeof providerApk>[0]): Promise<Comp> {
  const { path } = providerApk(perms);
  const r = await c.call("apk_entrypoint_checks", { path, component: "DataProvider" });
  expect(r.isError, r.text).toBe(false);
  return r.data.components.find((x: Comp) => x.name === "com.example.app.DataProvider");
}

describe("apk_entrypoint_checks: provider read and write permissions", () => {
  it("reports the read and the write permission of a provider", async () => {
    const p = await provider({ read: "com.example.permission.READ_DATA", write: "com.example.permission.WRITE_DATA" });
    expect(p.readPermission).toBe("com.example.permission.READ_DATA");
    expect(p.writePermission).toBe("com.example.permission.WRITE_DATA");
    expect(p.permission).toBeNull();
    const text = p.observed.join("\n");
    expect(text).toMatch(/read permission com\.example\.permission\.READ_DATA/);
    expect(text).toMatch(/write permission com\.example\.permission\.WRITE_DATA/);
  });

  it("reports one of them alone and null for the other", async () => {
    const readOnly = await provider({ read: "com.example.permission.READ_DATA" });
    expect(readOnly.readPermission).toBe("com.example.permission.READ_DATA");
    expect(readOnly.writePermission).toBeNull();
    const writeOnly = await provider({ write: "com.example.permission.WRITE_DATA" });
    expect(writeOnly.readPermission).toBeNull();
    expect(writeOnly.writePermission).toBe("com.example.permission.WRITE_DATA");
  });

  it("keeps android:permission apart from the read and write permissions", async () => {
    const p = await provider({ permission: "com.example.permission.ALL" });
    expect(p.permission).toBe("com.example.permission.ALL");
    expect(p.readPermission).toBeNull();
    expect(p.writePermission).toBeNull();
  });

  it("says nothing about permissions for a provider that has none", async () => {
    const p = await provider({});
    expect(p.permission).toBeNull();
    expect(p.readPermission).toBeNull();
    expect(p.writePermission).toBeNull();
    expect(p.observed.join("\n")).not.toMatch(/read permission|write permission/);
  });

  it("gives every component the two fields, null outside providers", async () => {
    const { path } = serviceApk({ check: "none" });
    const r = await c.call("apk_entrypoint_checks", { path });
    for (const comp of r.data.components as Comp[]) {
      expect(comp, comp.name).toHaveProperty("readPermission");
      expect(comp, comp.name).toHaveProperty("writePermission");
    }
    const service = (r.data.components as Comp[]).find((x) => x.name === "com.example.app.MyService")!;
    expect(service.readPermission).toBeNull();
    expect(service.writePermission).toBeNull();
  });
});
