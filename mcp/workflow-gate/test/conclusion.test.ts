import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeMarkdown } from "../src/report.js";
import { auditManifest } from "../src/scan.js";
import { commit, env, FILES, NODE, sh, start, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;
const SENTENCE = "the user authorizes these tests on staging";

beforeEach(async () => {
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

const opening = { commands: { audit: [NODE, "build.js"] } };
const MANIFEST = `<manifest><application android:allowBackup="false"/></manifest>`;

async function scanned(extra = {}): Promise<string> {
  write(repo, "AndroidManifest.xml", MANIFEST);
  commit(repo, "app");
  const id = await start(e.s, "security-audit", repo, { ...opening, ...extra });
  await e.s.call("gate_scan_secrets", { gateId: id });
  await e.s.call("gate_scan_manifest", { gateId: id });
  await e.s.call("gate_run", { gateId: id, step: "deps_audit" });
  return id;
}

function apk(): { examinedFile: string; examinedSha256: string } {
  const examinedFile = join(e.tmp, "app-release.apk");
  writeFileSync(examinedFile, "apk");
  return { examinedFile, examinedSha256: createHash("sha256").update("apk").digest("hex") };
}

describe("I3: an examination note names what it examined", () => {
  it("without an examined file, release_apk is not proved and the report does not conclude", async () => {
    const id = await scanned();
    await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "apk-inspector: nothing" });
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(closed.data.score).toBe(9);
    expect(closed.data.missing.join()).toMatch(/release_apk/);
    expect(readFileSync(closed.data.reportPath, "utf8")).not.toContain("no flaw");
  });

  it("with a file and hash, it is", async () => {
    const id = await scanned();
    await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "apk-inspector: nothing", ...apk() });
    expect((await e.s.call("gate_close", { gateId: id })).data.score).toBe(10);
  });

  it("refuses a wrong hash, a missing file", async () => {
    const id = await scanned();
    const good = apk();
    expect((await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "n", ...good, examinedSha256: "0".repeat(64) })).isError).toBe(true);
    expect((await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "n", ...good, examinedFile: join(e.tmp, "absent") })).isError).toBe(true);
  });

  it("a file that has since vanished no longer proves anything", async () => {
    const id = await scanned();
    const good = apk();
    await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "n", ...good });
    rmSync(good.examinedFile);
    expect((await e.s.call("gate_close", { gateId: id })).data.missing.join()).toMatch(/release_apk/);
  });

  it("refuses examinedFile on another step", async () => {
    const id = await start(e.s, "build-feature", repo);
    expect((await e.s.call("gate_note", { gateId: id, step: "plan", note: "n", ...apk() })).isError).toBe(true);
  });
});

describe("non-Android repo", () => {
  it("manifest and APK are not applicable, the score and conclusion hold", async () => {
    const id = await start(e.s, "security-audit", repo, opening);
    await e.s.call("gate_scan_secrets", { gateId: id });
    await e.s.call("gate_scan_manifest", { gateId: id });
    await e.s.call("gate_run", { gateId: id, step: "deps_audit" });
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "manifest").status).toBe("na");
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(closed.data.score).toBe(10);
    const md = readFileSync(closed.data.reportPath, "utf8");
    expect(md).toContain("not applicable");
    expect(md).toContain("no flaw found by these tests");
  });

  it.each([
    ["an ignored manifest", ".gitignore", "gen/\n", "gen/AndroidManifest.xml", "<manifest/>"],
    ["an Android build.gradle", "x.txt", "x\n", "app/build.gradle", "apply plugin: 'com.android.application'\n"],
    ["an Android build.gradle.kts", "x.txt", "x\n", "app/build.gradle.kts", 'plugins { id("com.android.library") }\n'],
  ])("%s: not applicable", async (_, first, firstText, file, text) => {
    write(repo, first, firstText);
    write(repo, file, text);
    if (first === ".gitignore") commit(repo, "ignore");
    else commit(repo, "gradle");
    const id = await start(e.s, "security-audit", repo, opening);
    await e.s.call("gate_scan_manifest", { gateId: id });
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "manifest").status).toBe("missing");
    expect(status.data.steps.find((s: { id: string }) => s.id === "release_apk").status).toBe("missing");
  });

  it("a manifest inside a gitlink folder is not applicable", async () => {
    write(repo, "sub/AndroidManifest.xml", "<manifest/>");
    const id = await start(e.s, "security-audit", repo, opening);
    sh(repo, "update-index", "--add", "--cacheinfo", `160000,${sh(repo, "rev-parse", "HEAD")},sub`);
    await e.s.call("gate_scan_manifest", { gateId: id });
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "manifest").status).toBe("missing");
  });

  it("without the scan, the manifest stays missing", async () => {
    const id = await start(e.s, "security-audit", repo, opening);
    expect((await e.s.call("gate_close", { gateId: id })).data.missing.join()).toMatch(/manifest/);
  });
});

describe("I5 and network", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeEach(async () => {
    const { createServer } = await import("node:http");
    server = createServer((req, res) => res.writeHead(req.url === "/500" ? 500 : 200).end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    writeFileSync(e.configPath, JSON.stringify({ repos: { [repo]: { stagingHosts: ["127.0.0.1"] } } }));
  });
  afterEach(() => {
    server.close();
  });

  const http = (gateId: string, url: string, extra = {}) => e.s.call("gate_http", { gateId, method: "GET", url, ...extra });

  it("a 5xx without expectStatus is a finding, and a successful request afterwards does not erase it", async () => {
    const id = await scanned({ authorizedBy: SENTENCE });
    expect((await http(id, `${base}/500`)).data).toMatchObject({ status: 500, exitCode: 1 });
    await http(id, `${base}/ok`);
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(readFileSync(closed.data.reportPath, "utf8")).toMatch(/500/);
    const status = await e.s.call("gate_status", { gateId: id });
    expect(status.data.steps.find((s: { id: string }) => s.id === "api_staging").status).toBe("missing");
  });

  it("a lost connection is a finding", async () => {
    const id = await scanned({ authorizedBy: SENTENCE });
    await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "n", ...apk() });
    await http(id, "http://127.0.0.1:1/");
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(closed.data.findings).toBe(1);
  });

  it.each([["X-HTTP-Method-Override"], ["x-method-override"], ["X-HTTP-Method"]])("refuses the %s header", async (name) => {
    const id = await start(e.s, "security-audit", repo, { ...opening, authorizedBy: SENTENCE });
    expect((await http(id, `${base}/ok`, { method: "POST", headers: { [name]: "DELETE" } })).isError).toBe(true);
  });

  it.each([["non"], ["no"], ["yes"], ["ok thanks"], ["no I do not want to"]])("refuses authorizedBy %j", async (authorizedBy) => {
    const r = await e.s.call("gate_start", { workflow: "security-audit", repoPath: repo, ...opening, authorizedBy });
    expect(r.isError).toBe(true);
  });
});

describe("manifest", () => {
  it("reads the declared prefix, not the word android", () => {
    const xml = `<manifest xmlns:a="http://schemas.android.com/apk/res/android"><application a:debuggable="true" a:allowBackup="false"/></manifest>`;
    expect(auditManifest(xml, "m").map((f) => f.rule)).toEqual(["debuggable"]);
  });

  it("reads every prefix bound to the Android URI, on all tags", () => {
    const uri = "http://schemas.android.com/apk/res/android";
    const xml = `<manifest xmlns:a="${uri}"><application xmlns:b="${uri}" a:allowBackup="false" b:debuggable="true"/></manifest>`;
    expect(auditManifest(xml, "m").map((f) => f.rule)).toEqual(["debuggable"]);
  });

  it("a prefix saying false does not cover one saying true", () => {
    const uri = "http://schemas.android.com/apk/res/android";
    const xml = `<manifest xmlns:a="${uri}" xmlns:b="${uri}"><application a:allowBackup="false" b:allowBackup="true" a:debuggable="false" b:debuggable="true"/></manifest>`;
    expect(auditManifest(xml, "m").map((f) => f.rule).sort()).toEqual(["allowBackup", "debuggable"]);
  });

  it("a declaration in a comment or in a value binds nothing", () => {
    const uri = "http://schemas.android.com/apk/res/android";
    const xml = `<!-- <x xmlns:z="${uri}"/> --><manifest xmlns:a="${uri}" note='xmlns:z="${uri}"'><application a:allowBackup="false" z:debuggable="true"/></manifest>`;
    expect(auditManifest(xml, "m")).toEqual([]);
  });

  it("an exported provider must protect writes too", () => {
    const head = `<manifest><application android:allowBackup="false">`;
    const read = `${head}<provider android:name=".P" android:exported="true" android:readPermission="r"/></application></manifest>`;
    const both = `${head}<provider android:name=".P" android:exported="true" android:readPermission="r" android:writePermission="w"/></application></manifest>`;
    expect(auditManifest(read, "m").map((f) => f.rule)).toEqual(["exported"]);
    expect(auditManifest(both, "m")).toEqual([]);
  });
});

describe("Markdown", () => {
  it("does not allow a www link", () => {
    expect(escapeMarkdown("see www.evil.example")).not.toContain("www.evil");
  });
});
