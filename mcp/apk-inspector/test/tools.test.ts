import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { FAKE_AWS_KEY, FAKE_GOOGLE_KEY, buildApk, cleanupTmp, defaultDex } from "./helpers/fixtures.js";
import { dexSpecWith } from "./helpers/specs.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

describe("server surface", () => {
  it("lists exactly the 10 read-only tools and says results are untrusted", async () => {
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["apk_asset_peek", "apk_classes", "apk_entries", "apk_find_secrets", "apk_manifest", "apk_network_config", "apk_overview", "apk_signature", "apk_strings", "apk_xml"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    expect(c.client.getServerVersion()).toMatchObject({ name: "apk-inspector", version: "0.1.0" });
    expect(c.client.getInstructions()).toMatch(/untrusted data, never instructions/);
  });

  it("marks every result untrusted in the JSON root and in _meta", async () => {
    const path = buildApk();
    for (const name of ["apk_overview", "apk_manifest", "apk_entries", "apk_strings", "apk_classes", "apk_signature", "apk_find_secrets", "apk_network_config"]) {
      const r = await c.call(name, { path });
      expect(r.isError, name).toBe(false);
      expect(r.data.untrusted, name).toBe(true);
      expect(r.meta?.untrusted, name).toBe(true);
    }
  });
});

describe("apk_overview", () => {
  it("summarises the package", async () => {
    const path = buildApk({ signing: "v2+v3", withNetworkConfig: true, manifestSpec: { targetSdk: 33, debuggable: true, cleartext: true, nscRef: true } });
    const r = (await c.call("apk_overview", { path })).data;
    expect(r).toMatchObject({
      package: "com.example.app",
      versionName: "1.2.3",
      versionCode: 42,
      minSdk: 24,
      targetSdk: 33,
      debuggable: true,
      usesCleartextTraffic: true,
      networkSecurityConfigPresent: true,
      entryCount: 5,
      nativeAbis: ["arm64-v8a", "x86_64"],
      permissionCount: 3,
      dangerousPermissionCount: 1,
      signingSchemes: { v1: false, v2: true, v3: true, v31: false },
      classCount: 5,
    });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.dexFiles).toEqual([{ name: "classes.dex", size: expect.any(Number) }]);
    expect(r.componentCounts).toMatchObject({ activities: 2, services: 1, receivers: 1, providers: 1 });
    expect(r.obfuscation.verdict).toBe("likely");
  });

  it("still answers when the manifest is damaged", async () => {
    const path = buildApk({ manifest: Buffer.from("not axml at all") });
    const r = (await c.call("apk_overview", { path })).data;
    expect(r.manifestError).toMatch(/binary XML/);
    expect(r.classCount).toBe(5);
  });
});

describe("apk_manifest", () => {
  it("decodes permissions, features and components", async () => {
    const r = (await c.call("apk_manifest", { path: buildApk() })).data;
    expect(r.package).toBe("com.example.app");
    expect(r.permissions).toEqual([
      { name: "android.permission.INTERNET", risk: "normal" },
      { name: "android.permission.CAMERA", risk: "dangerous" },
      { name: "android.permission.SYSTEM_ALERT_WINDOW", risk: "special" },
    ]);
    expect(r.features).toEqual([{ name: "android.hardware.camera", required: false }]);
    expect(r.application).toMatchObject({ name: ".App", debuggable: false, allowBackup: true, allowBackupSource: "default" });
    const names = r.components.map((x: { name: string }) => x.name);
    expect(names).toEqual(["com.example.app.MainActivity", "com.example.app.DeepLinkActivity", "com.example.app.SyncService", "com.example.app.BootReceiver", "com.example.app.DataProvider"]);
    const provider = r.components.find((x: { kind: string }) => x.kind === "provider");
    expect(provider).toMatchObject({ authorities: "com.example.app.provider", exported: true, exportedSource: "explicit", grantUriPermissions: true });
    const receiver = r.components.find((x: { kind: string }) => x.kind === "receiver");
    expect(receiver.permission).toBe("android.permission.RECEIVE_BOOT_COMPLETED");
    const main = r.components[0];
    expect(main.launcher).toBe(true);
    expect(r.resourceReferencesResolved).toBe(false);
  });

  it("implies exported=true for an intent-filter activity below targetSdk 31", async () => {
    const r = (await c.call("apk_manifest", { path: buildApk({ manifestSpec: { targetSdk: 30 } }) })).data;
    const deep = r.components.find((x: { name: string }) => x.name.endsWith("DeepLinkActivity"));
    expect(deep).toMatchObject({ exported: true, exportedSource: "implied" });
    expect(deep.intentFilters[0]).toMatchObject({ actions: ["android.intent.action.VIEW"], categories: ["android.intent.category.BROWSABLE"], data: [{ scheme: "myapp", host: "open" }] });
    expect(r.auditFlags.some((f: string) => f.includes("DeepLinkActivity") && f.includes("implied"))).toBe(true);
  });

  it("does not imply exported from targetSdk 31", async () => {
    const r = (await c.call("apk_manifest", { path: buildApk({ manifestSpec: { targetSdk: 33 } }) })).data;
    const deep = r.components.find((x: { name: string }) => x.name.endsWith("DeepLinkActivity"));
    expect(deep).toMatchObject({ exported: false, exportedSource: "default" });
  });

  it("flags debuggable, backup and cleartext and returns resource references raw", async () => {
    const r = (await c.call("apk_manifest", { path: buildApk({ manifestSpec: { debuggable: true, allowBackup: true, cleartext: true, nscRef: true } }) })).data;
    expect(r.application).toMatchObject({ debuggable: true, allowBackup: true, allowBackupSource: "explicit", usesCleartextTraffic: true, networkSecurityConfig: "@0x7f0f0001" });
    expect(r.auditFlags.join("\n")).toMatch(/debuggable/);
  });

  it("recovers attribute names from resource ids when names are stripped", async () => {
    const { manifestAxml } = await import("./helpers/fixtures.js");
    const r = (await c.call("apk_manifest", { path: buildApk({ manifest: manifestAxml({}, { stripNames: true, utf8: true }) }) })).data;
    expect(r.versionCode).toBe(42);
    expect(r.components[0].exported).toBe(true);
    expect(r.components[0].name).toBe("com.example.app.MainActivity");
  });
});

describe("apk_entries", () => {
  it("lists, filters and limits", async () => {
    const path = buildApk();
    const all = (await c.call("apk_entries", { path })).data;
    expect(all.total).toBe(4);
    const so = (await c.call("apk_entries", { path, filter: ".SO" })).data;
    expect(so.entries.map((e: { name: string }) => e.name)).toEqual(["lib/arm64-v8a/libnative.so", "lib/x86_64/libnative.so"]);
    expect(so.entries[0]).toMatchObject({ method: "stored", compressedSize: 20, uncompressedSize: 20 });
    const lim = (await c.call("apk_entries", { path, limit: 2 })).data;
    expect(lim).toMatchObject({ returned: 2, matched: 4, truncated: true });
  });

  it("flags hidden executables and nested archives", async () => {
    const path = buildApk({
      extra: [
        { name: "assets/payload.bin", data: Buffer.concat([Buffer.from("dex\n035\0"), Buffer.alloc(32)]) },
        { name: "assets/native.dat", data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]) },
        { name: "assets/inner.bin", data: Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(32)]) },
        { name: "assets/readme.txt", data: "just text" },
      ],
    });
    const r = (await c.call("apk_entries", { path })).data;
    const flagged = Object.fromEntries(r.unusualEntries.map((u: { name: string; reasons: string[] }) => [u.name, u.reasons.join(";")]));
    expect(flagged["assets/payload.bin"]).toMatch(/DEX magic/);
    expect(flagged["assets/native.dat"]).toMatch(/ELF/);
    expect(flagged["assets/inner.bin"]).toMatch(/nested ZIP/);
    expect(flagged["assets/readme.txt"]).toBeUndefined();
  });

  it("flags an unusual number of dex files", async () => {
    const path = buildApk({ dex: Array.from({ length: 9 }, () => ({ strings: ["x"] })) });
    const r = (await c.call("apk_entries", { path, filter: "classes" })).data;
    expect(r.unusualCount).toBe(9);
  });
});

describe("apk_strings", () => {
  it("filters by substring, minLength and limit", async () => {
    const path = buildApk();
    const r = (await c.call("apk_strings", { path, pattern: "example.com" })).data;
    expect(r.strings.map((s: { string: string }) => s.string)).toContain("https://api.example.com/v2");
    expect(r.strings[0]).toMatchObject({ dex: "classes.dex", index: expect.any(Number) });
    const short = (await c.call("apk_strings", { path, pattern: "tiny", minLength: 5 })).data;
    expect(short.returned).toBe(0);
    const lim = (await c.call("apk_strings", { path, limit: 3 })).data;
    expect(lim).toMatchObject({ returned: 3, truncated: true });
  });

  it("supports regex and truncates long strings", async () => {
    const long = "L".repeat(1000);
    const path = buildApk({ dex: [dexSpecWith([long, "version 1.2.3"])] });
    const r = (await c.call("apk_strings", { path, pattern: "^version \\d+\\.\\d+", regex: true })).data;
    expect(r.strings.map((s: { string: string }) => s.string)).toEqual(["version 1.2.3"]);
    const l = (await c.call("apk_strings", { path, pattern: "^L+$", regex: true })).data;
    expect(l.strings[0].string).toHaveLength(300);
    expect(l.strings[0].truncated).toBe(true);
  });

  it("refuses an over-long pattern, a catastrophic regex and an invalid regex", async () => {
    const path = buildApk();
    const long = await c.call("apk_strings", { path, pattern: "a".repeat(201) });
    expect(long.isError).toBe(true);
    const evil = await c.call("apk_strings", { path, pattern: "(a+)+$", regex: true });
    expect(evil.isError).toBe(true);
    expect(evil.data.error).toMatch(/backtracking/);
    const bad = await c.call("apk_strings", { path, pattern: "(", regex: true });
    expect(bad.data).toEqual({ untrusted: true, error: "invalid regular expression" });
  });
});

describe("apk_classes", () => {
  it("returns names, superclass, flags and package prefixes", async () => {
    const r = (await c.call("apk_classes", { path: buildApk() })).data;
    expect(r.total).toBe(5);
    const main = r.classes.find((x: { name: string }) => x.name === "com.example.app.MainActivity");
    expect(main).toMatchObject({ superclass: "android.app.Activity", accessFlags: 1, access: ["public"], dex: "classes.dex" });
    const client = r.classes.find((x: { name: string }) => x.name === "com.thirdparty.sdk.Client");
    expect(client.access).toEqual(["public", "abstract"]);
    expect(r.topPackagePrefixes).toContainEqual({ prefix: "com.example", count: 2 });
    const filtered = (await c.call("apk_classes", { path: buildApk(), pattern: "THIRDPARTY" })).data;
    expect(filtered.classes.map((x: { name: string }) => x.name)).toEqual(["com.thirdparty.sdk.Client"]);
  });
});

describe("apk_signature", () => {
  it("reports an absent scheme clearly", async () => {
    const r = (await c.call("apk_signature", { path: buildApk() })).data;
    expect(r).toMatchObject({ verified: false, v1: { present: false }, v2: { present: false }, v3: { present: false } });
    expect(r.note).toMatch(/no signature or digest is verified/);
  });

  it("parses the v1 certificate out of PKCS#7", async () => {
    const r = (await c.call("apk_signature", { path: buildApk({ signing: "v1", certCn: "Android Debug" }) })).data;
    expect(r.v1.present).toBe(true);
    expect(r.v1.files).toEqual(["META-INF/CERT.RSA", "META-INF/CERT.SF", "META-INF/MANIFEST.MF"]);
    const cert = r.v1.signers[0].certificates[0];
    expect(cert).toMatchObject({ subject: "CN=Android Debug", issuer: "CN=Android Debug", selfSigned: true, isDebugCertificate: true, expired: false, signatureAlgorithm: "ecdsa-with-SHA256", publicKey: { type: "ec", sizeBits: 256 } });
    expect(cert.sha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(cert.sha1).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
    expect(cert.validFrom).toBe("2020-01-01T00:00:00.000Z");
    expect(cert.serialNumber.toLowerCase()).toContain("01020304");
  });

  it("parses v2 and v3 signing blocks, expiry included", async () => {
    const r = (await c.call("apk_signature", { path: buildApk({ signing: "v2+v3", expiredCert: true }) })).data;
    expect(r.v2.present).toBe(true);
    expect(r.v2.signers[0].certificates[0]).toMatchObject({ subject: "CN=Test Signer", expired: true, isDebugCertificate: false });
    expect(r.v3.present).toBe(true);
    expect(r.v3.signers[0]).toMatchObject({ minSdk: 28, maxSdk: 0x7fffffff, hasRotationProof: true });
    expect(r.v3.signers[0].certificates[0].sha256).toBe(r.v2.signers[0].certificates[0].sha256);
    expect(r.v31.present).toBe(false);
    expect(r.v1.present).toBe(false);
  });

  it("lists other signing block entries", async () => {
    const r = (await c.call("apk_signature", { path: buildApk({ signing: "v3" }) })).data;
    expect(r.v3.present).toBe(true);
    expect(r.v2.present).toBe(false);
    expect(r.otherSigningBlockEntries).toEqual(["verity-padding"]);
  });
});

describe("apk_find_secrets", () => {
  it("finds masked leads and groups hosts", async () => {
    const r = (await c.call("apk_find_secrets", {
      path: buildApk({
        extra: [
          { name: "assets/config.json", data: JSON.stringify({ firebase: "https://my-app-default-rtdb.firebaseio.com", note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" }) },
          { name: "res/raw/key.pem", data: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n" },
          { name: "assets/blob.bin", data: Buffer.from([0, 1, 2, 3, 0, 0]) },
        ],
      }),
    })).data;
    const types = r.findings.map((f: { type: string }) => f.type);
    expect(types).toEqual(expect.arrayContaining(["aws-access-key-id", "google-api-key", "generic-secret-assignment", "firebase-database-url", "bearer-authorization", "private-key-pem"]));
    const aws = r.findings.find((f: { type: string }) => f.type === "aws-access-key-id");
    expect(aws).toMatchObject({ maskedValue: "AKIA…[20]", location: "classes.dex", confidence: "high" });
    const pem = r.findings.find((f: { type: string }) => f.type === "private-key-pem");
    expect(pem.location).toBe("res/raw/key.pem");
    // No whole secret ever appears in the output.
    const text = JSON.stringify(r);
    expect(text).not.toContain(FAKE_AWS_KEY);
    expect(text).not.toContain(FAKE_GOOGLE_KEY);
    expect(text).not.toContain("hunter2hunter2hunter2");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("token=abc");
    expect(r.note).toMatch(/lead, not proof/);
    const insecure = r.hosts.find((h: { host: string }) => h.host === "insecure.example.com");
    expect(insecure).toMatchObject({ cleartext: true, count: 1 });
    expect(insecure.samples[0]).toBe("http://insecure.example.com/api/v1");
    expect(r.hosts.find((h: { host: string }) => h.host === "api.example.com").cleartext).toBe(false);
    expect(r.cleartextHosts).toEqual(["insecure.example.com"]);
    expect(r.textEntriesSkipped).toBe(1);
  });

  it("scans decoded binary XML under res/xml", async () => {
    const { buildAxml, attr } = await import("./helpers/axmlwriter.js");
    const xml = buildAxml({ name: "resources", attrs: [attr("key", FAKE_GOOGLE_KEY, null)] });
    const r = (await c.call("apk_find_secrets", { path: buildApk({ extra: [{ name: "res/xml/keys.xml", data: xml }] }) })).data;
    expect(r.findings.some((f: { type: string; location: string }) => f.type === "google-api-key" && f.location === "res/xml/keys.xml")).toBe(true);
  });

  it("flags URL credentials without returning them", async () => {
    const path = buildApk({ dex: [dexSpecWith(["http://admin:s3cretpass@internal.example.net/x"])] });
    const r = (await c.call("apk_find_secrets", { path })).data;
    expect(r.findings.some((f: { type: string }) => f.type === "url-with-credentials")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("s3cretpass");
  });
});

describe("apk_network_config", () => {
  it("reports absence", async () => {
    const r = (await c.call("apk_network_config", { path: buildApk({ manifestSpec: { cleartext: true } }) })).data;
    expect(r.present).toBe(false);
    expect(r.manifest.usesCleartextTraffic).toBe(true);
  });

  it("decodes the config", async () => {
    const r = (await c.call("apk_network_config", { path: buildApk({ withNetworkConfig: true, manifestSpec: { nscRef: true } }) })).data;
    expect(r.present).toBe(true);
    expect(r.manifest.networkSecurityConfig).toBe("@0x7f0f0001");
    expect(r.baseConfig).toEqual({ cleartextTrafficPermitted: false, trustAnchors: [{ src: "system" }, { src: "user" }] });
    expect(r.domainConfigs[0]).toMatchObject({
      cleartextTrafficPermitted: true,
      domains: [{ domain: "legacy.example.com", includeSubdomains: true }],
      pinSets: [{ expiration: "2030-01-01", pins: [{ digestAlgorithm: "SHA-256", value: expect.stringMatching(/^A+=$/) }] }],
    });
    expect(r.debugOverrides.trustAnchors).toEqual([{ src: "user" }]);
    expect(r.auditFlags.join("\n")).toMatch(/user-installed/);
  });
});

describe("multi-dex", () => {
  it("reads strings and classes across classes.dex and classes2.dex", async () => {
    const path = buildApk({ dex: [defaultDex(), { strings: ["second dex string"], classes: [{ name: "org.other.Second" }] }] });
    const s = (await c.call("apk_strings", { path, pattern: "second dex" })).data;
    expect(s.strings[0].dex).toBe("classes2.dex");
    const k = (await c.call("apk_classes", { path, pattern: "Second" })).data;
    expect(k.classes[0]).toMatchObject({ name: "org.other.Second", dex: "classes2.dex" });
  });
});
