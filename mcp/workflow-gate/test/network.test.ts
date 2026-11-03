import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestSecrets } from "../src/network.js";
import { commit, env, FILES, start, write, type Env } from "./helpers/gate.js";
import { cleanupRepos, makeRepo } from "./helpers/repo.js";

let e: Env;
let repo: string;
let server: Server;
let base: string;
let hits: { url: string; at: number }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", at: Date.now() });
    if (req.url?.startsWith("/echo")) {
      let body = "";
      req.setEncoding("utf8").on("data", (d: string) => (body += d));
      req.on("end", () => res.writeHead(200).end(`${req.url} | ${body} | ${String(req.headers["x-key"])}`));
      return;
    }
    if (req.url === "/fields") {
      res.writeHead(200).end(`{"sessionId":"zz","refresh_token":"zz","other":"visible"}`);
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" }).end();
      return;
    }
    res.writeHead(req.url === "/404" ? 404 : 200, { "content-type": "text/plain" });
    res.end(req.url === "/long" ? "x".repeat(100_000) : `token ghp_${"c1".repeat(18)}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  hits = [];
  e = await env();
  repo = (await makeRepo({ commits: [{ files: FILES, message: "init" }] })).path;
  writeFileSync(e.configPath, JSON.stringify({ repos: { [repo]: { stagingHosts: ["127.0.0.1", "api-prod.example.com", "staging.example.com"] } } }));
});
afterEach(async () => {
  await e.done();
  await cleanupRepos();
});

const open = () => start(e.s, "security-audit", repo, { commands: {}, authorizedBy: "the user authorizes these tests on staging" });
const http = (gateId: string, url: string, extra = {}) => e.s.call("gate_http", { gateId, method: "GET", url, ...extra });

describe("gate_http", () => {
  it("queries an allowed host and records a masked, truncated proof", async () => {
    const id = await open();
    const r = await http(id, `${base}/ok?token=abc`);
    expect(r.data).toMatchObject({ status: 200, exitCode: 0 });
    expect(r.text).not.toContain("c1c1c1c1");
    const stored = readFileSync(join(e.gatesDir, `${id}.json`), "utf8");
    expect(stored).not.toContain("c1c1c1c1");
    expect(stored).not.toContain("token=abc");
    const long = await http(id, `${base}/long`);
    expect(long.data.body.length).toBeLessThan(5000);
  });

  it("requires authorizedBy", async () => {
    const id = await start(e.s, "security-audit", repo, { commands: {} });
    const r = await http(id, `${base}/ok`);
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  it.each([
    ["unlisted host", "https://example.org/"],
    ["http outside localhost", "http://staging.example.com/"],
    ["prod even if listed", "https://api-prod.example.com/"],
    ["credentials in the URL", "https://u:p@staging.example.com/"],
    ["ftp", "ftp://staging.example.com/"],
    ["not a URL", "whatever"],
  ])("refuses: %s", async (_, url) => {
    const r = await http(await open(), url);
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  it("refuses another repo's config", async () => {
    writeFileSync(e.configPath, JSON.stringify({ repos: { "C:/other": { stagingHosts: ["127.0.0.1"] } } }));
    expect((await http(await open(), `${base}/ok`)).isError).toBe(true);
  });

  it("refuses DELETE by schema", async () => {
    expect((await http(await open(), `${base}/ok`, { method: "DELETE" })).isError).toBe(true);
    expect(hits).toEqual([]);
  });

  it("does not follow redirects", async () => {
    const r = await http(await open(), `${base}/redirect`);
    expect(r.data.status).toBe(302);
    expect(hits.map((h) => h.url)).toEqual(["/redirect"]);
  });

  it("limits to one request per second", async () => {
    const id = await open();
    await Promise.all([http(id, `${base}/a`), http(id, `${base}/b`)]);
    expect(hits).toHaveLength(2);
    expect(Math.abs(hits[1]!.at - hits[0]!.at)).toBeGreaterThanOrEqual(950);
  });

  it("caps at 200 requests per gate", async () => {
    const id = await open();
    const file = join(e.gatesDir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), httpCount: 200 }));
    const r = await http(id, `${base}/ok`);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/200/);
    expect(hits).toEqual([]);
  });

  it("expectStatus decides the proof code, and the gap becomes a finding", async () => {
    const id = await open();
    const r = await http(id, `${base}/404`, { expectStatus: 200 });
    expect(r.data).toMatchObject({ status: 404, exitCode: 1, ok: false });
    const md = readFileSync((await e.s.call("gate_close", { gateId: id })).data.reportPath, "utf8");
    expect(md).toContain("404");
    expect(md).not.toContain("no flaw");
  });

  it("a request with no response prevents concluding, even if optional", async () => {
    write(repo, "AndroidManifest.xml", `<manifest><application android:allowBackup="false"/></manifest>`);
    commit(repo, "app");
    const id = await start(e.s, "security-audit", repo, { commands: { audit: [process.execPath, "build.js"] }, authorizedBy: "the user authorizes these tests on staging" });
    await e.s.call("gate_scan_secrets", { gateId: id });
    await e.s.call("gate_scan_manifest", { gateId: id });
    await e.s.call("gate_run", { gateId: id, step: "deps_audit" });
    expect((await http(id, "http://127.0.0.1:1/")).data.exitCode).toBeNull();
    const closed = await e.s.call("gate_close", { gateId: id });
    expect(readFileSync(closed.data.reportPath, "utf8")).not.toContain("no flaw");
  });

  describe("masking the request in the response", () => {
    const stored = (id: string) => readFileSync(join(e.gatesDir, `${id}.json`), "utf8");

    it("masks URL parameter values of 8 characters or more, encoded ones included", async () => {
      const id = await open();
      const r = await http(id, `${base}/echo?token=abcd1234efgh&phrase=two%20long%20words&q=ab`);
      for (const text of [r.text, stored(id)]) {
        expect(text).not.toContain("abcd1234efgh");
        expect(text).not.toContain("two%20long%20words");
      }
      expect(r.data.body).toContain("q=ab");
    });

    it("masks the fields of a JSON body, even nested, and header values", async () => {
      const id = await open();
      const body = JSON.stringify({ password: "long-password", n: { a: ["other-long-value", 1234567890] }, short: "ok" });
      const r = await http(id, `${base}/echo`, { method: "POST", body, headers: { "x-key": "private-header-key" } });
      for (const text of [r.text, stored(id)]) {
        for (const secret of ["long-password", "other-long-value", "1234567890", "private-header-key"]) expect(text).not.toContain(secret);
      }
      expect(r.data.body).toContain('"short":"ok"');
    });

    it("masks form fields and an opaque body", async () => {
      const id = await open();
      const form = await http(id, `${base}/echo`, { method: "POST", body: "login=alice&secret=form-value" });
      expect(form.text).not.toContain("form-value");
      expect(form.data.body).toContain("login=alice");
      const opaque = await http(id, `${base}/echo`, { method: "POST", body: "opaque body without structure" });
      expect(opaque.text).not.toContain("opaque body");
    });

    it("masks jwt, session, refresh and password whatever the length", async () => {
      const id = await open();
      const body = JSON.stringify({ session: "ab", refresh: "cd", jwt: "ef", password: "gh" });
      const r = await http(id, `${base}/echo?session=xy`, { method: "POST", body });
      for (const short of ['"ab"', '"cd"', '"ef"', '"gh"', "session=xy"]) expect(r.data.body).not.toContain(short);
    });

    it("masks these fields in a response that makes them up", async () => {
      const id = await open();
      const r = await http(id, `${base}/fields`);
      expect(r.data.body).not.toContain("zz");
      expect(r.data.body).toContain("visible");
    });

    it("the same list serves the error text", () => {
      const secrets = requestSecrets(new URL("https://h/x?a=long-value&b=c"), '{"f":"private-field"}', { h: "header" });
      expect(secrets).toEqual(expect.arrayContaining(["long-value", "private-field", "header"]));
      expect(secrets).not.toContain("c");
    });
  });

  it("is only available on security-audit", async () => {
    const id = await start(e.s, "clean-up", repo, { authorizedBy: "the user authorizes these tests on staging" });
    expect((await http(id, `${base}/ok`)).isError).toBe(true);
  });
});
