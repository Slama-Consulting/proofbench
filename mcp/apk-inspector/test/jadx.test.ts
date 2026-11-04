import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { cleanupTmp } from "./helpers/fixtures.js";
import { serviceApk } from "./helpers/svc.js";

/**
 * The jadx bridge is tested with a fake `jadx` shell script: it records its arguments and environment, and behaves
 * as the mode file next to it says. The real jadx is not involved.
 */

const FAKE = `#!/bin/sh
D="$(dirname "$0")"
MODE="$(cat "$D/mode" 2>/dev/null || echo ok)"
echo "$@" > "$D/args"
env > "$D/env"
OUT=""; CLASS=""; PREV=""
for a in "$@"; do
  if [ "$PREV" = "--single-class-output" ]; then OUT="$a"; fi
  if [ "$PREV" = "--single-class" ]; then CLASS="$a"; fi
  PREV="$a"
done
echo "$OUT" > "$D/outdir"
case "$MODE" in
  ok) mkdir -p "$OUT/sources"; printf '// decompiled by fake jadx\\npublic class %s {}\\n' "$CLASS" > "$OUT/sources/Base.java"; exit 0 ;;
  fail) echo "boom: cannot read dex" >&2; exit 3 ;;
  hang) sleep 30 & echo $! > "$D/pid"; wait ;;
  nooutput) exit 0 ;;
  big) mkdir -p "$OUT"; head -c 300000 /dev/zero | tr '\\0' 'a' > "$OUT/Base.java"; exit 0 ;;
esac
`;

const dirs: string[] = [];
function fakeJadx(mode = "ok"): { exe: string; dir: string; setMode(m: string): void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-jadx-"));
  dirs.push(dir);
  const exe = join(dir, "jadx");
  writeFileSync(exe, FAKE);
  chmodSync(exe, 0o755);
  writeFileSync(join(dir, "mode"), mode);
  return { exe, dir, setMode: (m) => writeFileSync(join(dir, "mode"), m) };
}

async function connectWith(env: NodeJS.ProcessEnv) {
  const server = createServer(env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    async call(args: Record<string, unknown>) {
      const r = await client.callTool({ name: "apk_decompile", arguments: args });
      const text = (r.content as { text: string }[]).map((x) => x.text).join("\n");
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // plain text
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { isError: r.isError === true, data: data as any, text };
    },
  };
}

afterAll(() => {
  cleanupTmp();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("apk_decompile is opt-in", () => {
  it("is not listed unless APK_INSPECTOR_JADX is set, and then says it is not read-only", async () => {
    const off = await connectWith({});
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("apk_decompile");
    expect(off.client.getInstructions()).not.toMatch(/jadx/i);
    const on = await connectWith({ APK_INSPECTOR_JADX: "/usr/bin/jadx" });
    const tool = (await on.client.listTools()).tools.find((t) => t.name === "apk_decompile")!;
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(false);
    expect(on.client.getInstructions()).toMatch(/jadx/i);
    expect(on.client.getInstructions()).toMatch(/untrusted/i);
  });
});

describe.skipIf(process.platform === "win32")("apk_decompile with a fake jadx", () => {
  let apk: string;
  beforeAll(() => {
    apk = serviceApk({ check: "none" }).path;
  });

  it("runs jadx on one class with the documented options and returns the source", async () => {
    const f = fakeJadx("ok");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    const r = await c.call({ path: apk, class: "com.example.app.Base" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.class).toBe("com.example.app.Base");
    expect(r.data.source).toContain("public class com.example.app.Base {}");
    expect(r.data.truncated).toBe(false);
    expect(r.data.untrusted).toBe(true);
    expect(r.data.note).toMatch(/approximate/i);
    const args = readFileSync(join(f.dir, "args"), "utf8").trim().split(" ");
    expect(args).toContain("--no-res");
    expect(args.join(" ")).toContain("--config none");
    expect(args.join(" ")).toContain("--single-class com.example.app.Base");
    expect(args).toContain("--single-class-output");
    expect(args[args.length - 1]).toBe(apk);
  });

  it("removes its temporary directory, on success and on failure", async () => {
    const f = fakeJadx("ok");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    await c.call({ path: apk, class: "com.example.app.Base" });
    const outdir = readFileSync(join(f.dir, "outdir"), "utf8").trim();
    expect(outdir).toContain("apk-inspector-jadx-");
    expect(existsSync(outdir)).toBe(false);
    f.setMode("fail");
    await c.call({ path: apk, class: "com.example.app.Base" });
    expect(existsSync(readFileSync(join(f.dir, "outdir"), "utf8").trim())).toBe(false);
  });

  it("gives jadx a private environment: no unrelated variables, caches inside the temporary directory", async () => {
    process.env["PROOFBENCH_TEST_SECRET"] = "do-not-leak";
    try {
      const f = fakeJadx("ok");
      const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
      await c.call({ path: apk, class: "com.example.app.Base" });
      const env = readFileSync(join(f.dir, "env"), "utf8");
      expect(env).not.toContain("do-not-leak");
      expect(env).toMatch(/^PATH=/m);
      expect(env).toMatch(/^JADX_CACHE_DIR=.*apk-inspector-jadx-/m);
      expect(env).toMatch(/^JADX_CONFIG_DIR=.*apk-inspector-jadx-/m);
    } finally {
      delete process.env["PROOFBENCH_TEST_SECRET"];
    }
  });

  it("reports a failing jadx with its exit code and message", async () => {
    const f = fakeJadx("fail");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    const r = await c.call({ path: apk, class: "com.example.app.Base" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/jadx exited with code 3/);
    expect(r.data.error).toMatch(/boom: cannot read dex/);
  });

  it("kills jadx when it runs too long", async () => {
    const f = fakeJadx("hang");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe, APK_INSPECTOR_JADX_TIMEOUT_MS: "600" });
    const r = await c.call({ path: apk, class: "com.example.app.Base" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/timed out/);
    await new Promise((res) => setTimeout(res, 300));
    const pid = Number(readFileSync(join(f.dir, "pid"), "utf8").trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("says so when jadx produces no source file", async () => {
    const f = fakeJadx("nooutput");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    const r = await c.call({ path: apk, class: "com.example.app.Base" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/no \.java file/);
  });

  it("truncates a huge source to maxChars", async () => {
    const f = fakeJadx("big");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    const r = await c.call({ path: apk, class: "com.example.app.Base", maxChars: 1000 });
    expect(r.data.truncated).toBe(true);
    expect(r.data.source.length).toBe(1000);
    expect(r.data.totalChars).toBeGreaterThan(200_000);
  });

  it("refuses class names that are not plain Java names, without running jadx", async () => {
    const f = fakeJadx("ok");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    for (const name of ["--help", "com.example.Foo; rm -rf /", "../Base", "com example", "-d"]) {
      const r = await c.call({ path: apk, class: name });
      expect(r.isError, name).toBe(true);
      expect(r.data.error, name).toMatch(/invalid class name/);
    }
    expect(existsSync(join(f.dir, "args"))).toBe(false);
  });

  it("refuses a class that is not in the APK, without running jadx", async () => {
    const f = fakeJadx("ok");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    const r = await c.call({ path: apk, class: "com.example.app.Nope" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/class not found in the APK/);
    expect(existsSync(join(f.dir, "args"))).toBe(false);
  });

  it("explains a bad jadx setting instead of failing obscurely", async () => {
    const relative = await connectWith({ APK_INSPECTOR_JADX: "relative/jadx" });
    const r1 = await relative.call({ path: apk, class: "com.example.app.Base" });
    expect(r1.isError).toBe(true);
    expect(r1.data.error).toMatch(/absolute path/);
    const missing = await connectWith({ APK_INSPECTOR_JADX: "/nonexistent/dir/jadx" });
    const r2 = await missing.call({ path: apk, class: "com.example.app.Base" });
    expect(r2.isError).toBe(true);
    expect(r2.data.error).toMatch(/not found or not executable/);
  });

  it("validates maxChars and the APK path", async () => {
    const f = fakeJadx("ok");
    const c = await connectWith({ APK_INSPECTOR_JADX: f.exe });
    expect((await c.call({ path: apk, class: "com.example.app.Base", maxChars: 0 })).isError).toBe(true);
    expect((await c.call({ path: apk, class: "com.example.app.Base", maxChars: 100_001 })).isError).toBe(true);
    const bad = await c.call({ path: "relative.apk", class: "com.example.app.Base" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/absolute/);
  });
});
