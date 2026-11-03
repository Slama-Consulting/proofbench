import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { collectXmlStrings, decodeAxml, isAxml } from "../src/axml.js";
import { DexFile, decodeMutf8, descriptorToName, dexOrder, isDexName, obfuscationHint } from "../src/dex.js";
import { Deadline } from "../src/errors.js";
import { interpretManifest, permissionRisk } from "../src/manifest.js";
import { assertSafeRegex } from "../src/regexsafe.js";
import { SecretScanner, mask } from "../src/secrets.js";
import { certificatesFromPkcs7, describeCertificate, readTlv, signatureAlgorithmOf } from "../src/signature.js";
import { apkOverview } from "../src/tools.js";
import { Apk } from "../src/apk.js";
import { ANDROID_NS, attr, buildAxml } from "./helpers/axmlwriter.js";
import { makeCert, pkcs7 } from "./helpers/certs.js";
import { buildDex, encodeMutf8 } from "./helpers/dexwriter.js";
import { buildApk, cleanupTmp, manifestTree } from "./helpers/fixtures.js";

afterAll(cleanupTmp);

describe("binary XML", () => {
  const tree = {
    name: "root",
    attrs: [attr("flag", true), attr("count", -5), attr("hexv", { hex: 0xff00 }), attr("ref", { ref: 0x7f010002 }), attr("plain", "value", null), attr("empty", "")],
    children: [{ name: "child", text: "some text", attrs: [attr("name", "n")] }, { name: "child" }],
  };

  for (const utf8 of [false, true]) {
    it(`decodes typed attributes with a ${utf8 ? "UTF-8" : "UTF-16"} string pool`, () => {
      const buf = buildAxml(tree, { utf8 });
      expect(isAxml(buf)).toBe(true);
      const root = decodeAxml(buf);
      expect(root.name).toBe("root");
      expect(root.attrs).toEqual({ "android:flag": true, "android:count": -5, "android:hexv": 0xff00, "android:ref": "@0x7f010002", plain: "value", "android:empty": "" });
      expect(root.children).toHaveLength(2);
      expect(root.children[0]).toMatchObject({ name: "child", text: "some text", attrs: { "android:name": "n" } });
      expect(collectXmlStrings(root)).toEqual(expect.arrayContaining(["value", "some text", "n"]));
    });
  }

  it("handles non-ASCII text and long strings in both encodings", () => {
    const long = "é€".repeat(200);
    for (const utf8 of [false, true]) {
      const root = decodeAxml(buildAxml({ name: "r", attrs: [attr("s", long)] }, { utf8 }));
      expect(root.attrs["android:s"]).toBe(long);
    }
  });

  it("uses the resource id map when attribute names are stripped", () => {
    const root = decodeAxml(buildAxml({ name: "r", attrs: [attr("exported", true), attr("unknownThing", 1)] }, { resIds: { exported: 0x01010010, unknownThing: 0x0199ffff }, stripNames: true }));
    expect(root.attrs).toEqual({ "android:exported": true, "android:attr_0x0199ffff": 1 });
  });

  it("exposes the namespace constant it recognises", () => {
    expect(ANDROID_NS).toBe("http://schemas.android.com/apk/res/android");
  });

  it("rejects bad magic and truncation", () => {
    expect(() => decodeAxml(Buffer.from("<?xml version"))).toThrow(/bad magic|too short/);
    expect(() => decodeAxml(Buffer.alloc(4))).toThrow(/too short/);
    const good = buildAxml(tree);
    expect(() => decodeAxml(good.subarray(0, good.length - 30))).toThrow(/malformed/);
    expect(() => decodeAxml(good.subarray(0, 40))).toThrow();
  });

  it("rejects excessive nesting", () => {
    let el: { name: string; children?: unknown[] } = { name: "leaf" };
    for (let i = 0; i < 200; i++) el = { name: "n", children: [el] };
    expect(() => decodeAxml(buildAxml(el as never))).toThrow(/nested too deeply/);
  });

  it("rejects an end element without a start", () => {
    const buf = buildAxml({ name: "r" });
    // Remove the start-element chunk (36 bytes) that follows the start-namespace chunk.
    const startNs = buf.indexOf(Buffer.from([0x00, 0x01, 0x10, 0x00]));
    const startEl = buf.indexOf(Buffer.from([0x02, 0x01, 0x10, 0x00]), startNs);
    const broken = Buffer.concat([buf.subarray(0, startEl), buf.subarray(startEl + 36)]);
    broken.writeUInt32LE(broken.length, 4);
    expect(() => decodeAxml(broken)).toThrow(/unbalanced|no root/);
  });
});

describe("manifest interpretation", () => {
  const interpret = (spec = {}) => interpretManifest(decodeAxml(buildAxml(manifestTree(spec))));

  it("qualifies component names", () => {
    expect(interpret().components.map((c) => c.name)).toEqual(["com.example.app.MainActivity", "com.example.app.DeepLinkActivity", "com.example.app.SyncService", "com.example.app.BootReceiver", "com.example.app.DataProvider"]);
  });

  it("classifies permissions", () => {
    expect(permissionRisk("android.permission.READ_SMS")).toBe("dangerous");
    expect(permissionRisk("android.permission.MANAGE_EXTERNAL_STORAGE")).toBe("special");
    expect(permissionRisk("android.permission.INTERNET")).toBe("normal");
    expect(permissionRisk("com.vendor.permission.READ_SMS")).toBe("normal");
    expect(permissionRisk("com.android.voicemail.permission.ADD_VOICEMAIL")).toBe("dangerous");
  });

  it("treats providers as exported by default below API 17", () => {
    const tree = { name: "manifest", attrs: [attr("package", "p", null)], children: [{ name: "uses-sdk", attrs: [attr("minSdkVersion", 9)] }, { name: "application", children: [{ name: "provider", attrs: [attr("name", ".P"), attr("authorities", "a")] }] }] };
    const m = interpretManifest(decodeAxml(buildAxml(tree)));
    expect(m.components[0]).toMatchObject({ exported: true, exportedSource: "default" });
  });

  it("survives a manifest with no application element", () => {
    const m = interpretManifest(decodeAxml(buildAxml({ name: "manifest", attrs: [attr("package", "p", null)] })));
    expect(m.components).toEqual([]);
    expect(m.application.networkSecurityConfig).toBeNull();
    expect(m.sdk.target).toBeNull();
  });
});

describe("DEX", () => {
  it("decodes modified UTF-8", () => {
    const samples = ["plain", "café", "€ uro", "nul\0inside", "emoji \u{1F600}"];
    for (const s of samples) {
      const enc = encodeMutf8(s);
      expect(decodeMutf8(enc, 0, enc.length)).toBe(s);
    }
    expect(decodeMutf8(Buffer.from([0x41, 0xff, 0x42]), 0, 3)).toBe("A�B");
    expect(encodeMutf8("\0")).toEqual(Buffer.from([0xc0, 0x80]));
  });

  it("converts descriptors", () => {
    expect(descriptorToName("Lcom/example/Foo;")).toBe("com.example.Foo");
    expect(descriptorToName("Lcom/example/Foo$Bar;")).toBe("com.example.Foo$Bar");
    expect(descriptorToName("[I")).toBe("[I");
    expect(descriptorToName("L;")).toBe("L;");
  });

  it("reads strings and class definitions", () => {
    const dex = new DexFile("classes.dex", buildDex({ strings: ["one", "twoé"], classes: [{ name: "x.Y", superclass: "java.lang.Object", accessFlags: 0x4011 }, { name: "x.Z" }] }), new Deadline());
    const strings: string[] = [];
    dex.forEachString((s) => strings.push(s));
    expect(strings).toEqual(expect.arrayContaining(["one", "twoé", "Lx/Y;", "Ljava/lang/Object;"]));
    const classes: unknown[] = [];
    dex.forEachClass((c) => classes.push(c));
    expect(classes).toEqual([
      { name: "x.Y", superclass: "java.lang.Object", accessFlags: 0x4011, access: ["public", "final", "enum"] },
      { name: "x.Z", superclass: null, accessFlags: 1, access: ["public"] },
    ]);
    expect(dex.string(9999)).toBeNull();
    expect(dex.typeName(0xffffffff)).toBeNull();
  });

  it("orders and recognises dex names", () => {
    expect(["classes10.dex", "classes2.dex", "classes.dex"].sort(dexOrder)).toEqual(["classes.dex", "classes2.dex", "classes10.dex"]);
    expect(isDexName("classes3.dex")).toBe(true);
    expect(isDexName("assets/classes.dex")).toBe(false);
    expect(isDexName("classesX.dex")).toBe(false);
  });

  it("estimates obfuscation", () => {
    expect(obfuscationHint(["com.example.MainActivity", "com.example.util.Helper", "com.example.R$layout"]).verdict).toBe("unlikely");
    expect(obfuscationHint(["a.a", "a.b", "a.c", "b.a", "com.example.Real"]).verdict).toBe("likely");
    expect(obfuscationHint([]).sampled).toBe(0);
    expect(obfuscationHint(["com.x.Foo$1", "com.x.Foo$2"]).sampled).toBe(0);
  });

  it("times out deterministically", () => {
    const dex = new DexFile("d", buildDex({ strings: Array.from({ length: 3000 }, (_, i) => `s${i}`) }), new Deadline(-1));
    expect(() => dex.forEachString(() => undefined)).toThrow(/time limit/);
  });
});

describe("regex safety", () => {
  it.each(["(a+)+", "(a*)*b", "(a|aa)+", "(.*)*", "(a|b)*c", "((a+)b)+", "(a)\\1", "a*b*c*d*", "x".repeat(201)])("rejects %s", (p) => {
    expect(() => assertSafeRegex(p)).toThrow();
  });
  it.each(["^abc$", "https?://[a-z.]+/", "AKIA[0-9A-Z]{16}", "(foo|bar)baz", "(a|b){2}", "\\d+\\.\\d+", "[+*]+x", "a\\+b"])("accepts %s", (p) => {
    expect(() => assertSafeRegex(p)).not.toThrow();
  });
  it("rejects invalid syntax", () => {
    expect(() => assertSafeRegex("[")).toThrow(/invalid regular expression/);
  });
});

describe("secret scanner", () => {
  it("masks values", () => {
    expect(mask("AKIAABCDEFGHIJKLMNOP")).toBe("AKIA…[20]");
    expect(mask("abcdef")).toBe("abc…[6]");
    expect(mask("x")).toBe("x…[1]");
  });

  it("detects the documented shapes", () => {
    const s = new SecretScanner();
    const samples: [string, string][] = [
      ["aws-access-key-id", "key=ASIA" + "ABCDEFGHIJKLMNOP"],
      ["slack-token", "xoxb-" + "1234567890-abcdefghij"],
      ["stripe-secret-key", "sk_live_" + "abcdefghijklmnop1234"],
      ["github-token", "ghp_" + "a".repeat(36)],
      ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
      ["private-key-pem", "-----BEGIN PRIVATE KEY-----"],
      ["gcp-service-account-json", '{"type": "service_account", "project_id": "x"}'],
      ["twilio-api-key", "SK" + "0123456789abcdef0123456789abcdef"],
      ["generic-secret-assignment", "client_secret: 'abcdefghijklmnopqrstu'"],
      ["bearer-authorization", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
    ];
    for (const [, text] of samples) s.scan(text, "t");
    const types = new Set(s.findings.map((f) => f.type));
    for (const [type] of samples) expect(types, type).toContain(type);
    expect(s.findings.every((f) => f.maskedValue.includes("…["))).toBe(true);
  });

  it("deduplicates and ignores short or clean strings", () => {
    const s = new SecretScanner();
    s.scan("AKIA" + "ABCDEFGHIJKLMNOP", "a");
    s.scan("AKIA" + "ABCDEFGHIJKLMNOP", "a");
    s.scan("short", "a");
    s.scan("nothing to see in this ordinary sentence", "a");
    expect(s.findings).toHaveLength(1);
  });

  it("strips query strings and fragments from URLs and recognises schema hosts", () => {
    const s = new SecretScanner();
    s.scan("see http://schemas.android.com/apk/res/android and https://api.test.io:8443/v1/x?key=SECRET#frag, ws://chat.test.io/socket", "a");
    const hosts = Object.fromEntries([...s.hosts.values()].map((h) => [h.host, h]));
    expect(hosts["schemas.android.com"]).toMatchObject({ likelyNamespace: true, cleartext: false });
    expect(hosts["api.test.io"]?.samples).toEqual(["https://api.test.io:8443/v1/x"]);
    expect(hosts["chat.test.io"]).toMatchObject({ cleartext: true });
    expect(JSON.stringify([...s.hosts.values()])).not.toContain("SECRET");
  });

  it("stops at the findings cap", () => {
    const s = new SecretScanner();
    for (let i = 0; i < 700; i++) s.scan(`AKIA${String(i).padStart(16, "0")}`, "loc");
    expect(s.findings.length).toBe(500);
    expect(s.truncated).toBe(true);
  });
});

describe("DER and certificates", () => {
  it("reads TLVs with long-form lengths and rejects bad ones", () => {
    const long = Buffer.concat([Buffer.from([0x04, 0x82, 0x01, 0x00]), Buffer.alloc(256)]);
    expect(readTlv(long, 0, long.length)).toMatchObject({ tag: 4, body: 4, end: 260 });
    expect(() => readTlv(Buffer.from([0x30, 0x80, 0x00, 0x00]), 0, 4)).toThrow(/indefinite/);
    expect(() => readTlv(Buffer.from([0x30, 0x05, 0x00]), 0, 3)).toThrow(/past its container/);
    expect(() => readTlv(Buffer.from([0x30]), 0, 1)).toThrow(/truncated/);
    expect(() => readTlv(Buffer.from([0x30, 0x85, 1, 2, 3, 4, 5]), 0, 7)).toThrow(/bad length/);
    expect(() => readTlv(Buffer.from([0x1f, 0x01, 0x00]), 0, 3)).toThrow(/multi-byte tags/);
  });

  it("describes an RSA certificate and its signature algorithm", () => {
    const { der } = makeCert({ cn: "RSA Signer", alg: "rsa" });
    const info = describeCertificate(der);
    expect(info).toMatchObject({ subject: "CN=RSA Signer", selfSigned: true, signatureAlgorithm: "sha256WithRSAEncryption", publicKey: { type: "rsa", sizeBits: 2048 }, expired: false, notYetValid: false });
    expect(signatureAlgorithmOf(der)).toBe("sha256WithRSAEncryption");
    expect(signatureAlgorithmOf(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it("flags expired, not-yet-valid and issuer mismatch", () => {
    const { der } = makeCert({ cn: "Leaf", issuerCn: "Some CA", notBefore: new Date("2020-01-01T00:00:00Z"), notAfter: new Date("2021-01-01T00:00:00Z") });
    expect(describeCertificate(der, new Date("2025-01-01T00:00:00Z"))).toMatchObject({ expired: true, selfSigned: false, issuer: "CN=Some CA" });
    expect(describeCertificate(der, new Date("2019-01-01T00:00:00Z"))).toMatchObject({ expired: false, notYetValid: true });
  });

  it("rejects bytes that are not a certificate", () => {
    expect(() => describeCertificate(Buffer.from("nope"))).toThrow(/could not be parsed/);
  });

  it("extracts certificates from PKCS#7 and handles a blob without any", () => {
    const { der } = makeCert();
    expect(certificatesFromPkcs7(pkcs7(der))).toEqual([der]);
    const noCerts = Buffer.from("3015060b2a864886f70d010702a0060404020300", "hex");
    expect(() => certificatesFromPkcs7(noCerts)).toThrow();
  });
});

describe("overview details", () => {
  it("reports the real sha256 and size of the file", () => {
    const path = buildApk({ signing: "v1" });
    const apk = Apk.open(path);
    try {
      const o = apkOverview(apk) as { sha256: string; fileSize: number; signingSchemes: unknown };
      const bytes = readFileSync(path);
      expect(o.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(o.fileSize).toBe(bytes.length);
      expect(o.signingSchemes).toEqual({ v1: true, v2: false, v3: false, v31: false });
    } finally {
      apk.close();
    }
  });
});
