import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, type Env } from "./helpers/gate.js";

let e: Env;
beforeEach(async () => {
  e = await env();
});
afterEach(() => e.done());

const SENSITIVE = ["gate_start", "gate_run", "gate_close", "gate_http"];

describe("server", () => {
  it("exposes the tools, with the sensitive ones announced as such", async () => {
    const { tools } = await e.s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "gate_close", "gate_http", "gate_note", "gate_run", "gate_scan_manifest", "gate_scan_secrets", "gate_start", "gate_status",
    ]);
    for (const t of tools) expect(t.annotations?.destructiveHint).toBe(SENSITIVE.includes(t.name));
  });

  it("marks every result untrusted, text and _meta, errors included", async () => {
    const r = await e.s.call("gate_status", { gateId: "00000000-0000-4000-8000-000000000000" });
    expect(r.isError).toBe(true);
    expect(r.data.untrusted).toBe(true);
    expect(r.meta?.untrusted).toBe(true);
  });

  it("refuses an unknown field", async () => {
    const r = await e.s.call("gate_status", { gateId: "00000000-0000-4000-8000-000000000000", extra: 1 });
    expect(r.isError).toBe(true);
  });
});
