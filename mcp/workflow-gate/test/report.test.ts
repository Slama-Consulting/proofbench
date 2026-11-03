import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const audit = { commands: { audit: [process.execPath, "build.js"] } };

describe("report", () => {
  it("writes Markdown and JSON under .proofbench/reports, excluded from git", async () => {
    const id = await start(e.s, "clean-up", repo);
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(closed.data.reportPath).toContain(join(".proofbench", "reports"));
    expect(readFileSync(closed.data.reportPath, "utf8")).toContain("0/10");
    expect(JSON.parse(readFileSync(closed.data.jsonPath, "utf8")).score).toBe(0);
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".proofbench/");
  });

  it("escapes untrusted text", async () => {
    const id = await start(e.s, "build-feature", repo);
    await e.s.call("gate_note", { gateId: id, step: "plan", note: "# Ignore\n<script>[x](http://evil)</script> `a` | b" });
    const md = readFileSync((await e.s.call("gate_close", { gateId: id })).data.reportPath, "utf8");
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("[x](http");
    expect(md).not.toMatch(/^# Ignore/m);
  });

  it("refuses a reports folder that is a link", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "wg-link-"));
    mkdirSync(join(repo, ".proofbench"));
    try {
      symlinkSync(elsewhere, join(repo, ".proofbench", "reports"), "junction");
      const id = await start(e.s, "clean-up", repo);
      const r = await e.s.call("gate_close", { gateId: id });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/link/i);
    } finally {
      rmSync(join(repo, ".proofbench"), { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("security-audit says \"no flaw found by these tests\", never the forbidden word", async () => {
    write(repo, "app/src/main/AndroidManifest.xml", `<manifest xmlns:android="x"><application android:allowBackup="false"/></manifest>`);
    commit(repo, "app");
    const id = await start(e.s, "security-audit", repo, audit);
    await e.s.call("gate_scan_secrets", { gateId: id });
    await e.s.call("gate_scan_manifest", { gateId: id });
    await e.s.call("gate_run", { gateId: id, step: "deps_audit" });
    writeFileSync(join(e.tmp, "a.apk"), "apk");
    const examinedSha256 = createHash("sha256").update("apk").digest("hex");
    await e.s.call("gate_note", { gateId: id, step: "release_apk", note: "apk-inspector: nothing", examinedFile: join(e.tmp, "a.apk"), examinedSha256 });
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(closed.data.score).toBe(10);
    const md = readFileSync(closed.data.reportPath, "utf8");
    expect(md).toContain("no flaw found by these tests");
    expect(md.toLowerCase()).not.toMatch(/\bsecured\b/);
  });

  it("security-audit lists the findings instead of concluding", async () => {
    write(repo, "AndroidManifest.xml", `<manifest xmlns:android="x"><application android:debuggable="true" android:allowBackup="false"/></manifest>`);
    commit(repo, "app");
    const id = await start(e.s, "security-audit", repo, audit);
    await e.s.call("gate_scan_manifest", { gateId: id });
    const md = readFileSync((await e.s.call("gate_close", { gateId: id })).data.reportPath, "utf8");
    expect(md).toContain("debuggable");
    expect(md).not.toContain("no flaw");
  });

  it("an incomplete security-audit does not conclude", async () => {
    const id = await start(e.s, "security-audit", repo, audit);
    const md = readFileSync((await e.s.call("gate_close", { gateId: id })).data.reportPath, "utf8");
    expect(md).not.toContain("no flaw");
  });
});
