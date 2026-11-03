import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvestigation, type Investigation, type Snapshot } from "../src/investigation.js";
import { locateCode } from "../src/locate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

const dirs: string[] = [];
afterEach(async () => {
  await cleanupRepos();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rt-loc-"));
  dirs.push(d);
  return d;
}

async function setup(files: Record<string, string | null>[]): Promise<{ inv: Investigation; snap: Snapshot; shas: string[] }> {
  const { path, shas } = await makeRepo({ commits: files.map((f, i) => ({ files: f, message: `c${i}` })) });
  const inv = createInvestigation(await tmp());
  inv.repos.push({ repoId: "r1", path, forge: "unknown", capabilities: { mrLookup: false, tickets: false }, misses: [] });
  return { inv, snap: { path, repoId: "r1", ref: "HEAD" }, shas };
}

const KT = 'package com.acme\nclass Foo { fun bar() { println("hello world") } }\n';

async function noConfig(): Promise<string> {
  return join(await tmp(), "config.json");
}

describe("locateCode", () => {
  it("resolves a plain frame to its file and line", async () => {
    const { inv, snap } = await setup([{ "app/src/main/java/com/acme/Foo.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at com.acme.Foo.bar(Foo.kt:42)" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/src/main/java/com/acme/Foo.kt", line: 42, via: "frame" }]);
    expect(r.obfuscated).toBe(false);
    expect(r.evidenceIds).toHaveLength(1);
    expect(inv.evidence[0]).toMatchObject({ kind: "code_reading", untrusted: true });
  });

  it("separates two files named alike by package, and keeps both when the package matches none", async () => {
    const { inv, snap } = await setup([
      { "app/src/main/java/com/acme/Foo.kt": KT, "lib/src/main/java/org/other/Foo.kt": KT },
    ]);
    const r = await locateCode(inv, snap, { trace: "at com.acme.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r.hits.map((h) => h.file)).toEqual(["app/src/main/java/com/acme/Foo.kt"]);
    const r2 = await locateCode(inv, snap, { trace: "at net.zzz.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r2.hits.map((h) => h.file).sort()).toEqual([
      "app/src/main/java/com/acme/Foo.kt",
      "lib/src/main/java/org/other/Foo.kt",
    ]);
  });

  it("flags an obfuscated trace without mapping", async () => {
    const { inv, snap } = await setup([{ "app/A.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at a.b.c(SourceFile:12)" }, await noConfig());
    expect(r.obfuscated).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.needsInput).toMatch(/mapping/);
  });

  it("resolves frames through a native retrace executable", async () => {
    const { inv, snap } = await setup([{ "app/src/main/java/com/acme/Foo.kt": KT }]);
    const dir = await tmp();
    // fake retrace: copied node; the "mapping" is a node script that reads the trace file and prints a resolved frame
    const exe = join(dir, process.platform === "win32" ? "retrace.exe" : "retrace");
    copyFileSync(process.execPath, exe);
    const mapping = join(dir, "mapping.js");
    await writeFile(
      mapping,
      'const fs=require("fs");const t=fs.readFileSync(process.argv[2],"utf8");if(!t.includes("SourceFile"))process.exit(3);console.log("at com.acme.Foo.bar(Foo.kt:99)");\n',
    );
    const cfg = join(dir, "config.json");
    await writeFile(cfg, JSON.stringify({ repos: { [snap.path]: { retracePath: exe } } }));
    const r = await locateCode(inv, snap, { trace: "at a.b.c(SourceFile:12)", mappingPath: mapping }, cfg);
    expect(r.obfuscated).toBe(true);
    expect(r.needsInput).toBeUndefined();
    expect(r.hits).toEqual([{ file: "app/src/main/java/com/acme/Foo.kt", line: 99, via: "retrace" }]);
  });

  it("asks for input instead of throwing when retrace is missing", async () => {
    const { inv, snap } = await setup([{ "app/A.kt": KT }]);
    const dir = await tmp();
    const mapping = join(dir, "mapping.txt");
    await writeFile(mapping, "x");
    const cfg = join(dir, "config.json");
    await writeFile(cfg, JSON.stringify({ repos: { [snap.path]: { retracePath: join(dir, "absent") } } }));
    const r = await locateCode(inv, snap, { trace: "at a.b.c(SourceFile:12)", mappingPath: mapping }, cfg);
    expect(r.needsInput).toMatch(/retrace/);
    expect(r.hits).toEqual([]);
  });

  it("refuses a .bat retrace with a request for a native path", async () => {
    const { inv, snap } = await setup([{ "app/A.kt": KT }]);
    const dir = await tmp();
    const mapping = join(dir, "mapping.txt");
    const bat = join(dir, "retrace.bat");
    await writeFile(mapping, "x");
    await writeFile(bat, "@echo off\n");
    const cfg = join(dir, "config.json");
    await writeFile(cfg, JSON.stringify({ repos: { [snap.path]: { retracePath: bat } } }));
    const r = await locateCode(inv, snap, { trace: "at a.b.c(SourceFile:12)", mappingPath: mapping }, cfg);
    expect(r.needsInput).toMatch(/native/);
  });

  it("finds log text and its first-seen commit", async () => {
    const { inv, snap, shas } = await setup([
      { "a.txt": "x\n" },
      { "app/Foo.kt": KT },
      { "app/Foo.kt": KT + "// more\n" },
    ]);
    const r = await locateCode(inv, snap, { logText: "hello world" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/Foo.kt", line: 2, via: "log_text" }]);
    expect(r.history?.firstSeen).toBe(shas[1]);
    expect(r.history?.firstSeen).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a removed text with no hits and lastRemoved", async () => {
    const { inv, snap, shas } = await setup([{ "app/Foo.kt": KT }, { "app/Foo.kt": "package com.acme\n" }]);
    const r = await locateCode(inv, snap, { logText: "hello world" }, await noConfig());
    expect(r.hits).toEqual([]);
    expect(r.history?.lastRemoved).toBe(shas[1]);
  });

  it("treats shell metacharacters and a leading dash literally", async () => {
    const { inv, snap } = await setup([{ "a.txt": "x $(rm -rf /) y\n--force\n" }]);
    const r = await locateCode(inv, snap, { logText: "$(rm -rf /)" }, await noConfig());
    expect(r.hits).toEqual([{ file: "a.txt", line: 1, via: "log_text" }]);
    const d = await locateCode(inv, snap, { logText: "--force" }, await noConfig());
    expect(d.hits).toEqual([{ file: "a.txt", line: 2, via: "log_text" }]);
    expect(d.needsInput).toBeUndefined();
  });
  it("flags ambiguity when several same-named files remain, with candidates and ambiguous hits", async () => {
    const { inv, snap } = await setup([{ "app/com/acme/Foo.kt": KT, "lib/org/other/Foo.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at net.zzz.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r.hits.every((h) => h.ambiguous === true)).toBe(true);
    expect(r.needsInput).toContain("app/com/acme/Foo.kt");
    expect(r.needsInput).toContain("lib/org/other/Foo.kt");
  });

  it("flags a single same-named file when the package matches none (R8 kept a real source name)", async () => {
    const { inv, snap } = await setup([{ "app/com/acme/Foo.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at a.b.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/com/acme/Foo.kt", line: 7, via: "frame", ambiguous: true }]);
    expect(r.needsInput).toContain("app/com/acme/Foo.kt");
    expect(r.obfuscated).toBe(false);
  });

  it("does not flag a package match that drops other same-named files", async () => {
    const { inv, snap } = await setup([{ "app/com/acme/Foo.kt": KT, "lib/org/other/Foo.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at com.acme.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/com/acme/Foo.kt", line: 7, via: "frame" }]);
    expect(r.needsInput).toBeUndefined();
  });

  it("does not call a clean trace obfuscated for native or synthetic frames", async () => {
    const { inv, snap } = await setup([{ "app/com/acme/Foo.kt": KT }]);
    const trace = [
      "at java.lang.reflect.Method.invoke(Native Method)",
      "at x.Y.z(Unknown Source)",
      "at x.Y.w(<generated>)",
      "at com.acme.Foo.bar(Foo.kt:3)",
    ].join(String.fromCharCode(10));
    const r = await locateCode(inv, snap, { trace }, await noConfig());
    expect(r.obfuscated).toBe(false);
    expect(r.needsInput).toBeUndefined();
    expect(r.hits).toEqual([{ file: "app/com/acme/Foo.kt", line: 3, via: "frame" }]);
  });

  it("takes presence and history from the same log line", async () => {
    const { inv, snap, shas } = await setup([
      { "app/Foo.kt": KT + "// old only\n" },
      { "app/Foo.kt": KT },
    ]);
    const r = await locateCode(inv, snap, { logText: "old only\nhello world" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/Foo.kt", line: 2, via: "log_text" }]);
    expect(r.history).toEqual({ firstSeen: shas[0] });
  });

  it("handles a non-ASCII path", async () => {
    const { inv, snap } = await setup([{ "app/com/acme/Café.kt": KT }]);
    const r = await locateCode(inv, snap, { trace: "at com.acme.Café.bar(Café.kt:5)" }, await noConfig());
    expect(r.hits).toEqual([{ file: "app/com/acme/Café.kt", line: 5, via: "frame" }]);
  });

  it("asks for input when git ls-files fails", async () => {
    const { inv, snap } = await setup([{ "a.txt": "x\n" }]);
    const r = await locateCode(inv, { ...snap, path: join(await tmp(), "absent") }, { trace: "at com.acme.Foo.bar(Foo.kt:7)" }, await noConfig());
    expect(r.hits).toEqual([]);
    expect(r.needsInput).toMatch(/files/);
  });
});
