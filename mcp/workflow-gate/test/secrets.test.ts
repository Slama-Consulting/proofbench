import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandEnv } from "../src/exec.js";
import { maskArgv, redact } from "../src/secrets.js";
import { commit, env, FILES, NODE, sh, start, write, type Env } from "./helpers/gate.js";
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

const open = () => start(e.s, "security-audit", repo, { commands: { audit: [NODE, "build.js"] } });
const scan = async () => (await e.s.call("gate_scan_secrets", { gateId: await open() }));
type F = { kind: string; file: string; source: string };

describe("C6: Android cases", () => {
  it.each([
    ["app.properties", "password=pw-value-1\n", "pw-value-1"],
    ["config.yml", "api_key: abcdef123456\n", "abcdef123456"],
    ["key.properties", "storePassword=short1\nkeyPassword=other2\nstoreFile=../up.jks\n", "short1"],
    ["local.properties", "sdk.dir=C:/sdk\nMAPS_KEY=value\n", "value"],
    [".env", "DB=postgres\nPORT=3000\n", "postgres"],
    [".env.production", "export A=exported-value\n", "exported-value"],
    ["app/build.gradle", 'storePassword "gradle-pass"\nkeyPassword "gradle-key"\n', "gradle-pass"],
    ["app/build.gradle.kts", 'storePassword = "kotlin-pass"\n', "kotlin-pass"],
    ["app/build.gradle", 'storeFile file("release.jks")\n', "release.jks"],
  ])("finds %s without showing the value", async (file, text, value) => {
    write(repo, file, text);
    commit(repo, "add");
    const r = await scan();
    expect(r.data.exitCode).toBe(1);
    expect(r.data.findings.some((f: F) => f.file === file)).toBe(true);
    expect(r.text).not.toContain(value);
  });

  it("keeps sdk.dir, and the .env.example templates", async () => {
    write(repo, "local.properties", "sdk.dir=C:/sdk\nndk.dir=C:/ndk\n");
    write(repo, ".env.example", "DB=fill-me\n");
    commit(repo, "ok");
    expect((await scan()).data.exitCode).toBe(0);
  });

  it("does not mistake a variable read for a Gradle secret", async () => {
    write(repo, "app/build.gradle", 'storePassword System.getenv("STORE_PASS")\nstoreFile file(System.getenv("STORE"))\n');
    commit(repo, "ok");
    expect((await scan()).data.exitCode).toBe(0);
  });

  it.each([["release.jks"], ["app/debug.keystore"]])("flags %s by its name", async (file) => {
    write(repo, file, "binary\0\n");
    commit(repo, "key");
    const r = await scan();
    expect(r.data.findings.some((f: F) => f.kind === "keystore" && f.file === file && f.source === "head")).toBe(true);
  });

  it("flags a keystore removed from history", async () => {
    write(repo, "old.jks", "binary\0\n");
    commit(repo, "key");
    sh(repo, "rm", "-q", "old.jks");
    commit(repo, "remove");
    const r = await scan();
    expect(r.data.findings.some((f: F) => f.kind === "keystore" && f.file === "old.jks" && f.source === "history")).toBe(true);
  });

  it("reads untracked, non-ignored files, not the ignored ones", async () => {
    write(repo, ".gitignore", "ignore.env\n");
    commit(repo, "ignore");
    write(repo, "draft.txt", 'password = "in-the-draft"\n');
    write(repo, "ignore.env", 'password = "not-this-file"\n');
    write(repo, "wip.jks", "x\n");
    const r = await scan();
    const untracked = r.data.findings.filter((f: F) => f.source === "untracked").map((f: F) => f.file).sort();
    expect(untracked).toEqual(["draft.txt", "wip.jks"]);
    expect(r.text).not.toContain("in-the-draft");
  });

  it("reads a merge resolution with -m", async () => {
    sh(repo, "checkout", "-q", "-b", "a");
    write(repo, "c.txt", "a\n");
    commit(repo, "a");
    sh(repo, "checkout", "-q", "main");
    write(repo, "d.txt", "b\n");
    commit(repo, "b");
    sh(repo, "merge", "-q", "--no-ff", "--no-commit", "a");
    write(repo, "c.txt", 'password = "in-the-merge"\n');
    commit(repo, "merge");
    sh(repo, "rm", "-q", "c.txt");
    commit(repo, "remove");
    const r = await scan();
    expect(r.data.findings.some((f: F) => f.file === "c.txt" && f.source === "history")).toBe(true);
    expect(r.text).not.toContain("in-the-merge");
  });

  it("does not lose an added line that starts with ++", async () => {
    write(repo, "note.txt", `++ password = "after-plus-plus"\n`);
    commit(repo, "plus");
    write(repo, "note.txt", "nothing\n");
    commit(repo, "remove");
    const r = await scan();
    expect(r.data.findings.some((f: F) => f.file === "note.txt" && f.source === "history")).toBe(true);
  });

  it("keeps a real password that starts like a placeholder", async () => {
    write(repo, "a.properties", 'password = "testPa55word!"\nsecret = "example-prod-value-1"\n');
    commit(repo, "real");
    const r = await scan();
    expect(r.data.findings.filter((f: F) => f.source === "head").length).toBe(2);
  });
});

describe("I4: masking", () => {
  it.each([["DB_PASS"], ["GH_PAT"], ["MY_CREDENTIALS"], ["DATABASE_URL"], ["X_AUTH"], ["SOME_PASSWD"]])("removes %s from the environment", (name) => {
    process.env[name] = "value";
    try {
      expect(commandEnv()[name]).toBeUndefined();
    } finally {
      delete process.env[name];
    }
  });

  it("keeps PATH, and removes a URL with credentials whatever the name", () => {
    process.env.MIRROR = "https://u:p@host/x";
    try {
      const out = commandEnv();
      expect(out.PATH ?? out.Path).toBeDefined();
      expect(out.MIRROR).toBeUndefined();
    } finally {
      delete process.env.MIRROR;
    }
  });

  it("masks private key body, unquoted password, Authorization, URL credentials", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabcdefghij\nklmnop\n-----END RSA PRIVATE KEY-----";
    expect(redact(key)).not.toContain("MIIEabcdefghij");
    expect(redact("connection password=hunter2 ok")).not.toContain("hunter2");
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("git clone https://u:secret-token@host/x")).not.toContain("secret-token");
  });

  it("masks the argv", () => {
    expect(maskArgv(["tool", "--token=abc", "--password", "hunter2", "--api-key", "k", "--nothing", "v"])).toEqual([
      "tool", "--token=[masked]", "--password", "[masked]", "--api-key", "[masked]", "--nothing", "v",
    ]);
  });

  it("the gate file, the proof and the report do not keep --token, and the command runs", async () => {
    write(repo, "ok.js", "process.exit(process.argv[2] === '--token=sesame-secret' ? 0 : 1);\n");
    commit(repo, "ok");
    const id = await start(e.s, "security-audit", repo, { commands: { audit: [NODE, "ok.js", "--token=sesame-secret"] } });
    expect((await e.s.call("gate_run", { gateId: id, step: "deps_audit" })).data.ok).toBe(true);
    const closed = await e.s.call("gate_close", { gateId: id });
    for (const file of [join(e.gatesDir, `${id}.json`), closed.data.reportPath, closed.data.jsonPath]) {
      expect(readFileSync(file, "utf8")).not.toContain("sesame-secret");
    }
    expect(closed.text).not.toContain("sesame-secret");
  });
});
