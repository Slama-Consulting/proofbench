import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEvidence,
  createInvestigation,
  getEvidence,
  loadInvestigation,
  saveInvestigation,
} from "../src/investigation.js";

const roots: string[] = [];
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "inv-test-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const ev = (summary: string) => ({
  kind: "execution" as const,
  summary,
  source: "test",
  data: { n: 1 },
  untrusted: false,
});

describe("investigation", () => {
  it("ids_are_sequential", () => {
    const inv = createInvestigation(tempRoot());
    expect(addEvidence(inv, ev("a")).id).toBe("E1");
    expect(addEvidence(inv, ev("b")).id).toBe("E2");
    expect(inv.evidence.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("intermittent_defaults_to_null", () => {
    expect(createInvestigation(tempRoot()).intermittent).toBeNull();
  });

  it("subject_survives_reload", () => {
    const root = tempRoot();
    const inv = createInvestigation(root);
    const subject = { sha: "abc1234", outcome: "culprit" as const };
    addEvidence(inv, { ...ev("a"), subject });
    saveInvestigation(inv, root);
    expect(loadInvestigation(inv.id, root).evidence[0]?.subject).toEqual(subject);
  });

  it("survives_reload", () => {
    const root = tempRoot();
    const inv = createInvestigation(root);
    addEvidence(inv, ev("a"));
    addEvidence(inv, { ...ev("b"), kind: "claim", untrusted: true });
    saveInvestigation(inv, root);
    const back = loadInvestigation(inv.id, root);
    expect(back.evidence).toEqual(inv.evidence);
    expect(back).toEqual(inv);
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("unknown_id_throws_clear_error", () => {
    const inv = createInvestigation(tempRoot());
    addEvidence(inv, ev("a"));
    expect(() => getEvidence(inv, "E9")).toThrow(/E9/);
    expect(getEvidence(inv, "E1").summary).toBe("a");
  });

  it("load_unknown_investigation_throws_clear_error", () => {
    expect(() => loadInvestigation("00000000-0000-4000-8000-000000000000", tempRoot())).toThrow(/not found/);
  });

  it("load_rejects_path_traversal_ids", () => {
    const root = tempRoot();
    for (const bad of ["../x", "..\\x", "a/b", "", "..", "C:\\evil", "not-a-uuid"]) {
      expect(() => loadInvestigation(bad, root)).toThrow(/Invalid/);
    }
  });

  it("save_rejects_path_traversal_ids", () => {
    const root = tempRoot();
    const inv = createInvestigation(root);
    inv.id = "../escape";
    expect(() => saveInvestigation(inv, root)).toThrow(/Invalid/);
  });
});
