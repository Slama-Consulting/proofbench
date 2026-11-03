import { describe, expect, it } from "vitest";
import { CHECKLISTS } from "../src/checklists.js";
import { parseWarnings, scoreOf } from "../src/gate.js";

describe("checklists", () => {
  it("covers the four workflows, each run step carries its condition", () => {
    expect(Object.keys(CHECKLISTS).sort()).toEqual(["build-feature", "clean-up", "fix-bug", "security-audit"]);
    for (const steps of Object.values(CHECKLISTS)) {
      for (const s of steps) {
        expect(s.id && s.label).toBeTruthy();
        expect(typeof s.required).toBe("boolean");
        if (s.kind === "run") expect(["zero", "nonzero", "any"]).toContain(s.expect);
      }
    }
    const failing = CHECKLISTS["build-feature"].find((s) => s.id === "failing_test_before");
    expect(failing).toMatchObject({ expect: "nonzero", before: true });
  });
});

describe("parseWarnings", () => {
  it("reads Android lint text", () => {
    expect(parseWarnings("a.kt:1: Warning: x [A]\nb.kt:1: Warning: y [B]\nc.kt:2: Error: z [C]\n")).toEqual({ count: 2, errors: 1, parser: "android" });
    expect(parseWarnings("Ran lint\n3 errors, 7 warnings\n")).toEqual({ count: 7, errors: 3, parser: "android" });
  });
  it("falls back on the word warning", () => {
    expect(parseWarnings("warning: a\nWARNING b\nnothing\n")).toEqual({ count: 2, errors: 0, parser: "generic" });
  });
  it("accepts a literal substring as a parameter", () => {
    expect(parseWarnings("W1 [x]\nW2 [x]\nwarning\n", "[x]")).toEqual({ count: 2, parser: "marker" });
    expect(parseWarnings("abc\n", ".*")).toEqual({ count: 0, parser: "marker" });
  });
});

describe("scoreOf", () => {
  const run = (status: string, required = true) => ({ id: "r", label: "r", kind: "run" as const, required, status: status as never });
  const judged = (status: string) => ({ id: "j", label: "j", kind: "judged" as const, required: true, status: status as never });

  it("rounds proved / required over the required run steps", () => {
    expect(scoreOf([run("proved"), run("missing"), run("missing")])).toBe(3);
    expect(scoreOf([run("proved"), run("proved"), run("missing")])).toBe(7);
  });
  it("a note never raises the score", () => {
    expect(scoreOf([run("missing"), judged("noted")])).toBe(0);
  });
  it("10 requires all run steps and all notes", () => {
    expect(scoreOf([run("proved"), judged("missing")])).toBe(9);
    expect(scoreOf([run("proved"), judged("noted")])).toBe(10);
  });
  it("an optional step does not count", () => {
    expect(scoreOf([run("proved"), run("missing", false)])).toBe(10);
  });
  it("never 10 if a run step is missing, even when rounded", () => {
    const many = Array.from({ length: 30 }, () => run("proved"));
    expect(scoreOf([...many, run("missing")])).toBe(9);
  });
});
