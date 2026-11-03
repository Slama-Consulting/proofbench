import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commit, env, FILES, sh, start, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;

beforeEach(async () => {
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

const open = () => start(e.s, "security-audit", repo, { commands: { audit: [process.execPath, "build.js"] } });
const AWS = "AKIAIOSFODNN7EXAMPLE";
const GITHUB = `ghp_${"b1".repeat(18)}`;

describe("gate_scan_secrets", () => {
  it("without a secret: code 0", async () => {
    const r = await e.s.call("gate_scan_secrets", { gateId: await open() });
    expect(r.data).toMatchObject({ exitCode: 0, findings: [] });
  });

  it("finds a secret at HEAD and a secret removed from history, without ever showing it", async () => {
    write(repo, "old.kt", `val k = "${GITHUB}"\n`);
    const old = commit(repo, "add");
    write(repo, "old.kt", "val k = env\n");
    commit(repo, "remove");
    write(repo, "conf/app.properties", `aws=${AWS}\npassword = "hunter2-very-long"\n`);
    const head = commit(repo, "conf");
    const id = await open();
    const r = await e.s.call("gate_scan_secrets", { gateId: id });
    expect(r.data.exitCode).toBe(1);
    const inHistory = r.data.findings.find((f: { file: string }) => f.file === "old.kt");
    expect(inHistory.commit).toBe(old);
    const atHead = r.data.findings.find(
      (f: { kind: string; file: string; source: string }) => f.file === "conf/app.properties" && f.kind === "aws" && f.source === "head",
    );
    expect(atHead.commit).toBe(head);
    expect(r.text).not.toContain(AWS);
    expect(r.text).not.toContain(GITHUB);
    expect(r.text).not.toContain("hunter2");
    const stored = readFileSync(join(e.gatesDir, `${id}.json`), "utf8");
    expect(stored).not.toContain(AWS);
    expect(stored).not.toContain("hunter2");
    const md = readFileSync((await e.s.call("gate_close", { gateId: id })).data.reportPath, "utf8");
    expect(md).toContain("old.kt");
    expect(md).not.toContain(GITHUB);
  });

  it("does not run the textconv from the repo config", async () => {
    const marker = join(e.tmp, "pwned").replace(/\\/g, "/");
    sh(repo, "config", "diff.evil.textconv", `node -e "require('fs').writeFileSync('${marker}','x')" #`);
    write(repo, ".gitattributes", "*.kt diff=evil\n");
    write(repo, "a.kt", "x\n");
    commit(repo, "attr");
    await e.s.call("gate_scan_secrets", { gateId: await open() });
    expect(readdirSync(e.tmp)).not.toContain("pwned");
  });

  it("ignores placeholder values", async () => {
    write(repo, "a.properties", `password = "\${DB_PASSWORD}"\napi_key = "your_api_key_here"\n`);
    commit(repo, "tpl");
    expect((await e.s.call("gate_scan_secrets", { gateId: await open() })).data.exitCode).toBe(0);
  });

  it("refuses on a workflow without this step", async () => {
    const id = await start(e.s, "clean-up", repo);
    expect((await e.s.call("gate_scan_secrets", { gateId: id })).isError).toBe(true);
  });
});

describe("gate_scan_manifest", () => {
  const manifest = `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <!-- <activity android:name=".Commented" android:exported="true"/> -->
  <application android:allowBackup="true" android:debuggable="true" android:usesCleartextTraffic="true">
    <activity android:name=".Main" android:exported="true">
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
    <activity android:name=".Open" android:exported="true"/>
    <service android:name=".Protected" android:exported="true" android:permission="x.y"/>
    <receiver android:name=".Implicit"><intent-filter><action android:name="a.b"/></intent-filter></receiver>
    <provider android:name=".Closed" android:exported="false"/>
  </application>
</manifest>`;

  it("reports every finding, code 1", async () => {
    write(repo, "app/src/main/AndroidManifest.xml", manifest);
    commit(repo, "app");
    const r = await e.s.call("gate_scan_manifest", { gateId: await open() });
    expect(r.data.exitCode).toBe(1);
    const rules = r.data.findings.map((f: { rule: string; component?: string }) => `${f.rule}:${f.component ?? ""}`).sort();
    expect(rules).toEqual(["allowBackup:", "cleartext:", "debuggable:", "exported:.Implicit", "exported:.Open"]);
  });

  it("a clean manifest gives code 0", async () => {
    write(repo, "AndroidManifest.xml", `<manifest><application android:allowBackup="false"/></manifest>`);
    commit(repo, "app");
    expect((await e.s.call("gate_scan_manifest", { gateId: await open() })).data).toMatchObject({ exitCode: 0, findings: [] });
  });

  it("a missing allowBackup counts as true", async () => {
    write(repo, "AndroidManifest.xml", `<manifest><application/></manifest>`);
    commit(repo, "app");
    expect((await e.s.call("gate_scan_manifest", { gateId: await open() })).data.findings[0].rule).toBe("allowBackup");
  });

  it("no manifest proves nothing", async () => {
    const r = await e.s.call("gate_scan_manifest", { gateId: await open() });
    expect(r.data.exitCode).toBe(2);
    expect(r.data.ok).toBe(false);
  });

  it("skips debug and test manifests", async () => {
    write(repo, "AndroidManifest.xml", `<manifest><application android:allowBackup="false"/></manifest>`);
    write(repo, "app/src/debug/AndroidManifest.xml", `<manifest><application android:debuggable="true"/></manifest>`);
    commit(repo, "app");
    const r = await e.s.call("gate_scan_manifest", { gateId: await open() });
    expect(r.data.exitCode).toBe(0);
    expect(r.data.skipped).toEqual(["app/src/debug/AndroidManifest.xml"]);
  });
});
