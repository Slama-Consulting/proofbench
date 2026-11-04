import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Connected } from "./helpers/mcp.js";
import { attr, buildAxml, type AxmlEl } from "./helpers/axmlwriter.js";
import { FAKE_GOOGLE_KEY, RES_IDS, buildApk, cleanupTmp, manifestTree } from "./helpers/fixtures.js";
import { dexSpecWith } from "./helpers/specs.js";
import { assertSafeRegex } from "../src/regexsafe.js";

let c: Connected;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.close();
  cleanupTmp();
});

const na = (name: string, value: string | boolean) => attr(name, value, null);

describe("apk_strings: ignoreCase and regex error messages", () => {
  const path = () => buildApk({ dex: [dexSpecWith(["Hello World", "PASSWORD=value", "other string"])] });

  it("matches a substring regardless of case only when ignoreCase is true", async () => {
    const p = path();
    const strict = (await c.call("apk_strings", { path: p, pattern: "password" })).data;
    const loose = (await c.call("apk_strings", { path: p, pattern: "password", ignoreCase: true })).data;
    expect(strict.matched).toBe(0);
    expect(loose.matched).toBe(1);
    expect(loose.strings[0].string).toBe("PASSWORD=value");
  });

  it("applies ignoreCase to regular expressions too", async () => {
    const p = path();
    const strict = (await c.call("apk_strings", { path: p, pattern: "^hello", regex: true })).data;
    const loose = (await c.call("apk_strings", { path: p, pattern: "^hello", regex: true, ignoreCase: true })).data;
    expect(strict.matched).toBe(0);
    expect(loose.matched).toBe(1);
  });

  it("builds a case-insensitive regex from assertSafeRegex when asked", () => {
    expect(assertSafeRegex("abc", true).flags).toContain("i");
    expect(assertSafeRegex("abc").flags).not.toContain("i");
  });

  it("explains that inline flags such as (?i) are not supported and points to ignoreCase", async () => {
    const p = path();
    for (const pattern of ["(?i)hello", "(?is)hello"]) {
      const r = await c.call("apk_strings", { path: p, pattern, regex: true });
      expect(r.isError, pattern).toBe(true);
      expect(r.data.error, pattern).toMatch(/inline flags/);
      expect(r.data.error, pattern).toMatch(/ignoreCase/);
    }
  });
});

describe("apk_xml", () => {
  const dataExtractionRules = (): AxmlEl => ({
    name: "data-extraction-rules",
    children: [
      {
        name: "cloud-backup",
        attrs: [na("disableIfNoEncryptionCapabilities", true)],
        children: [
          { name: "include", attrs: [na("domain", "sharedpref"), na("path", "settings.xml")] },
          { name: "exclude", attrs: [na("domain", "database"), na("path", "private.db")] },
        ],
      },
      { name: "device-transfer", children: [{ name: "exclude", attrs: [na("domain", "root"), na("path", ".")] }] },
    ],
  });

  it("decodes any binary XML entry and summarises data extraction rules", async () => {
    const path = buildApk({ extra: [{ name: "res/xml/backup_rules.xml", data: buildAxml(dataExtractionRules()) }] });
    const r = (await c.call("apk_xml", { path, entry: "res/xml/backup_rules.xml" })).data;
    expect(r.entry).toBe("res/xml/backup_rules.xml");
    expect(r.root).toBe("data-extraction-rules");
    expect(r.tree.name).toBe("data-extraction-rules");
    expect(r.truncated).toBe(false);
    expect(r.backupRules.kind).toBe("data-extraction-rules");
    expect(r.backupRules.cloudBackup.includes).toEqual([{ domain: "sharedpref", path: "settings.xml" }]);
    expect(r.backupRules.cloudBackup.excludes).toEqual([{ domain: "database", path: "private.db" }]);
    expect(r.backupRules.deviceTransfer.excludes).toEqual([{ domain: "root", path: "." }]);
    expect(r.untrusted).toBe(true);
  });

  it("summarises the legacy full-backup-content format", async () => {
    const tree: AxmlEl = { name: "full-backup-content", children: [{ name: "exclude", attrs: [na("domain", "file"), na("path", "cache")] }] };
    const path = buildApk({ extra: [{ name: "res/xml/full_backup.xml", data: buildAxml(tree) }] });
    const r = (await c.call("apk_xml", { path, entry: "res/xml/full_backup.xml" })).data;
    expect(r.backupRules.kind).toBe("full-backup-content");
    expect(r.backupRules.excludes).toEqual([{ domain: "file", path: "cache" }]);
  });

  it("decodes the manifest like any other entry, with no backup summary for other roots", async () => {
    const path = buildApk();
    const r = (await c.call("apk_xml", { path, entry: "AndroidManifest.xml" })).data;
    expect(r.root).toBe("manifest");
    expect(r.backupRules).toBeUndefined();
  });

  it("refuses an unknown entry, a text file and a malformed document", async () => {
    const path = buildApk({ extra: [{ name: "res/xml/plain.xml", data: "<root/>" }, { name: "res/xml/broken.xml", data: buildAxml(dataExtractionRules()).subarray(0, 30) }] });
    const missing = await c.call("apk_xml", { path, entry: "res/xml/nope.xml" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatch(/entry not found/);
    const text = await c.call("apk_xml", { path, entry: "res/xml/plain.xml" });
    expect(text.isError).toBe(true);
    expect(text.data.error).toMatch(/not binary XML/);
    expect(text.data.error).toMatch(/apk_asset_peek/);
    const broken = await c.call("apk_xml", { path, entry: "res/xml/broken.xml" });
    expect(broken.isError).toBe(true);
  });

  it("caps very large trees and long attribute values", async () => {
    const items: AxmlEl[] = [];
    for (let i = 0; i < 6000; i++) items.push({ name: "item", attrs: [na("v", i === 0 ? "x".repeat(1000) : "y")] });
    const path = buildApk({ extra: [{ name: "res/xml/big.xml", data: buildAxml({ name: "root", children: items }) }] });
    const r = (await c.call("apk_xml", { path, entry: "res/xml/big.xml" })).data;
    expect(r.truncated).toBe(true);
    expect(r.nodeCount).toBeLessThanOrEqual(5000);
    expect(r.tree.children[0].attrs.v.length).toBeLessThanOrEqual(300);
  });
});

describe("apk_asset_peek", () => {
  it("previews a JSON asset without extracting it and reports its real size", async () => {
    const body = '{"stations":[{"id":1,"name":"Radio"}]}';
    const path = buildApk({ extra: [{ name: "assets/stations.json", data: body, method: "deflate" }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/stations.json" })).data;
    expect(r.entry).toBe("assets/stations.json");
    expect(r.size).toBe(body.length);
    expect(r.kind).toBe("json");
    expect(r.preview).toBe(body);
    expect(r.hexPreview).toBeUndefined();
    expect(r.untrusted).toBe(true);
  });

  it("only reads a prefix, so an entry above the normal read limit can still be previewed", async () => {
    const big = Buffer.concat([Buffer.from('{"stations":['), Buffer.alloc(9 * 1024 * 1024, 0x20)]);
    const path = buildApk({ extra: [{ name: "assets/big.json", data: big, method: "store" }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/big.json" })).data;
    expect(r.size).toBe(big.length);
    expect(r.returnedBytes).toBe(256);
    expect(r.preview.startsWith('{"stations":[')).toBe(true);
  });

  it("returns hex and a kind for binary content, never text", async () => {
    const bin = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
    const path = buildApk({ extra: [{ name: "assets/blob.bin", data: bin, method: "store" }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/blob.bin", bytes: 16 })).data;
    expect(r.kind).toBe("binary");
    expect(r.returnedBytes).toBe(16);
    expect(r.hexPreview).toBe(bin.subarray(0, 16).toString("hex").replace(/(..)/g, "$1 ").trim());
    expect(r.preview).toBeUndefined();
  });

  it("recognises executable and archive magic numbers", async () => {
    const path = buildApk();
    const dex = (await c.call("apk_asset_peek", { path, entry: "classes.dex" })).data;
    expect(dex.kind).toBe("dex");
    const elf = (await c.call("apk_asset_peek", { path, entry: "lib/arm64-v8a/libnative.so" })).data;
    expect(elf.kind).toBe("elf");
    const axml = (await c.call("apk_asset_peek", { path, entry: "AndroidManifest.xml" })).data;
    expect(axml.kind).toBe("binary-xml");
  });

  it("redacts secrets in the text preview", async () => {
    const path = buildApk({ extra: [{ name: "assets/config.json", data: `{"apiKey":"${FAKE_GOOGLE_KEY}","name":"demo"}` }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/config.json", bytes: 1024 })).data;
    expect(r.preview).not.toContain(FAKE_GOOGLE_KEY);
    expect(r.preview).toContain("AIza…[39]");
    expect(r.preview).toContain('"name":"demo"');
    expect(r.redactedSecrets).toBeGreaterThanOrEqual(1);
  });

  it("clamps the number of bytes and validates the inputs", async () => {
    const path = buildApk({ extra: [{ name: "assets/long.txt", data: "a".repeat(10_000), method: "store" }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/long.txt", bytes: 4096 })).data;
    expect(r.returnedBytes).toBe(4096);
    expect((await c.call("apk_asset_peek", { path, entry: "assets/long.txt", bytes: 4097 })).isError).toBe(true);
    expect((await c.call("apk_asset_peek", { path, entry: "assets/long.txt", bytes: 0 })).isError).toBe(true);
    const missing = await c.call("apk_asset_peek", { path, entry: "assets/none.txt" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatch(/entry not found/);
  });

  it("handles an empty entry", async () => {
    const path = buildApk({ extra: [{ name: "assets/empty.txt", data: "", method: "store" }] });
    const r = (await c.call("apk_asset_peek", { path, entry: "assets/empty.txt" })).data;
    expect(r.size).toBe(0);
    expect(r.returnedBytes).toBe(0);
  });
});

describe("apk_overview: releaseReadiness", () => {
  const debugManifest = (): Buffer => {
    const tree = manifestTree({ debuggable: true });
    tree.attrs = (tree.attrs ?? []).map((a) => (a.name === "versionName" ? attr("versionName", "2.0-test_paris-mock") : a));
    const app = tree.children!.find((x) => x.name === "application")!;
    app.attrs = [...(app.attrs ?? []), attr("testOnly", true)];
    app.children = [...(app.children ?? []), { name: "activity", attrs: [attr("name", "androidx.test.core.app.InstrumentationActivityInvoker$BootstrapActivity"), attr("exported", true)] }];
    return buildAxml(tree, { resIds: RES_IDS });
  };

  it("lists blockers and reviews for a debug-looking build", async () => {
    const path = buildApk({
      manifest: debugManifest(),
      dex: [{ strings: ["x"], classes: [{ name: "com.example.app.MainActivity" }, { name: "androidx.test.core.app.ActivityScenario" }, { name: "org.jacoco.agent.rt.internal.Agent" }] }],
      signing: "v2",
      expiredCert: true,
      extra: [{ name: "assets/big.bin", data: Buffer.alloc(5.5 * 1024 * 1024), method: "store" }],
    });
    const r = (await c.call("apk_overview", { path })).data.releaseReadiness;
    expect(r.verdict).toBe("not-release-ready");
    const blockers = r.blockers.join("\n");
    expect(blockers).toMatch(/debuggable/);
    expect(blockers).toMatch(/testOnly/);
    expect(blockers).toMatch(/androidx\.test/);
    expect(blockers).toMatch(/jacoco/i);
    expect(blockers).toMatch(/BootstrapActivity/);
    expect(blockers).toMatch(/expired/);
    const reviews = r.reviews.join("\n");
    expect(reviews).toMatch(/assets\/big\.bin/);
    expect(reviews).toMatch(/versionName/);
    expect(r.note).toMatch(/heuristic/i);
  });

  it("reports a signed, non-debuggable build with no test code as looking like a release", async () => {
    const path = buildApk({ manifestSpec: { debuggable: false }, signing: "v2" });
    const r = (await c.call("apk_overview", { path })).data.releaseReadiness;
    expect(r.verdict).toBe("looks-like-release");
    expect(r.blockers).toEqual([]);
  });

  it("flags an unsigned APK and a debug certificate", async () => {
    const unsigned = (await c.call("apk_overview", { path: buildApk({ manifestSpec: { debuggable: false }, signing: "none" }) })).data.releaseReadiness;
    expect(unsigned.blockers.join("\n")).toMatch(/not signed/);
    const dbg = (await c.call("apk_overview", { path: buildApk({ manifestSpec: { debuggable: false }, signing: "v2", certCn: "Android Debug" }) })).data.releaseReadiness;
    expect(dbg.blockers.join("\n")).toMatch(/debug certificate/);
  });

  it("still returns the block when the manifest cannot be read", async () => {
    const path = buildApk({ manifest: Buffer.from("not a manifest"), signing: "v2" });
    const o = (await c.call("apk_overview", { path })).data;
    expect(o.manifestError).toBeDefined();
    expect(o.releaseReadiness).toBeDefined();
    expect(o.releaseReadiness.reviews.join("\n")).toMatch(/manifest/);
  });
});
