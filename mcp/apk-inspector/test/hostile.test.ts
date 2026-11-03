import { closeSync, openSync, truncateSync, writeSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { buildApkBuffer, cleanupTmp, tmpDir, writeTmp } from "./helpers/fixtures.js";
import { buildDex } from "./helpers/dexwriter.js";
import { buildZip } from "./helpers/zipwriter.js";
import { join } from "node:path";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

const TOOLS = ["apk_overview", "apk_manifest", "apk_entries", "apk_strings", "apk_classes", "apk_signature", "apk_find_secrets", "apk_network_config"];

/** Every tool must return a well-formed error result for this file, never throw or hang. */
async function expectErrorEverywhere(path: string, message: RegExp): Promise<void> {
  for (const name of TOOLS) {
    const r = await c.call(name, { path });
    expect(r.isError, name).toBe(true);
    expect(r.data.untrusted, name).toBe(true);
    expect(r.data.error, name).toMatch(message);
    expect(Object.keys(r.data).sort(), name).toEqual(["error", "untrusted"]);
    expect(r.meta?.untrusted, name).toBe(true);
  }
}

describe("path validation", () => {
  it("rejects a missing file", async () => {
    await expectErrorEverywhere(join(tmpDir(), "nope.apk"), /not found/);
  });
  it("rejects a relative path", async () => {
    await expectErrorEverywhere("relative/app.apk", /absolute/);
  });
  it("rejects a directory", async () => {
    await expectErrorEverywhere(tmpDir(), /regular file/);
  });
  it("rejects an empty file", async () => {
    await expectErrorEverywhere(writeTmp("empty.apk", Buffer.alloc(0)), /empty/);
  });
  it("rejects a non-ZIP file", async () => {
    await expectErrorEverywhere(writeTmp("text.apk", "this is plainly not an archive, just some text".repeat(5)), /not a ZIP/);
  });
  it("rejects a NUL byte in the path and a non-string path", async () => {
    const r = await c.call("apk_overview", { path: "/tmp/a\0b.apk" });
    expect(r.isError).toBe(true);
    const r2 = await c.call("apk_overview", { path: 42 });
    expect(r2.isError).toBe(true);
    const r3 = await c.call("apk_overview", {});
    expect(r3.isError).toBe(true);
  });
  it("refuses files larger than 1 GiB without reading them", async () => {
    const p = writeTmp("huge.apk", Buffer.from("PK\x03\x04"));
    truncateSync(p, 1024 * 1024 * 1024 + 1);
    const r = await c.call("apk_overview", { path: p });
    expect(r.data.error).toMatch(/larger than the 1 GiB limit/);
  });
});

describe("malformed ZIP", () => {
  const good = buildApkBuffer();

  it("a truncated archive", async () => {
    await expectErrorEverywhere(writeTmp("trunc.apk", good.subarray(0, Math.floor(good.length / 2))), /end of central directory not found/);
  });

  it("a PK header with a garbage body", async () => {
    await expectErrorEverywhere(writeTmp("pk.apk", Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100, 0x41)])), /end of central directory not found/);
  });

  it("a central directory offset beyond the file", async () => {
    const b = Buffer.from(good);
    const eocd = b.length - 22;
    b.writeUInt32LE(0x7fffffff, eocd + 16);
    await expectErrorEverywhere(writeTmp("cdoff.apk", b), /central directory lies beyond/);
  });

  it("an entry count that the directory cannot hold", async () => {
    const b = Buffer.from(good);
    b.writeUInt16LE(60000, b.length - 22 + 10);
    await expectErrorEverywhere(writeTmp("count.apk", b), /central directory is truncated/);
  });

  it("a central directory entry with a bad signature", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt32LE(0xdeadbeef, cd);
    await expectErrorEverywhere(writeTmp("cdsig.apk", b), /bad signature/);
  });

  it("a name length running past the directory", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt16LE(0xffff, cd + 28);
    await expectErrorEverywhere(writeTmp("namelen.apk", b), /runs past the directory/);
  });

  it("a local header offset that points nowhere", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt32LE(b.length + 1000, cd + 42); // first entry: AndroidManifest.xml
    const p = writeTmp("lho.apk", b);
    for (const name of ["apk_manifest", "apk_overview"]) {
      const r = await c.call(name, { path: p });
      expect(r.data.untrusted).toBe(true);
      expect(JSON.stringify(r.data)).toMatch(/beyond end of file|bad local header/);
    }
  });

  it("an entry whose compressed size runs past the file", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt32LE(0x7ffffff0, cd + 20);
    const r = await c.call("apk_manifest", { path: writeTmp("csize.apk", b) });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/too large|beyond the end/);
  });

  it("a corrupt deflate stream", async () => {
    const b = Buffer.from(good);
    // First entry (manifest) data starts right after its 30-byte header and 20-byte name.
    const dataStart = 30 + "AndroidManifest.xml".length;
    for (let i = 0; i < 16; i++) b[dataStart + i] = 0xff;
    const r = await c.call("apk_manifest", { path: writeTmp("deflate.apk", b) });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/corrupt/);
  });

  it("rejects an encrypted entry", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt16LE(1, cd + 8);
    const r = await c.call("apk_manifest", { path: writeTmp("enc.apk", b) });
    expect(r.data.error).toMatch(/encrypted/);
  });

  it("unsupported compression method", async () => {
    const b = Buffer.from(good);
    const cd = b.readUInt32LE(b.length - 22 + 16);
    b.writeUInt16LE(12, cd + 10);
    const r = await c.call("apk_manifest", { path: writeTmp("method.apk", b) });
    expect(r.data.error).toMatch(/unsupported compression method 12/);
  });
});

describe("unsupported formats", () => {
  it("names the Android App Bundle", async () => {
    const p = writeTmp("a.aab", buildZip([{ name: "BundleConfig.pb", data: "x" }, { name: "base/manifest/AndroidManifest.xml", data: "x" }]));
    await expectErrorEverywhere(p, /Android App Bundle \(\.aab\)/);
  });
  it("names the XAPK bundle", async () => {
    const p = writeTmp("a.xapk", buildZip([{ name: "manifest.json", data: "{}" }, { name: "com.example.apk", data: "x" }]));
    await expectErrorEverywhere(p, /XAPK/);
  });
  it("names the APK set", async () => {
    await expectErrorEverywhere(writeTmp("a.apks", buildZip([{ name: "toc.pb", data: "x" }])), /\.apks/);
  });
  it("rejects a plain ZIP without a manifest", async () => {
    await expectErrorEverywhere(writeTmp("plain.zip", buildZip([{ name: "readme.txt", data: "hello" }])), /AndroidManifest\.xml is missing/);
  });
});

describe("zip bombs", () => {
  it("refuses a dex whose declared size is above the limit", async () => {
    const bomb = Buffer.alloc(70 * 1024 * 1024); // deflates to a few tens of KiB
    const p = writeTmp("bomb.apk", buildZipWithBomb(bomb, false));
    const r = await c.call("apk_strings", { path: p });
    expect(JSON.stringify(r.data)).toMatch(/too large \(declared/);
    expect(r.data.strings ?? []).toEqual([]);
  });

  it("refuses a dex that lies about its size and expands past the limit", async () => {
    const bomb = Buffer.alloc(70 * 1024 * 1024);
    const p = writeTmp("lie.apk", buildZipWithBomb(bomb, true));
    const r = await c.call("apk_classes", { path: p });
    expect(JSON.stringify(r.data)).toMatch(/expands beyond the limit/);
  });

  it("refuses an oversized manifest", async () => {
    const p = writeTmp("bigmanifest.apk", buildZip([{ name: "AndroidManifest.xml", data: Buffer.alloc(9 * 1024 * 1024) }]));
    const r = await c.call("apk_manifest", { path: p });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/too large/);
  });

  it("skips oversized text entries in the secret scan instead of inflating them", async () => {
    const p = writeTmp("bigasset.apk", buildApkBuffer({ extra: [{ name: "assets/big.txt", data: Buffer.alloc(2 * 1024 * 1024, 0x61) }] }));
    const r = await c.call("apk_find_secrets", { path: p });
    expect(r.isError).toBe(false);
    expect(r.data.textEntriesSkipped).toBe(1);
  });
});

/** An APK-shaped zip whose classes.dex inflates to `data`; with `lie`, the central directory claims 100 bytes. */
function buildZipWithBomb(data: Buffer, lie: boolean): Buffer {
  const zip = buildZip([
    { name: "AndroidManifest.xml", data: "placeholder" },
    { name: "classes.dex", data },
  ]);
  if (lie) {
    // Locate the central directory entry of classes.dex and rewrite its declared uncompressed size.
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    const second = zip.indexOf(Buffer.from("classes.dex"), cd) - 46;
    zip.writeUInt32LE(100, second + 24);
  }
  return zip;
}

describe("hostile DEX", () => {
  const apkWithDex = (dex: Buffer): string => writeTmp("dex.apk", buildZip([{ name: "AndroidManifest.xml", data: "x" }, { name: "classes.dex", data: dex }]));

  it("a huge declared string count is an error, not an allocation", async () => {
    const dex = buildDex({ strings: ["a", "b"], declaredStringCount: 0x7fffffff });
    const p = apkWithDex(dex);
    for (const name of ["apk_strings", "apk_classes", "apk_find_secrets"]) {
      const r = await c.call(name, { path: p });
      expect(r.isError, name).toBe(false);
      expect(JSON.stringify(r.data.dexErrors), name).toMatch(/string_ids table lies outside the file/);
    }
  });

  it("a bad magic and a truncated header", async () => {
    const bad = Buffer.from(buildDex({ strings: ["a"] }));
    bad.write("XXX\n", 0, "latin1");
    const r = await c.call("apk_strings", { path: apkWithDex(bad) });
    expect(JSON.stringify(r.data.dexErrors)).toMatch(/bad DEX magic/);
    const r2 = await c.call("apk_strings", { path: apkWithDex(Buffer.from("dex\n035\0")) });
    expect(JSON.stringify(r2.data.dexErrors)).toMatch(/too short/);
  });

  it("a dex cut in the middle of its tables", async () => {
    const dex = buildDex({ strings: ["alpha", "beta"], classes: [{ name: "a.B" }] });
    const r = await c.call("apk_classes", { path: apkWithDex(dex.subarray(0, 0x78)) });
    expect(JSON.stringify(r.data.dexErrors)).toMatch(/outside the file/);
  });

  it("string offsets pointing outside the file are skipped", async () => {
    const dex = Buffer.from(buildDex({ strings: ["alpha", "beta"] }));
    dex.writeUInt32LE(0x7fffffff, 0x70); // first string_id
    const r = await c.call("apk_strings", { path: apkWithDex(dex), minLength: 1 });
    expect(r.isError).toBe(false);
    expect(r.data.strings.map((s: { string: string }) => s.string)).toEqual(["beta"]);
  });

  it("an unterminated string is bounded by the end of the file", async () => {
    const dex = Buffer.from(buildDex({ strings: ["tail string"] }));
    dex[dex.length - 1] = 0x41; // remove the NUL terminator
    const r = await c.call("apk_strings", { path: apkWithDex(dex), minLength: 1 });
    expect(r.data.strings[0].string).toBe("tail stringA");
  });
});

describe("hostile binary XML and signing data", () => {
  const withManifest = (m: Buffer): string => writeTmp("m.apk", buildZip([{ name: "AndroidManifest.xml", data: m }]));

  it("a manifest with a huge declared string count", async () => {
    const m = Buffer.alloc(8 + 28);
    m.writeUInt16LE(3, 0);
    m.writeUInt16LE(8, 2);
    m.writeUInt32LE(36, 4);
    m.writeUInt16LE(1, 8);
    m.writeUInt16LE(28, 10);
    m.writeUInt32LE(28, 12);
    m.writeUInt32LE(0x7fffffff, 16);
    const r = await c.call("apk_manifest", { path: withManifest(m) });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/more strings than it can hold/);
  });

  it("a chunk whose size exceeds the document", async () => {
    const m = Buffer.alloc(24);
    m.writeUInt16LE(3, 0);
    m.writeUInt16LE(8, 2);
    m.writeUInt32LE(24, 4);
    m.writeUInt16LE(0x102, 8);
    m.writeUInt16LE(16, 10);
    m.writeUInt32LE(0x10000, 12);
    const r = await c.call("apk_manifest", { path: withManifest(m) });
    expect(r.data.error).toMatch(/size out of range/);
  });

  it("a signing block with an impossible size does not break the other tools", async () => {
    const good = buildApkBuffer({ signing: "v2" });
    const cd = good.readUInt32LE(good.length - 22 + 16);
    const bad = Buffer.from(good);
    bad.writeBigUInt64LE(0xffffffffn, cd - 24); // size field in the footer
    const p = writeTmp("sigbad.apk", bad);
    const sig = await c.call("apk_signature", { path: p });
    expect(sig.isError).toBe(false);
    expect(sig.data.signingBlockError).toMatch(/invalid size/);
    const ov = await c.call("apk_overview", { path: p });
    expect(ov.isError).toBe(false);
    expect(ov.data.signingSchemes.v2).toBe(false);
  });

  it("a corrupt v2 value is reported on the scheme, not thrown", async () => {
    const good = buildApkBuffer({ signing: "v2" });
    const cd = good.readUInt32LE(good.length - 22 + 16);
    const bad = Buffer.from(good);
    // First pair value starts at block start + 8 (size) + 12 (pair header); smash the signers length.
    const start = cd - Number(good.readBigUInt64LE(cd - 24)) - 8;
    bad.writeUInt32LE(0x7fffffff, start + 20);
    const sig = await c.call("apk_signature", { path: writeTmp("v2bad.apk", bad) });
    expect(sig.isError).toBe(false);
    expect(sig.data.v2).toMatchObject({ present: true, signers: [] });
    expect(sig.data.v2.error).toMatch(/runs past its container/);
  });

  it("a garbage PKCS#7 blob is reported on the v1 signer", async () => {
    const p = writeTmp("v1bad.apk", buildApkBuffer({ extra: [{ name: "META-INF/CERT.SF", data: "x" }, { name: "META-INF/CERT.RSA", data: Buffer.from("garbage garbage garbage") }] }));
    const sig = await c.call("apk_signature", { path: p });
    expect(sig.isError).toBe(false);
    expect(sig.data.v1.signers[0].error).toMatch(/DER|PKCS/);
  });
});

describe("file handle hygiene", () => {
  it("closes the file after each call so it can be replaced", async () => {
    const p = writeTmp("reuse.apk", buildApkBuffer());
    await c.call("apk_overview", { path: p });
    await c.call("apk_overview", { path: join(tmpDir(), "missing.apk") });
    const fd = openSync(p, "r+");
    writeSync(fd, Buffer.from("PK\x03\x04"), 0, 4, 0);
    closeSync(fd);
    const r = await c.call("apk_entries", { path: p });
    expect(r.isError).toBe(false);
  });
});
