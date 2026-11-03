import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attr, buildAxml, type AxmlEl } from "./axmlwriter.js";
import { buildDex, type DexSpec } from "./dexwriter.js";
import { makeCert, pkcs7, v2Value, v3Value } from "./certs.js";
import { buildSigningBlock, buildZip, type ZipFile } from "./zipwriter.js";

const dirs: string[] = [];

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "apk-inspector-test-"));
  dirs.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function writeTmp(name: string, data: Buffer | string): string {
  const p = join(tmpDir(), name);
  writeFileSync(p, data);
  return p;
}

export const RES_IDS = {
  name: 0x01010003,
  exported: 0x01010010,
  debuggable: 0x0101000f,
  allowBackup: 0x01010280,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  usesCleartextTraffic: 0x010104ec,
  networkSecurityConfig: 0x01010527,
  authorities: 0x01010018,
  permission: 0x01010006,
  scheme: 0x01010027,
  host: 0x01010028,
};

export interface ManifestSpec {
  targetSdk?: number;
  minSdk?: number;
  debuggable?: boolean;
  allowBackup?: boolean;
  cleartext?: boolean;
  nscRef?: boolean;
}

/** A realistic manifest: permissions, one launcher activity, an intent-filter activity without `exported`, a service, a provider. */
export function manifestTree(m: ManifestSpec = {}): AxmlEl {
  const appAttrs = [attr("name", ".App")];
  if (m.debuggable !== undefined) appAttrs.push(attr("debuggable", m.debuggable));
  if (m.allowBackup !== undefined) appAttrs.push(attr("allowBackup", m.allowBackup));
  if (m.cleartext !== undefined) appAttrs.push(attr("usesCleartextTraffic", m.cleartext));
  if (m.nscRef) appAttrs.push(attr("networkSecurityConfig", { ref: 0x7f0f0001 }));
  return {
    name: "manifest",
    attrs: [attr("versionCode", 42), attr("versionName", "1.2.3"), attr("package", "com.example.app", null)],
    children: [
      { name: "uses-sdk", attrs: [attr("minSdkVersion", m.minSdk ?? 24), attr("targetSdkVersion", m.targetSdk ?? 30)] },
      { name: "uses-permission", attrs: [attr("name", "android.permission.INTERNET")] },
      { name: "uses-permission", attrs: [attr("name", "android.permission.CAMERA")] },
      { name: "uses-permission", attrs: [attr("name", "android.permission.SYSTEM_ALERT_WINDOW")] },
      { name: "uses-feature", attrs: [attr("name", "android.hardware.camera"), attr("required", false)] },
      {
        name: "application",
        attrs: appAttrs,
        children: [
          {
            name: "activity",
            attrs: [attr("name", ".MainActivity"), attr("exported", true)],
            children: [{ name: "intent-filter", children: [{ name: "action", attrs: [attr("name", "android.intent.action.MAIN")] }, { name: "category", attrs: [attr("name", "android.intent.category.LAUNCHER")] }] }],
          },
          {
            name: "activity",
            attrs: [attr("name", "com.example.app.DeepLinkActivity")],
            children: [
              {
                name: "intent-filter",
                children: [
                  { name: "action", attrs: [attr("name", "android.intent.action.VIEW")] },
                  { name: "category", attrs: [attr("name", "android.intent.category.BROWSABLE")] },
                  { name: "data", attrs: [attr("scheme", "myapp"), attr("host", "open")] },
                ],
              },
            ],
          },
          { name: "service", attrs: [attr("name", "SyncService"), attr("exported", false)] },
          { name: "receiver", attrs: [attr("name", ".BootReceiver"), attr("permission", "android.permission.RECEIVE_BOOT_COMPLETED"), attr("exported", true)] },
          { name: "provider", attrs: [attr("name", ".DataProvider"), attr("authorities", "com.example.app.provider"), attr("exported", true), attr("grantUriPermissions", true)] },
        ],
      },
    ],
  };
}

export function manifestAxml(m: ManifestSpec = {}, opts: { stripNames?: boolean; utf8?: boolean } = {}): Buffer {
  return buildAxml(manifestTree(m), { resIds: RES_IDS, ...opts });
}

const na = (name: string, value: string | boolean) => attr(name, value, null);

export function networkConfigAxml(): Buffer {
  return buildAxml({
    name: "network-security-config",
    children: [
      { name: "base-config", attrs: [na("cleartextTrafficPermitted", false)], children: [{ name: "trust-anchors", children: [{ name: "certificates", attrs: [na("src", "system")] }, { name: "certificates", attrs: [na("src", "user")] }] }] },
      {
        name: "domain-config",
        attrs: [na("cleartextTrafficPermitted", true)],
        children: [
          { name: "domain", attrs: [na("includeSubdomains", true)], text: "legacy.example.com" },
          { name: "pin-set", attrs: [na("expiration", "2030-01-01")], children: [{ name: "pin", attrs: [na("digest", "SHA-256")], text: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }] },
        ],
      },
      { name: "debug-overrides", children: [{ name: "trust-anchors", children: [{ name: "certificates", attrs: [na("src", "user")] }] }] },
    ],
  });
}

export const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
export const FAKE_GOOGLE_KEY = "AIza" + "Sy0A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";

export function defaultDex(): DexSpec {
  return {
    strings: ["hello world", FAKE_AWS_KEY, "http://insecure.example.com/api/v1?token=abc", "https://api.example.com/v2", `password="hunter2hunter2hunter2"`, FAKE_GOOGLE_KEY, "tiny"],
    classes: [
      { name: "com.example.app.MainActivity", superclass: "android.app.Activity", accessFlags: 0x1 },
      { name: "com.example.app.util.Helper", superclass: "java.lang.Object", accessFlags: 0x11 },
      { name: "com.thirdparty.sdk.Client", superclass: "java.lang.Object", accessFlags: 0x401 },
      { name: "a.b", superclass: "java.lang.Object" },
      { name: "a.c", superclass: "java.lang.Object" },
    ],
  };
}

export interface ApkSpec {
  manifest?: Buffer | null;
  dex?: DexSpec[];
  extra?: ZipFile[];
  signing?: "none" | "v1" | "v2" | "v3" | "v2+v3";
  manifestSpec?: ManifestSpec;
  withNetworkConfig?: boolean;
  certCn?: string;
  expiredCert?: boolean;
}

export function buildApkBuffer(spec: ApkSpec = {}): Buffer {
  const files: ZipFile[] = [];
  if (spec.manifest !== null) files.push({ name: "AndroidManifest.xml", data: spec.manifest ?? manifestAxml(spec.manifestSpec) });
  (spec.dex ?? [defaultDex()]).forEach((d, i) => files.push({ name: i === 0 ? "classes.dex" : `classes${i + 1}.dex`, data: buildDex(d) }));
  if (spec.withNetworkConfig) files.push({ name: "res/xml/network_security_config.xml", data: networkConfigAxml() });
  files.push({ name: "lib/arm64-v8a/libnative.so", data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16)]), method: "store" });
  files.push({ name: "lib/x86_64/libnative.so", data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16)]), method: "store" });
  files.push(...(spec.extra ?? []));
  const signing = spec.signing ?? "none";
  const cert = makeCert({ cn: spec.certCn ?? "Test Signer", ...(spec.expiredCert ? { notAfter: new Date("2021-01-01T00:00:00Z") } : {}) });
  if (signing === "v1") {
    files.push({ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\n" });
    files.push({ name: "META-INF/CERT.SF", data: "Signature-Version: 1.0\n" });
    files.push({ name: "META-INF/CERT.RSA", data: pkcs7(cert.der) });
  }
  let block: Buffer | undefined;
  if (signing === "v2" || signing === "v2+v3") {
    const pairs = [{ id: 0x7109871a, value: v2Value([cert.der]) }];
    if (signing === "v2+v3") pairs.push({ id: 0xf05368c0, value: v3Value([cert.der], 28, 0x7fffffff, true) });
    block = buildSigningBlock(pairs);
  } else if (signing === "v3") {
    block = buildSigningBlock([{ id: 0xf05368c0, value: v3Value([cert.der]) }, { id: 0x42726577, value: Buffer.alloc(8) }]);
  }
  return buildZip(files, block ? { beforeCentralDirectory: block } : {});
}

export function buildApk(spec: ApkSpec = {}): string {
  return writeTmp("fixture.apk", buildApkBuffer(spec));
}
