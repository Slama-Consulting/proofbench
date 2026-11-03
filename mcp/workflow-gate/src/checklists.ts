export type CommandKey = "test" | "lint" | "build" | "audit" | "failingTest";
export type Workflow = "security-audit" | "clean-up" | "build-feature" | "fix-bug";

export interface Step {
  id: string;
  label: string;
  kind: "run" | "judged";
  required: boolean;
  /** Condition of a `run` step: zero exit code, non-zero for the failing test, or any code for a warning count. */
  expect?: "zero" | "nonzero" | "any";
  /** Command from `gate_start` that `gate_run` executes. Absent: the step has its own tool. */
  command?: CommandKey;
  /** Taken before the change: on an ancestor, or on the same commit in a different state. */
  before?: boolean;
  /** The warning count must not exceed that of this step. */
  noWorseThan?: string;
  /** Earlier step whose test counts this one is compared to. */
  pairedWith?: string;
  /** The command of `pairedWith` must be identical. */
  sameCommand?: boolean;
  /** The final commit must be a strict descendant of the earlier proof. */
  strictAncestor?: boolean;
  /** The note must name the examined file and its hash. */
  evidence?: boolean;
  /** Not applicable when the repo has no Android manifest. */
  androidOnly?: boolean;
  /** Every proof counts, not only the last one. */
  allProofs?: boolean;
  tool?: "gate_scan_secrets" | "gate_scan_manifest" | "gate_http";
}

const run = (id: string, label: string, rest: Partial<Step>): Step => ({ id, label, kind: "run", required: true, expect: "zero", ...rest });
const judged = (id: string, label: string, rest: Partial<Step> = {}): Step => ({ id, label, kind: "judged", required: true, ...rest });

const failingBefore = run("failing_test_before", "Failing test before the code", { expect: "nonzero", command: "failingTest", before: true });

export const CHECKLISTS: Record<Workflow, readonly Step[]> = {
  "security-audit": [
    run("secrets", "Secret scan, code and history", { tool: "gate_scan_secrets" }),
    run("deps_audit", "Dependency audit", { command: "audit" }),
    run("manifest", "Android manifest security lint", { tool: "gate_scan_manifest", androidOnly: true }),
    judged("release_apk", "Release APK check with the apk-inspector tools", { evidence: true, androidOnly: true }),
    run("api_staging", "API tests on staging", { required: false, tool: "gate_http", allProofs: true }),
  ],
  "clean-up": [
    run("tests_before", "Tests green before", { command: "test", before: true, strictAncestor: true }),
    run("lint_before", "Lint before", { command: "lint", before: true, expect: "any", strictAncestor: true }),
    run("tests_after", "Tests green after", { command: "test", pairedWith: "tests_before", sameCommand: true }),
    run("lint_after", "Lint after, no new warning", { command: "lint", noWorseThan: "lint_before", pairedWith: "lint_before", sameCommand: true, expect: "any" }),
    run("build", "Build", { command: "build" }),
  ],
  "build-feature": [
    judged("requirements", "Requirements"),
    judged("edge_cases", "Edge cases"),
    judged("plan", "Plan"),
    failingBefore,
    run("tests_after", "Tests green after", { command: "test", pairedWith: "failing_test_before" }),
    run("lint", "Lint", { command: "lint" }),
    run("build", "Build", { command: "build" }),
  ],
  "fix-bug": [
    failingBefore,
    run("test_passes_after", "The test passes after the fix", { command: "failingTest", pairedWith: "failing_test_before", sameCommand: true }),
    run("revert_fails", "The test fails again without the fix", { expect: "nonzero", command: "failingTest" }),
    run("full_suite", "Full suite", { command: "test" }),
    run("lint", "Lint", { command: "lint" }),
    run("build", "Build", { command: "build" }),
    judged("same_bug_elsewhere", "Same bug searched for elsewhere"),
  ],
};
