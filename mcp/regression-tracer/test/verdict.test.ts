import { describe, expect, it } from "vitest";
import {
  addEvidence,
  type Evidence,
  type EvidenceKind,
  type Investigation,
} from "../src/investigation.js";
import {
  HISTORY_TRUNCATED_NOTE,
  scoreVerdict,
  validateVerdict,
  type Score,
  type Verdict,
} from "../src/verdict.js";

type Outcome = NonNullable<Evidence["subject"]>["outcome"];
type EvidenceSpec = EvidenceKind | { kind: EvidenceKind; subject: Evidence["subject"] };

const CULPRIT = "abc1234def5678";

/** Evidence that carries its subject: the tested commit and the result. */
const on = (kind: EvidenceKind, outcome: Outcome, sha: string = CULPRIT): EvidenceSpec => ({
  kind,
  subject: { sha, outcome },
});

/** Good state tested, on a commit other than the culprit. */
const OTHER = "0000000aaa";
const GOOD = on("execution", "good", OTHER);

/** In-memory investigation: each evidence given becomes E1, E2, etc. */
function makeInv(specs: EvidenceSpec[], over: Partial<Investigation> = {}): Investigation {
  const inv: Investigation = {
    id: "00000000-0000-0000-0000-000000000000",
    repos: [],
    evidence: [],
    startMode: "exact_version",
    intermittent: false,
    snapshots: [],
    coverage: { examined: ["main"], notExamined: [] },
    ...over,
  };
  for (const spec of specs) {
    const fields = typeof spec === "string" ? { kind: spec } : spec;
    addEvidence(inv, { ...fields, summary: "evidence", source: "test", data: { scenario: "test scenario" }, untrusted: false });
  }
  return inv;
}

function makeVerdict(over: Partial<Verdict>): Verdict {
  return {
    origin: "INDETERMINATE",
    candidates: [],
    fixes: [],
    noProposedFixReason: "bug already fixed on the target",
    observed: [],
    inferred: [],
    unknown: [],
    ...over,
  };
}

const candidate = (sha: string, ...evidenceIds: string[]) => ({ sha, evidenceIds });

/** Complete `PROVEN_REGRESSION` verdict: E1 proves the culprit, E2 is the good state. */
const provenVerdict = (over: Partial<Verdict> = {}) =>
  makeVerdict({
    origin: "PROVEN_REGRESSION",
    candidates: [candidate(CULPRIT, "E1")],
    goodStateEvidenceId: "E2",
    ...over,
  });

function errorsOf(inv: Investigation, v: Verdict): string[] {
  const result = validateVerdict(inv, v);
  return result.ok ? [] : result.errors;
}

const sumOf = (s: Score) => s.breakdown.reduce((total, line) => total + line.points, 0);

describe("validateVerdict", () => {
  it("refuses_unknown_evidence", () => {
    const inv = makeInv(["execution"]);
    expect(errorsOf(inv, makeVerdict({ candidates: [candidate("abc", "E99")] }))).toContain(
      "EVIDENCE_NOT_FOUND",
    );
  });

  it("refuses_unknown_evidence_in_good_state", () => {
    const inv = makeInv(["execution"]);
    expect(errorsOf(inv, provenVerdict({ goodStateEvidenceId: "E99" }))).toContain(
      "EVIDENCE_NOT_FOUND",
    );
  });

  it("refuses_unknown_evidence_in_fix_line", () => {
    const inv = makeInv(["execution"]);
    const fixes = [{ target: "main", status: "FIX_ANNOUNCED" as const, evidenceIds: ["E99"] }];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("EVIDENCE_NOT_FOUND");
  });

  it("refuses_unknown_evidence_in_proposed_fix", () => {
    const inv = makeInv(["code_reading"]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E99"] };
    expect(errorsOf(inv, makeVerdict({ proposedFix }))).toContain("EVIDENCE_NOT_FOUND");
  });

  it("refuses_unknown_regression_test_evidence", () => {
    const inv = makeInv(["code_reading"]);
    const proposedFix = {
      files: ["a.kt"],
      change: "c",
      explanation: "e",
      evidenceIds: ["E1"],
      regressionTestEvidenceId: "E99",
    };
    expect(errorsOf(inv, makeVerdict({ proposedFix }))).toContain("EVIDENCE_NOT_FOUND");
  });

  it("refuses_no_evidence", () => {
    const inv = makeInv([]);
    expect(errorsOf(inv, makeVerdict({ candidates: [candidate("abc")] }))).toContain(
      "EVIDENCE_REQUIRED",
    );
  });

  it("refuses_probable_without_candidate", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({ origin: "PROBABLE_REGRESSION", goodStateEvidenceId: "E1" });
    expect(errorsOf(inv, v)).toContain("EVIDENCE_REQUIRED");
  });

  it("refuses_proposed_fix_without_evidence", () => {
    const inv = makeInv([]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: [] };
    expect(errorsOf(inv, makeVerdict({ proposedFix }))).toContain("EVIDENCE_REQUIRED");
  });

  it("refuses_fix_line_without_evidence", () => {
    const inv = makeInv([]);
    const fixes = [{ target: "main", status: "FIX_ANNOUNCED" as const, evidenceIds: [] }];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("EVIDENCE_REQUIRED");
  });

  it("accepts_nothing_found_without_evidence", () => {
    const inv = makeInv([]);
    const fixes = [
      { target: "main", status: "NO_FIX_FOUND" as const, evidenceIds: [] },
    ];
    expect(validateVerdict(inv, makeVerdict({ fixes }))).toEqual({ ok: true });
  });

  it("refuses_proven_on_reading", () => {
    const inv = makeInv(["code_reading", GOOD]);
    expect(errorsOf(inv, provenVerdict())).toContain("TEST_REQUIRED");
  });

  it("refuses_proven_when_only_good_state_was_tested", () => {
    const inv = makeInv(["code_reading", GOOD]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_proven_when_only_proposed_fix_was_tested", () => {
    const inv = makeInv(["code_reading", "claim", "execution"]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E3"] };
    expect(errorsOf(inv, provenVerdict({ proposedFix }))).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_proven_on_unknown_id_only", () => {
    const inv = makeInv(["claim"]);
    const v = provenVerdict({ candidates: [candidate("abc", "E99")], goodStateEvidenceId: "E1" });
    const errors = errorsOf(inv, v);
    expect(errors).toContain("TEST_REQUIRED");
    expect(errors).toContain("EVIDENCE_NOT_FOUND");
  });

  it("accepts_proven_on_attestation", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD]);
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("accepts_proven_on_bisect_culprit", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD]);
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("accepts_subject_sha_as_prefix_either_way", () => {
    const short = makeInv([on("attestation", "bad", CULPRIT.slice(0, 7)), GOOD]);
    expect(validateVerdict(short, provenVerdict())).toEqual({ ok: true });
    const v = provenVerdict({ candidates: [candidate(CULPRIT.slice(0, 7), "E1")] });
    expect(validateVerdict(makeInv([on("attestation", "bad"), GOOD]), v)).toEqual({ ok: true });
  });

  it("accepts_culprit_outcome_on_claimed_good_state", () => {
    const inv = makeInv([on("execution", "culprit"), "claim"]);
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("refuses_bad_on_claimed_good_state", () => {
    const inv = makeInv([on("attestation", "bad"), "claim"]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_bad_on_read_good_state", () => {
    const inv = makeInv([on("attestation", "bad"), on("code_reading", "good", OTHER)]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("proof_ignores_case_and_spaces_in_sha", () => {
    const sha = `  ${CULPRIT.toUpperCase()} `;
    const inv = makeInv([on("execution", "culprit", sha), GOOD]);
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("refusal_ignores_case_and_spaces_in_sha", () => {
    const sha = ` ${CULPRIT.toUpperCase()}`;
    const contradicted = makeInv([on("execution", "culprit"), GOOD, on("attestation", "good", sha)]);
    expect(errorsOf(contradicted, provenVerdict())).toEqual(["CONTRADICTORY_EVIDENCE"]);
    const cosmetic = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic", sha)]);
    expect(errorsOf(cosmetic, provenVerdict())).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("refusal_doubts_from_four_shared_characters", () => {
    const short = CULPRIT.slice(0, 4);
    const contradicted = makeInv([on("execution", "culprit"), GOOD, on("attestation", "good", short)]);
    expect(errorsOf(contradicted, provenVerdict())).toEqual(["CONTRADICTORY_EVIDENCE"]);
    const cosmetic = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic", short)]);
    expect(errorsOf(cosmetic, provenVerdict())).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("refusal_doubts_on_shared_prefix_that_diverges", () => {
    const close = `${CULPRIT.slice(0, 4)}ffffff`;
    const contradicted = makeInv([on("execution", "culprit"), GOOD, on("attestation", "good", close)]);
    expect(validateVerdict(contradicted, provenVerdict())).toEqual({ ok: true });
    const cosmetic = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic", close)]);
    expect(validateVerdict(cosmetic, provenVerdict())).toEqual({ ok: true });
    const goodState = makeInv([on("execution", "culprit"), on("execution", "good", close)]);
    expect(validateVerdict(goodState, provenVerdict())).toEqual({ ok: true });
  });

  it("refusal_matches_a_prefix_in_both_directions", () => {
    const short = CULPRIT.slice(0, 4);
    const inv = makeInv([on("execution", "culprit", CULPRIT), GOOD, on("attestation", "good", CULPRIT)]);
    const v = provenVerdict({ candidates: [candidate(short, "E1")] });
    expect(errorsOf(inv, v)).toContain("CONTRADICTORY_EVIDENCE");
  });

  it("accepts_fix_line_when_shas_share_four_characters_then_diverge", () => {
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E1", "E2"] }];
    const inv = makeInv([
      on("attestation", "good", `${CULPRIT.slice(0, 4)}ffffff`),
      on("execution", "bad"),
    ]);
    expect(validateVerdict(inv, makeVerdict({ fixes }))).toEqual({ ok: true });
  });

  it("refuses_cited_subject_sha_under_four_characters", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "bad", "abc")]);
    const v = provenVerdict({ candidates: [candidate(CULPRIT, "E1", "E3")] });
    expect(errorsOf(inv, v)).toEqual(["MALFORMED_VERDICT"]);
  });

  it("refuses_good_state_on_candidate_at_any_kind_and_outcome", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    for (const sha of [CULPRIT, CULPRIT.slice(0, 4)]) {
      for (const kind of ["execution", "attestation", "code_reading", "claim"] as const) {
        for (const outcome of ["good", "bad", "culprit", "cosmetic"] as const) {
          const expected =
            outcome === "good"
              ? ["GOOD_STATE_IS_CULPRIT_EVIDENCE"]
              : ["GOOD_STATE_REQUIRED", "GOOD_STATE_IS_CULPRIT_EVIDENCE"];
          expect(errorsOf(makeInv(["code_reading", on(kind, outcome, sha)]), v)).toEqual(expected);
        }
      }
    }
  });

  it("refuses_good_state_with_broken_outcome_at_any_kind", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    for (const kind of ["execution", "attestation", "code_reading", "claim"] as const) {
      for (const outcome of ["bad", "culprit", "cosmetic"] as const) {
        expect(errorsOf(makeInv(["code_reading", on(kind, outcome, OTHER)]), v)).toEqual([
          "GOOD_STATE_REQUIRED",
        ]);
      }
    }
  });

  it("refuses_tested_good_state_without_outcome_good", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    for (const kind of ["execution", "attestation"] as const) {
      expect(errorsOf(makeInv(["code_reading", kind]), v)).toEqual(["GOOD_STATE_REQUIRED"]);
    }
  });

  it("refuses_good_state_cited_as_fix_evidence", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E2"] };
    expect(errorsOf(inv, provenVerdict({ proposedFix }))).toEqual(["GOOD_STATE_IS_FIX_EVIDENCE"]);
  });

  it("refuses_good_state_as_regression_test", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, "code_reading"]);
    const proposedFix = {
      files: ["a.kt"],
      change: "c",
      explanation: "e",
      evidenceIds: ["E3"],
      regressionTestEvidenceId: "E2",
    };
    expect(errorsOf(inv, provenVerdict({ proposedFix }))).toEqual(["GOOD_STATE_IS_FIX_EVIDENCE"]);
  });

  it("refuses_good_state_cited_on_a_fix_line", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD]);
    for (const status of ["FULLY_FIXED", "FIX_ANNOUNCED"] as const) {
      const fixes = [{ target: "main", status, evidenceIds: ["E2"] }];
      expect(errorsOf(inv, provenVerdict({ fixes }))).toEqual(["GOOD_STATE_IS_FIX_EVIDENCE"]);
    }
  });

  it("refuses_good_state_cited_among_other_fix_line_evidence", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("execution", "good", "1111111aaa")]);
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E3", "E2"] }];
    expect(errorsOf(inv, provenVerdict({ fixes }))).toEqual(["GOOD_STATE_IS_FIX_EVIDENCE"]);
  });

  it("refuses_proven_on_evidence_without_subject", () => {
    expect(errorsOf(makeInv(["attestation", GOOD]), provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_proven_on_evidence_about_another_commit", () => {
    const inv = makeInv([on("attestation", "bad", "fff9999000"), GOOD]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_prefix_shorter_than_seven", () => {
    const inv = makeInv([on("attestation", "bad", CULPRIT.slice(0, 6)), GOOD]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_proven_when_culprit_tested_good", () => {
    const inv = makeInv([on("attestation", "good"), "claim"]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED", "CONTRADICTORY_EVIDENCE"]);
  });

  it("refuses_proven_on_reading_with_subject", () => {
    const inv = makeInv([on("code_reading", "culprit"), "claim"]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_proven_when_subject_is_only_on_uncited_evidence", () => {
    const inv = makeInv(["code_reading", "claim", on("execution", "culprit")]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_good_state_tested_bad", () => {
    for (const outcome of ["bad", "culprit"] as const) {
      const inv = makeInv([on("execution", "culprit"), on("execution", outcome, OTHER)]);
      expect(errorsOf(inv, provenVerdict())).toEqual(["GOOD_STATE_REQUIRED"]);
    }
  });

  it("refuses_good_state_cited_on_candidate", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD]);
    const v = provenVerdict({ goodStateEvidenceId: "E2", candidates: [candidate(CULPRIT, "E1", "E2")] });
    expect(errorsOf(inv, v)).toEqual(["GOOD_STATE_IS_CULPRIT_EVIDENCE"]);
  });

  it("refuses_blank_candidate_sha", () => {
    const inv = makeInv(["code_reading"]);
    expect(errorsOf(inv, makeVerdict({ candidates: [candidate("   ", "E1")] }))).toEqual([
      "EVIDENCE_REQUIRED",
    ]);
  });

  it("refuses_candidate_sha_under_four_characters", () => {
    const inv = makeInv(["code_reading"]);
    for (const sha of ["a", "abc", "  abc  "]) {
      expect(errorsOf(inv, makeVerdict({ candidates: [candidate(sha, "E1")] }))).toEqual([
        "EVIDENCE_REQUIRED",
      ]);
    }
  });

  it("accepts_candidate_sha_of_four_characters", () => {
    const v = makeVerdict({ candidates: [candidate("abcd", "E1")] });
    expect(validateVerdict(makeInv(["code_reading"]), v)).toEqual({ ok: true });
  });

  const behaviorOn = (sha: string): Omit<Evidence, "id"> => ({
    kind: "code_reading", summary: "classified behavior", source: "classification", data: { sha, kind: "behavior", reason: "sign" }, untrusted: true,
  });

  it("a_later_behavior_classification_cancels_cosmetic", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic")]);
    addEvidence(inv, behaviorOn(CULPRIT));
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("an_earlier_behavior_classification_cancels_nothing", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD]);
    addEvidence(inv, behaviorOn(CULPRIT));
    addEvidence(inv, { kind: "code_reading", summary: "cosmetic", source: "classification", data: {}, untrusted: true, subject: { sha: CULPRIT, outcome: "cosmetic" } });
    expect(errorsOf(inv, provenVerdict())).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("a_behavior_classification_of_another_commit_cancels_nothing", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic")]);
    addEvidence(inv, behaviorOn("fff1234def5678"));
    expect(errorsOf(inv, provenVerdict())).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("a_superseded_cosmetic_classification_counts_for_nothing", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("code_reading", "cosmetic")]);
    inv.evidence[2].superseded = true;
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("refuses_cosmetic_candidate_on_cited_evidence", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD, on("code_reading", "cosmetic")]);
    const v = provenVerdict({ candidates: [candidate(CULPRIT, "E1", "E3")] });
    expect(errorsOf(inv, v)).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("refuses_cosmetic_candidate_on_uncited_evidence", () => {
    const short = CULPRIT.slice(0, 7);
    const inv = makeInv([on("attestation", "bad"), GOOD, on("code_reading", "cosmetic", short)]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["CANDIDATE_COSMETIC"]);
  });

  it("accepts_probable_on_cosmetic_candidate", () => {
    const inv = makeInv([on("code_reading", "cosmetic"), "claim"]);
    expect(validateVerdict(inv, provenVerdict({ origin: "PROBABLE_REGRESSION" }))).toEqual({
      ok: true,
    });
  });

  it("refuses_culprit_also_tested_good_as_good_state", () => {
    const inv = makeInv([on("attestation", "bad"), on("execution", "good")]);
    expect(errorsOf(inv, provenVerdict())).toEqual([
      "GOOD_STATE_IS_CULPRIT_EVIDENCE",
      "CONTRADICTORY_EVIDENCE",
    ]);
  });

  it("refuses_culprit_tested_good_on_uncited_evidence", () => {
    const short = CULPRIT.slice(0, 7);
    const inv = makeInv([on("attestation", "bad"), GOOD, on("attestation", "good", short)]);
    expect(errorsOf(inv, provenVerdict())).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("reading_good_does_not_contradict_a_test", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD, on("code_reading", "good")]);
    expect(validateVerdict(inv, provenVerdict())).toEqual({ ok: true });
  });

  it("refuses_proven_if_intermittent_unanswered", () => {
    const inv = makeInv([on("execution", "culprit"), "claim"], { intermittent: null });
    expect(errorsOf(inv, provenVerdict())).toEqual(["INTERMITTENT_CAPPED"]);
  });

  it("refuses_proven_if_intermittent_absent_from_old_file", () => {
    const inv = makeInv([on("execution", "culprit"), "claim"]);
    delete (inv as Partial<Investigation>).intermittent;
    expect(errorsOf(inv, provenVerdict())).toEqual(["INTERMITTENT_CAPPED"]);
  });

  it("refuses_unknown_origin", () => {
    const v = makeVerdict({ origin: "REGRESSION_CERTAINE" as Verdict["origin"] });
    expect(errorsOf(makeInv([]), v)).toContain("UNKNOWN_VERDICT_VALUE");
  });

  it("refuses_unknown_fix_status", () => {
    const fixes = [{ target: "main", status: "TOUT_VA_BIEN" as "NOT_FIXED", evidenceIds: ["E1"] }];
    expect(errorsOf(makeInv(["execution"]), makeVerdict({ fixes }))).toEqual([
      "UNKNOWN_VERDICT_VALUE",
    ]);
  });

  it("refuses_missing_arrays_without_throwing", () => {
    for (const key of ["candidates", "fixes", "observed", "inferred", "unknown"] as const) {
      const v: Partial<Verdict> = makeVerdict({});
      delete v[key];
      expect(errorsOf(makeInv([]), v as Verdict)).toContain("MALFORMED_VERDICT");
    }
  });

  it("refuses_malformed_nested_values_without_throwing", () => {
    const malformed = [
      null,
      "verdict",
      { ...makeVerdict({}), candidates: [null] },
      { ...makeVerdict({}), candidates: [{ sha: "abc" }] },
      { ...makeVerdict({}), candidates: [{ sha: 7, evidenceIds: [] }] },
      { ...makeVerdict({}), fixes: [{ target: "main", status: "NOT_FIXED" }] },
      { ...makeVerdict({}), proposedFix: { files: ["a"], change: 1, explanation: "e", evidenceIds: [] } },
      { ...makeVerdict({}), noProposedFixReason: 1 },
      { ...makeVerdict({}), goodStateEvidenceId: 1 },
    ];
    for (const v of malformed) {
      expect(errorsOf(makeInv([]), v as unknown as Verdict)).toContain("MALFORMED_VERDICT");
    }
  });

  it("refuses_empty_proposed_fix", () => {
    const whole = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E1"] };
    const partial = [
      { ...whole, files: [] },
      { ...whole, files: ["  "] },
      { ...whole, files: ["a.kt", " "] },
      { ...whole, change: " " },
      { ...whole, explanation: "" },
    ];
    for (const proposedFix of partial) {
      expect(errorsOf(makeInv(["code_reading"]), makeVerdict({ proposedFix }))).toEqual([
        "PROPOSED_FIX_REQUIRED",
      ]);
    }
  });

  it("refuses_proven_with_two_candidates", () => {
    const inv = makeInv(["execution", "claim"]);
    const v = provenVerdict({ candidates: [candidate("abc", "E1"), candidate("def", "E1")] });
    expect(errorsOf(inv, v)).toContain("SINGLE_CULPRIT_REQUIRED");
  });

  it("refuses_proven_without_candidate", () => {
    const inv = makeInv(["execution", "claim"]);
    const errors = errorsOf(inv, provenVerdict({ candidates: [] }));
    expect(errors).toContain("SINGLE_CULPRIT_REQUIRED");
    expect(errors).toContain("TEST_REQUIRED");
  });

  it("refuses_proven_if_intermittent", () => {
    const inv = makeInv(["execution", "claim"], { intermittent: true });
    expect(errorsOf(inv, provenVerdict())).toContain("INTERMITTENT_CAPPED");
  });

  it("accepts_probable_if_intermittent", () => {
    const inv = makeInv(["execution", "claim"], { intermittent: true });
    expect(validateVerdict(inv, provenVerdict({ origin: "PROBABLE_REGRESSION" }))).toEqual({
      ok: true,
    });
  });

  it("refuses_regression_without_good_state", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({ origin: "PROBABLE_REGRESSION", candidates: [candidate("abc", "E1")] });
    expect(errorsOf(inv, v)).toContain("GOOD_STATE_REQUIRED");
  });

  it("refuses_proven_without_good_state", () => {
    const inv = makeInv(["execution"]);
    expect(errorsOf(inv, provenVerdict({ goodStateEvidenceId: undefined }))).toContain(
      "GOOD_STATE_REQUIRED",
    );
  });

  it("accepts_good_state_as_claim", () => {
    const inv = makeInv(["code_reading", "claim"]);
    expect(validateVerdict(inv, provenVerdict({ origin: "PROBABLE_REGRESSION" }))).toEqual({
      ok: true,
    });
  });

  it("refuses_origin_defect_without_commit", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({ origin: "ORIGINAL_DEFECT", candidates: [candidate("abc", "E1")] });
    expect(errorsOf(inv, v)).toContain("FIRST_COMMIT_REQUIRED");
  });

  it("refuses_origin_defect_when_commit_is_not_cited", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: "first",
      candidates: [candidate("other", "E1")],
    });
    expect(errorsOf(inv, v)).toEqual(["FIRST_COMMIT_REQUIRED"]);
  });

  it("accepts_origin_defect_citing_its_commit", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: CULPRIT,
      candidates: [candidate(CULPRIT, "E1")],
    });
    expect(validateVerdict(inv, v)).toEqual({ ok: true });
  });

  it("origin_defect_matches_commit_by_prefix_case_and_spaces", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: `  ${CULPRIT.toUpperCase()} `,
      candidates: [candidate(CULPRIT.slice(0, 7), "E1")],
    });
    expect(validateVerdict(inv, v)).toEqual({ ok: true });
  });

  it("origin_defect_refuses_prefix_shorter_than_seven", () => {
    const inv = makeInv(["code_reading"]);
    const v = makeVerdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: CULPRIT,
      candidates: [candidate(CULPRIT.slice(0, 6), "E1")],
    });
    expect(errorsOf(inv, v)).toEqual(["FIRST_COMMIT_REQUIRED"]);
  });

  it("refuses_origin_defect_on_shallow", () => {
    const inv = makeInv(["code_reading"], {
      coverage: { examined: ["main"], notExamined: [HISTORY_TRUNCATED_NOTE] },
    });
    const v = makeVerdict({
      origin: "ORIGINAL_DEFECT",
      firstFeatureCommit: "first",
      candidates: [candidate("first", "E1")],
    });
    expect(errorsOf(inv, v)).toContain("HISTORY_TRUNCATED");
  });

  it("refuses_full_fix_on_reading", () => {
    const inv = makeInv(["code_reading"]);
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E1"] }];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("TEST_REQUIRED");
  });

  it("refuses_not_fixed_on_reading", () => {
    const inv = makeInv(["code_reading"]);
    const fixes = [{ target: "main", status: "NOT_FIXED" as const, evidenceIds: ["E1"] }];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("TEST_REQUIRED");
  });

  it("fix_test_must_be_on_its_own_line", () => {
    const inv = makeInv(["code_reading", on("execution", "good")]);
    const fixes = [
      { target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E2"] },
      { target: "release/3", status: "NOT_FIXED" as const, evidenceIds: ["E1"] },
    ];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toEqual(["TEST_REQUIRED"]);
  });

  it("full_fix_needs_outcome_good", () => {
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E1"] }];
    const v = makeVerdict({ fixes });
    expect(validateVerdict(makeInv([on("attestation", "good")]), v)).toEqual({ ok: true });
    expect(errorsOf(makeInv([on("attestation", "bad")]), v)).toEqual(["TEST_REQUIRED"]);
    expect(errorsOf(makeInv(["attestation"]), v)).toEqual(["TEST_REQUIRED"]);
    expect(errorsOf(makeInv([on("code_reading", "good")]), v)).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_full_fix_citing_bad_alongside_good", () => {
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E1", "E2"] }];
    const inv = makeInv([on("attestation", "good"), on("execution", "bad")]);
    expect(errorsOf(inv, makeVerdict({ fixes }))).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("accepts_full_fix_when_bad_and_good_are_on_different_commits", () => {
    const fixes = [{ target: "main", status: "FULLY_FIXED" as const, evidenceIds: ["E1", "E2"] }];
    const inv = makeInv([on("attestation", "good", "1111111aaa"), on("execution", "bad", "2222222bbb")]);
    expect(validateVerdict(inv, makeVerdict({ fixes }))).toEqual({ ok: true });
  });

  it("refuses_not_fixed_citing_good_and_bad_on_same_commit", () => {
    const fixes = [{ target: "main", status: "NOT_FIXED" as const, evidenceIds: ["E1", "E2"] }];
    const inv = makeInv([on("execution", "bad"), on("attestation", "good", CULPRIT.slice(0, 5))]);
    expect(errorsOf(inv, makeVerdict({ fixes }))).toEqual(["CONTRADICTORY_EVIDENCE"]);
  });

  it("accepts_not_fixed_when_bad_and_good_are_on_different_commits", () => {
    const fixes = [{ target: "main", status: "NOT_FIXED" as const, evidenceIds: ["E1", "E2"] }];
    const inv = makeInv([on("execution", "bad", "2222222bbb"), on("attestation", "good", "1111111aaa")]);
    expect(validateVerdict(inv, makeVerdict({ fixes }))).toEqual({ ok: true });
  });

  it("not_fixed_needs_outcome_bad", () => {
    const fixes = [{ target: "main", status: "NOT_FIXED" as const, evidenceIds: ["E1"] }];
    const v = makeVerdict({ fixes });
    expect(validateVerdict(makeInv([on("execution", "bad")]), v)).toEqual({ ok: true });
    expect(errorsOf(makeInv([on("execution", "good")]), v)).toEqual(["TEST_REQUIRED"]);
    expect(errorsOf(makeInv(["execution"]), v)).toEqual(["TEST_REQUIRED"]);
  });

  it("refuses_partial_without_case", () => {
    const inv = makeInv(["attestation"]);
    const fixes = [{ target: "main", status: "PARTIALLY_FIXED" as const, evidenceIds: ["E1"] }];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("FAILING_CASE_REQUIRED");
  });

  it("refuses_blank_failing_case", () => {
    const inv = makeInv(["attestation"]);
    const fixes = [
      { target: "main", status: "PARTIALLY_FIXED" as const, failingCase: "  ", evidenceIds: ["E1"] },
    ];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toContain("FAILING_CASE_REQUIRED");
  });

  it("refuses_partial_without_good_test", () => {
    const inv = makeInv([on("execution", "bad"), "code_reading"]);
    const fixes = [
      { target: "main", status: "PARTIALLY_FIXED" as const, failingCase: "tablet", evidenceIds: ["E1", "E2"] },
    ];
    expect(errorsOf(inv, makeVerdict({ fixes }))).toEqual(["TEST_REQUIRED"]);
  });

  it("a_partial_fix_may_cite_good_and_bad_on_one_commit", () => {
    const inv = makeInv([on("execution", "good", "1234567aa"), on("execution", "bad", "1234567aa")]);
    const fixes = [
      { target: "main", status: "PARTIALLY_FIXED" as const, failingCase: "tablet", evidenceIds: ["E1", "E2"] },
    ];
    expect(validateVerdict(inv, makeVerdict({ fixes }))).toEqual({ ok: true });
  });

  it("refuses_two_lines_for_one_target", () => {
    const fixes = [
      { target: "main", status: "NO_FIX_FOUND" as const, evidenceIds: [] },
      { target: " main ", status: "NO_FIX_FOUND" as const, evidenceIds: [] },
    ];
    expect(errorsOf(makeInv([]), makeVerdict({ fixes }))).toEqual(["DUPLICATE_TARGET"]);
  });

  it.each([undefined, "", "   ", 7])("refuses_blank_target_%s", (target) => {
    const fixes = [{ target, status: "NO_FIX_FOUND", evidenceIds: [] }];
    expect(errorsOf(makeInv([]), makeVerdict({ fixes: fixes as Verdict["fixes"] }))).toEqual(["MALFORMED_VERDICT"]);
  });

  it("refuses_no_coverage", () => {
    const inv = makeInv([], { coverage: { examined: [], notExamined: [] } });
    expect(errorsOf(inv, makeVerdict({}))).toContain("COVERAGE_REQUIRED");
  });

  it("indeterminate_needs_no_good_state", () => {
    expect(validateVerdict(makeInv([]), makeVerdict({}))).toEqual({ ok: true });
  });

  it("refuses_no_fix_and_no_reason", () => {
    const v = makeVerdict({ noProposedFixReason: undefined });
    expect(errorsOf(makeInv([]), v)).toContain("PROPOSED_FIX_REQUIRED");
  });

  it("refuses_blank_reason", () => {
    const v = makeVerdict({ noProposedFixReason: "   " });
    expect(errorsOf(makeInv([]), v)).toContain("PROPOSED_FIX_REQUIRED");
  });

  it("refuses_declared_score", () => {
    for (const key of ["score", "confidence"]) {
      const v = { ...makeVerdict({}), [key]: 99 } as Verdict;
      expect(errorsOf(makeInv([]), v)).toContain("SCORE_IS_COMPUTED");
    }
  });

  it("refuses_declared_score_at_any_depth", () => {
    const nested = [
      { ...makeVerdict({}), candidates: [{ sha: "abc", evidenceIds: [], confidence: 90 }] },
      { ...makeVerdict({}), extra: { deep: [{ score: 1 }] } },
      { candidates: "not an array", meta: { score: 1 } },
    ];
    for (const v of nested) {
      expect(errorsOf(makeInv([]), v as unknown as Verdict)).toContain("SCORE_IS_COMPUTED");
    }
  });

  it("score_check_survives_a_cycle", () => {
    const v = makeVerdict({}) as Verdict & { self?: unknown };
    v.self = v;
    expect(() => validateVerdict(makeInv([]), v)).not.toThrow();
  });

  it("collects_all_errors", () => {
    const inv = makeInv(["code_reading"], {
      intermittent: true,
      coverage: { examined: [], notExamined: [] },
    });
    const v = provenVerdict({
      candidates: [candidate("abcd", "E1"), candidate("def0", "E99")],
      goodStateEvidenceId: undefined,
      noProposedFixReason: undefined,
    });
    expect(errorsOf(inv, v).sort()).toEqual(
      [
        "COVERAGE_REQUIRED",
        "EVIDENCE_NOT_FOUND",
        "GOOD_STATE_REQUIRED",
        "INTERMITTENT_CAPPED",
        "PROPOSED_FIX_REQUIRED",
        "SINGLE_CULPRIT_REQUIRED",
        "TEST_REQUIRED",
      ].sort(),
    );
  });

  it("reports_each_code_once", () => {
    const inv = makeInv([]);
    const v = makeVerdict({ candidates: [candidate("abcd", "E98", "E99")] });
    expect(errorsOf(inv, v)).toEqual(["EVIDENCE_NOT_FOUND"]);
  });
});

describe("scoreVerdict", () => {
  it("execution_single_candidate_tested_good", () => {
    const { cause } = scoreVerdict(makeInv([on("execution", "culprit"), GOOD]), provenVerdict());
    expect(cause.value).toBe(95);
    expect(sumOf(cause)).toBe(95);
  });

  it("attestation_claim_good_state", () => {
    const { cause } = scoreVerdict(makeInv([on("attestation", "bad"), "claim"]), provenVerdict());
    expect(cause.value).toBe(75);
  });

  it("reading_two_candidates", () => {
    const v = provenVerdict({
      origin: "PROBABLE_REGRESSION",
      candidates: [candidate("abc", "E1"), candidate("def", "E1")],
    });
    expect(scoreVerdict(makeInv(["code_reading", on("attestation", "good", OTHER)]), v).cause.value).toBe(45);
  });

  it("each_extra_candidate_costs_ten", () => {
    const v = provenVerdict({
      origin: "PROBABLE_REGRESSION",
      candidates: [candidate("a", "E1"), candidate("b", "E1"), candidate("c", "E1")],
    });
    expect(scoreVerdict(makeInv(["code_reading", on("attestation", "good", OTHER)]), v).cause.value).toBe(35);
  });

  it("strongest_kind_across_candidates_is_the_base", () => {
    const v = provenVerdict({
      origin: "PROBABLE_REGRESSION",
      candidates: [candidate("a", "E1"), candidate(CULPRIT, "E3")],
    });
    const inv = makeInv(["claim", on("attestation", "good", OTHER), on("execution", "culprit")]);
    expect(scoreVerdict(inv, v).cause.value).toBe(85);
  });

  it("good_state_evidence_does_not_raise_the_base", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    expect(scoreVerdict(makeInv(["claim", GOOD]), v).cause.value).toBe(30);
  });

  it("unlinked_test_counts_as_reading_at_most", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    const unlinked: EvidenceSpec[] = [
      "execution",
      on("execution", "bad", "fff9999000"),
      on("attestation", "good"),
      on("execution", "cosmetic"),
    ];
    for (const first of unlinked) {
      expect(scoreVerdict(makeInv([first, "code_reading"]), v).cause.value).toBe(55);
    }
  });

  it("linked_test_keeps_its_base", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    const inv = makeInv([on("attestation", "culprit", CULPRIT.slice(0, 7)), "code_reading"]);
    expect(scoreVerdict(inv, v).cause.value).toBe(85);
  });

  it("claim_stays_a_claim", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    expect(scoreVerdict(makeInv(["claim", "code_reading"]), v).cause.value).toBe(25);
  });

  it("no_candidate_means_base_zero", () => {
    const { cause } = scoreVerdict(makeInv([]), makeVerdict({}));
    expect(cause.value).toBe(0);
    expect(sumOf(cause)).toBe(0);
  });

  it("good_state_bonus_needs_outcome_good", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    expect(scoreVerdict(makeInv(["code_reading", "execution"]), v).cause.value).toBe(55);
    expect(scoreVerdict(makeInv(["code_reading", GOOD]), v).cause.value).toBe(60);
  });

  it("reading_good_state_scores_nothing", () => {
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    expect(scoreVerdict(makeInv(["code_reading", "code_reading"]), v).cause.value).toBe(55);
  });

  it("from_logs_penalty", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD], { startMode: "from_logs" });
    expect(scoreVerdict(inv, provenVerdict()).cause.value).toBe(85);
  });

  it("intermittent_capped_70", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD], { intermittent: true });
    expect(scoreVerdict(inv, provenVerdict()).cause.value).toBe(70);
  });

  it("intermittent_unanswered_capped_70", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD], { intermittent: null });
    expect(scoreVerdict(inv, provenVerdict()).cause.value).toBe(70);
  });

  it("shallow_capped_60", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD], {
      coverage: { examined: ["main"], notExamined: [HISTORY_TRUNCATED_NOTE] },
    });
    expect(scoreVerdict(inv, provenVerdict()).cause.value).toBe(60);
  });

  it("indeterminate_capped_30", () => {
    const v = makeVerdict({ candidates: [candidate(CULPRIT, "E1")] });
    expect(scoreVerdict(makeInv([on("attestation", "bad")]), v).cause.value).toBe(30);
  });

  it("clamps_to_zero_and_still_sums", () => {
    const v = provenVerdict({
      origin: "PROBABLE_REGRESSION",
      candidates: [candidate("a", "E1"), candidate("b"), candidate("c"), candidate("d")],
    });
    const { cause } = scoreVerdict(makeInv(["claim", "claim"]), v);
    expect(cause.value).toBe(0);
    expect(sumOf(cause)).toBe(0);
  });

  it("fix_capped_by_cause", () => {
    const inv = makeInv(["code_reading", on("attestation", "good", OTHER), on("execution", "good")]);
    const v = provenVerdict({
      origin: "PROBABLE_REGRESSION",
      candidates: [candidate("abc", "E1"), candidate("def", "E1")],
      proposedFix: { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E3"] },
    });
    const { cause, fix } = scoreVerdict(inv, v);
    expect(cause.value).toBe(45);
    expect(fix?.value).toBe(45);
    expect(sumOf(fix as Score)).toBe(45);
  });

  it("fix_reading_with_test", () => {
    const inv = makeInv([on("attestation", "bad"), GOOD, "code_reading", on("execution", "good")]);
    const v = provenVerdict({
      proposedFix: {
        files: ["a.kt"],
        change: "c",
        explanation: "e",
        evidenceIds: ["E3"],
        regressionTestEvidenceId: "E4",
      },
    });
    const { cause, fix } = scoreVerdict(inv, v);
    expect(cause.value).toBe(90);
    expect(fix?.value).toBe(45);
  });

  it("fix_regression_test_needs_a_real_test", () => {
    const inv = makeInv(["execution", "claim", "code_reading", "code_reading"]);
    const proposedFix = {
      files: ["a.kt"],
      change: "c",
      explanation: "e",
      evidenceIds: ["E3"],
      regressionTestEvidenceId: "E4",
    };
    expect(scoreVerdict(inv, provenVerdict({ proposedFix })).fix?.value).toBe(40);
  });

  it("fix_bonus_needs_outcome_good", () => {
    const proposedFix = {
      files: ["a.kt"],
      change: "c",
      explanation: "e",
      evidenceIds: ["E3"],
      regressionTestEvidenceId: "E4",
    };
    const score = (test: EvidenceSpec) => {
      const specs = [on("execution", "culprit"), GOOD, "code_reading", test];
      return scoreVerdict(makeInv(specs as EvidenceSpec[]), provenVerdict({ proposedFix })).fix?.value;
    };
    expect(score(on("execution", "good"))).toBe(45);
    expect(score("execution")).toBe(40);
    expect(score(on("execution", "bad"))).toBe(40);
  });

  it("fix_attestation_base", () => {
    const inv = makeInv([on("execution", "culprit"), "claim", on("attestation", "good")]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E3"] };
    expect(scoreVerdict(inv, provenVerdict({ proposedFix })).fix?.value).toBe(80);
  });

  it("fix_execution_base", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD, on("execution", "good")]);
    const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E3"] };
    expect(scoreVerdict(inv, provenVerdict({ proposedFix })).fix?.value).toBe(90);
  });

  it("fix_base_needs_outcome_good", () => {
    for (const third of ["execution", on("execution", "bad"), on("attestation", "culprit")] as EvidenceSpec[]) {
      const inv = makeInv([on("execution", "culprit"), GOOD, third]);
      const proposedFix = { files: ["a.kt"], change: "c", explanation: "e", evidenceIds: ["E3"] };
      expect(scoreVerdict(inv, provenVerdict({ proposedFix })).fix?.value).toBe(40);
    }
  });

  it("no_proposed_fix_gives_null", () => {
    const inv = makeInv(["execution", "claim"]);
    expect(scoreVerdict(inv, provenVerdict()).fix).toBeNull();
  });

  it("breakdown_sums_and_names_cap", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD], { intermittent: true });
    const { cause } = scoreVerdict(inv, provenVerdict());
    expect(sumOf(cause)).toBe(cause.value);
    expect(cause.breakdown.filter((l) => l.points < 0).map((l) => l.label)).toEqual([
      "Cap 95",
      "Cap 70: intermittency not ruled out",
    ]);
  });

  it("cap_that_changes_nothing_is_not_listed", () => {
    const inv = makeInv(["code_reading", GOOD], { intermittent: true });
    const v = provenVerdict({ origin: "PROBABLE_REGRESSION" });
    const { cause } = scoreVerdict(inv, v);
    expect(cause.value).toBe(60);
    expect(cause.breakdown.some((l) => l.label.startsWith("Cap"))).toBe(false);
  });

  it("all_caps_apply_in_order", () => {
    const inv = makeInv([on("execution", "culprit"), GOOD], {
      intermittent: true,
      coverage: { examined: ["main"], notExamined: [HISTORY_TRUNCATED_NOTE] },
    });
    const v = makeVerdict({ candidates: [candidate(CULPRIT, "E1")], goodStateEvidenceId: "E2" });
    const { cause } = scoreVerdict(inv, v);
    expect(cause.value).toBe(30);
    expect(cause.breakdown.filter((l) => l.label.startsWith("Cap"))).toEqual([
      { label: "Cap 95", points: -5 },
      { label: "Cap 70: intermittency not ruled out", points: -25 },
      { label: "Cap 60: history truncated", points: -10 },
      { label: "Cap 30: verdict indeterminate", points: -30 },
    ]);
  });
});
