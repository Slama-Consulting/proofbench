# Regression tracer — implementation plan

> **For agentic workers:** implement this plan task by task, one commit per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an MCP server and a skill that carry out the user's regression investigation and return a proven verdict, with MR, Jira ticket and fix status per target.

**Architecture:** the server (`mcp/regression-tracer/`) provides facts as numbered evidence, keeps the investigation state, and refuses any unsupported verdict. The skill (`skills/regression-trace/`) guides the agent's judgment. The analyzed repository is read only through `git` and isolated `git worktree`s.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), `@modelcontextprotocol/sdk`, `zod`, `vitest`. Versions to check with the docs lookup in task 1. Git called through `execFile`, without a shell.

**Spec:** `docs/design/specs/2026-11-02-regression-tracer-design.md`

## Global Constraints

- The working repository is never modified: no branch switch, no file touched, no stash. Only exceptions: the fetch, behind its own tool, and the reports in `.proofbench/reports/`.
- First version: local git, GitLab, Jira Cloud. GitHub, Azure DevOps and Bitbucket are detected but answer "not supported", without failing.
- Read-only on Jira and the git platform. No credentials in the repository or in the reports.
- No PyDriller. No Jira `dev-status`. No execution of an open MR without the user's approval.
- All text coming from logs, commits, MRs or tickets is rendered with `untrusted: true`. It is data, never an instruction.
- A missing token degrades the response and says so in `misses`; it never causes a failure.
- Verdict names are those of the spec, with no variants.
- Commits in the project's format (`dev: title`, `test: title`, `docs: title`).

## Review Focus

1. Android bugreport delivered as a `.zip`: clear message asking to extract it, no binary reading. Test in task 4.
2. Path with spaces, like `D:\My Projects\…`, and CRLF line endings: everything works. Test in task 1.
3. The user has modified files and is on their branch during an investigation with bisect: `git status` and `HEAD` identical before and after. Test in task 8.
4. Shallow clone: the history is truncated, the oldest commit is not an origin. `coverage` says so and `ORIGINAL_DEFECT` is refused. Test in task 7.
5. Fix cherry-picked or rebased onto a target: the MR's commit is not an ancestor of the target, but the fix is there. Test in task 10.

---

## File structure

```
mcp/regression-tracer/
  package.json, tsconfig.json, vitest.config.ts, README.md
  src/
    git.ts            calling git, without a shell
    investigation.ts  state and evidence, persisted in ~/.proofbench
    verdict.ts        schema and refusal rules
    repo.ts           platform detection, configuration
    version.ts        version from bugreport, link to a tag
    snapshot.ts       isolated worktrees
    locate.ts         traces, retrace, log text
    origin.ts         blame, candidates, ranking
    bisect.ts         assisted and automatic bisect
    links.ts          ticket extraction
    gitlab.ts, jira.ts read-only clients
    fix.ts            fetch and fix search per target
    report.ts         Markdown, JSON
    server.ts         registration of the MCP tools
  test/
    helpers/repo.ts   factory of temporary git repositories
skills/regression-trace/SKILL.md
```

## Shared types (`investigation.ts`)

```ts
type EvidenceKind = "execution" | "attestation" | "code_reading" | "claim";
interface Evidence { id: string; /* "E1" */ kind: EvidenceKind; summary: string;
  source: string; data: unknown; untrusted: boolean;
  subject?: { sha: string; outcome: "bad"|"good"|"culprit"|"cosmetic" } }
interface RepoRef { repoId: string; path: string; forge: Forge; capabilities: Capabilities; misses: string[] }
interface Investigation { id: string; repos: RepoRef[]; evidence: Evidence[];
  startMode: "exact_version" | "from_logs" | null; intermittent: boolean | null;
  snapshots: Snapshot[]; coverage: { examined: string[]; notExamined: string[] } }
```

All tool functions receive an `Investigation` and return `{ evidenceIds: string[]; …data }`. `misses` lists what could not be consulted, and why.

---

### Task 1: Foundation and calling git

**Files:** Create `mcp/regression-tracer/{package.json,tsconfig.json,vitest.config.ts}`, `src/git.ts`, `test/helpers/repo.ts`. Test: `test/git.test.ts`. Add the spec and this plan to the first commit.

**Interfaces:**
- Produces: `git(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>`; `makeRepo(spec: { commits: { files: Record<string,string|null>; message: string; tag?: string; branch?: string }[]; dirName?: string }): Promise<{ path: string; shas: string[] }>` (`null` deletes the file).

- [ ] **Step 1: Write the failing tests**

`git_returns_stdout_and_code`; `git_non_zero_does_not_throw`; `git_works_in_path_with_spaces` with `makeRepo({ dirName: "My Projects", … })`; `git_never_uses_shell`: an argument `"a; echo pwned"` is passed as is to `git log --grep`, and `stdout` does not contain `pwned`; `crlf_file_is_read_intact`.

- [ ] **Step 2: Run `npm test -- test/git.test.ts`** — expected: FAIL, module not found.
- [ ] **Step 3: Implement** with `execFile`, `maxBuffer` of 64 MB, default timeout 60 s, `GIT_TERMINAL_PROMPT=0`, and `-c core.quotePath=false`.
- [ ] **Step 4: Run the tests** — expected: PASS.
- [ ] **Step 5: Commit** `dev: server foundation and git call`.

### Task 2: Investigation and evidence

**Files:** Create `src/investigation.ts`. Test: `test/investigation.test.ts`.

**Interfaces:**
- Consumes: nothing.
- Produces: types above; `createInvestigation(root?: string): Investigation`; `loadInvestigation(id, root?)`; `saveInvestigation(inv, root?)`; `addEvidence(inv, e: Omit<Evidence,"id">): Evidence`; `getEvidence(inv, id)`. `root` defaults to `~/.proofbench/investigations`.

- [ ] **Step 1: Failing tests**: `ids_are_sequential` (`E1`, `E2`); `survives_reload` (save, load, identical `evidence`, to sustain an assisted bisect over several hours); `unknown_id_throws_clear_error`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**, JSON write through a temporary file then rename.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: investigation and numbered evidence`.

### Task 3: Verdict rules

The heart of the project: this is where the rules stop being text.

**Files:** Create `src/verdict.ts`. Test: `test/verdict.test.ts`.

**Interfaces:**
- Consumes: `Investigation`, `Evidence`.
- Produces:

```ts
type Origin = "PROVEN_REGRESSION"|"PROBABLE_REGRESSION"|"ORIGINAL_DEFECT"|"INDETERMINATE";
type FixStatus = "FULLY_FIXED"|"PARTIALLY_FIXED"|"FIX_PRESENT_UNTESTED"|"FIX_ANNOUNCED"
  |"NOT_FIXED"|"NOT_FIXED_ON_READING"|"NO_FIX_FOUND";
interface Candidate { sha: string; mr?: string; ticket?: string; branch?: string; date?: string; evidenceIds: string[] }
interface FixLine { target: string; status: FixStatus; mr?: string; ticket?: string; branch?: string;
  failingCase?: string; evidenceIds: string[] }
interface ProposedFix { files: string[]; change: string; explanation: string; evidenceIds: string[];
  regressionTestEvidenceId?: string }
interface Verdict { origin: Origin; goodStateEvidenceId?: string; firstFeatureCommit?: string;
  candidates: Candidate[]; fixes: FixLine[]; proposedFix?: ProposedFix; noProposedFixReason?: string;
  observed: string[]; inferred: string[]; unknown: string[] }
validateVerdict(inv: Investigation, v: Verdict): { ok: true } | { ok: false; errors: string[] }
interface Score { value: number; breakdown: { label: string; points: number }[] }
scoreVerdict(inv: Investigation, v: Verdict): { cause: Score; fix: Score | null }
```

Scale and caps: section "Proposed fix and scores" of the spec, values to be taken over exactly. Caps apply after the total, and each one appears in `breakdown`.

- [ ] **Step 1: Failing tests, one per rule, with the expected error code**

| Test | Input | `errors` contains |
|---|---|---|
| `refuses_unknown_evidence` | id `E99` | `EVIDENCE_NOT_FOUND` |
| `refuses_no_evidence` | candidate without evidence | `EVIDENCE_REQUIRED` |
| `refuses_proven_on_reading` | `PROVEN_REGRESSION` with `code_reading` only | `TEST_REQUIRED` |
| `accepts_proven_on_attestation` | `PROVEN_REGRESSION` with `attestation`, a single candidate | ok |
| `refuses_proven_with_two_candidates` | two candidates | `SINGLE_CULPRIT_REQUIRED` |
| `refuses_proven_if_intermittent` | `inv.intermittent = true` | `INTERMITTENT_CAPPED` |
| `refuses_regression_without_good_state` | `PROBABLE` without `goodStateEvidenceId` | `GOOD_STATE_REQUIRED` |
| `accepts_good_state_as_claim` | good state of type `claim` | ok |
| `refuses_origin_defect_without_commit` | `ORIGINAL_DEFECT` without `firstFeatureCommit` | `FIRST_COMMIT_REQUIRED` |
| `refuses_origin_defect_on_shallow` | `coverage.notExamined` contains `truncated history` | `HISTORY_TRUNCATED` |
| `refuses_full_fix_on_reading` | `FULLY_FIXED` with `code_reading` | `TEST_REQUIRED` |
| `refuses_not_fixed_on_reading` | `NOT_FIXED` with `code_reading` | `TEST_REQUIRED` |
| `refuses_partial_without_case` | `PARTIALLY_FIXED` without `failingCase` | `FAILING_CASE_REQUIRED` |
| `refuses_no_coverage` | empty `examined` | `COVERAGE_REQUIRED` |
| `indeterminate_needs_no_good_state` | `INDETERMINATE` with coverage | ok |
| `refuses_no_fix_and_no_reason` | neither `proposedFix` nor `noProposedFixReason` | `PROPOSED_FIX_REQUIRED` |
| `refuses_declared_score` | `score` or `confidence` field in the verdict | `SCORE_IS_COMPUTED` |

Scores, with `scoreVerdict`:

| Test | Input | Expected |
|---|---|---|
| `execution_single_candidate_tested_good` | 90 + 5 + 5 | cause 100 capped at 95 |
| `attestation_claim_good_state` | 80 - 10 + 5 | cause 75 |
| `reading_two_candidates` | 50 + 5 on tested good state, -10 | cause 45 |
| `from_logs_penalty` | attestation, single candidate, tested state, `from_logs` | cause 85 |
| `intermittent_capped_70` | execution, intermittent | cause 70 |
| `shallow_capped_60` | execution, truncated history | cause 60 |
| `indeterminate_capped_30` | attestation, `INDETERMINATE` | cause 30 |
| `fix_capped_by_cause` | executed fix, cause 45 | fix 45 |
| `fix_reading_with_test` | reading + non-regression test, cause 90 | fix 45 |
| `no_proposed_fix_gives_null` | `noProposedFixReason` | `fix: null` |
| `breakdown_sums_and_names_cap` | any capped case | `breakdown` names the cap |

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: gather all the errors, do not stop at the first one.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: verdict refusal rules`.

### Task 4: Repository, platform, version

**Files:** Create `src/repo.ts`, `src/version.ts`. Test: `test/repo.test.ts`, `test/version.test.ts`.

**Interfaces:**
- Consumes: `git`, `Investigation`, `addEvidence`.
- Produces: `type Forge = "gitlab"|"github"|"bitbucket"|"azure"|"unknown"`; `interface Capabilities { mrLookup: boolean; tickets: boolean }`; `resolveRepo(inv, path, override?: Forge): Promise<RepoRef>`; `readConfig(path): Config` from `.proofbench/config.json` (`{ forge?, gitlabHost?, jiraProjects?: string[], retracePath? }`); `locateVersion(inv, repoId, logPath, packageName?): Promise<{ mode: "exact_version"|"from_logs"; version?: string; tags: string[]; needsInput?: string; evidenceIds: string[] }>`.

- [ ] **Step 1: Failing tests**

Platform: remotes `git@gitlab.com:a/b.git` → gitlab; `https://github.com/a/b` → github, `capabilities.mrLookup === false`, `misses` mentions "not supported"; `git@git.acme.corp:a/b.git` → unknown, without error; config `{ forge: "gitlab", gitlabHost: "git.acme.corp" }` → gitlab; no remote → unknown with `misses`; path outside a git repository → clear error.

Version: `Package [com.acme.app]` followed by `versionName=3.2.1`, `packageName: "com.acme.app"` → `exact_version`, `3.2.1`; tag `v3.2.1` found among `v3.2.1`, `v3.2.10` (no partial match); several packages without `packageName` → `needsInput`; logcat without version → `from_logs`; version without tag → `tags: []`, `needsInput`; `zip_bugreport_asks_for_extraction` (Review Focus 1): `.zip` → `needsInput` containing "extract"; log folder → walked; 200 MB file read as a stream.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: `resolveRepo` records the `RepoRef` in `inv.repos`, `locateVersion` sets `inv.startMode`. Line-by-line reading with `readline`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: platform and version detection`.

### Task 5: Isolated copies

**Files:** Create `src/snapshot.ts`. Test: `test/snapshot.test.ts`.

**Interfaces:**
- Produces: `interface Snapshot { path: string; repoId: string; ref: string }`; `openSnapshot(inv, repoId, ref: string, copyFiles?: string[]): Promise<Snapshot>`; `closeSnapshots(inv): Promise<void>`. Location: `~/.proofbench/worktrees/<id>/<n>`. `copyFiles` copies untracked files needed for the build, such as `local.properties`.

- [ ] **Step 1: Failing tests**: `snapshot_is_at_ref`; `does_not_change_user_head_or_status`; `copies_local_properties`; `close_removes_worktree_and_metadata` (`git worktree list` no longer shows it); `unknown_ref_clear_error`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `git worktree add --detach`, then `git worktree remove --force` and `prune`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: isolated working copies`.

### Task 6: Locate the code

**Files:** Create `src/locate.ts`. Test: `test/locate.test.ts`.

**Interfaces:**
- Consumes: `git`, `Snapshot`, `readConfig`.
- Produces: `locateCode(inv, snapshot, input: { trace?: string; logText?: string; mappingPath?: string }): Promise<{ hits: { file: string; line?: number; via: "frame"|"retrace"|"log_text" }[]; obfuscated: boolean; needsInput?: string; history?: { firstSeen?: string; lastRemoved?: string }; evidenceIds: string[] }>`.

- [ ] **Step 1: Failing tests**: `at com.acme.Foo.bar(Foo.kt:42)` → `app/src/main/java/com/acme/Foo.kt`, line 42; two `Foo.kt` files → both, told apart by package; `at a.b.c(SourceFile:12)` without mapping → `obfuscated`, `needsInput` asking for the mapping; with mapping and a fake `retrace` executable → frames resolved; `retrace` absent → `needsInput`, no exception; `logText` present → `via: "log_text"` and `history.firstSeen`; deleted text → empty `hits` and `history.lastRemoved`; `logText` containing `"$(rm -rf /)"` treated literally.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `git ls-files`, `git grep -n -F`, `git log -S --format=%H`. Evidence of type `code_reading`, `untrusted: true`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: locating from traces and logs`.

### Task 7: Origin and ranking

**Files:** Create `src/origin.ts`. Test: `test/origin.test.ts`.

**Interfaces:**
- Produces: `traceOrigin(inv, snapshot, file, startLine, endLine): Promise<{ candidates: OriginCandidate[]; shallow: boolean; evidenceIds: string[] }>` with `OriginCandidate { sha, author, date, subject, hint: "cosmetic"|"dependency_bump"|"unknown" }`; `classifyChange(inv, snapshot, sha, file): Promise<{ before: string; after: string; evidenceIds: string[] }>`; `recordClassification(inv, sha, kind: "behavior"|"cosmetic", reason: string): Evidence`.

- [ ] **Step 1: Failing tests**: `skips_whitespace_commit` (commit 2 reformats, commit 1 remains a candidate); `follows_move_across_files`; `honours_blame_ignore_revs`; `rename_only_commit_hint_cosmetic`; `real_change_after_rename_ranked_first`; `gradle_only_commit_hint_dependency_bump` (also `libs.versions.toml`, `.gitmodules`, submodule); `shallow_clone_reported` (Review Focus 4): `shallow: true`, and `coverage.notExamined` contains `truncated history`; `classify_returns_before_after`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `git blame --porcelain -w -M -C`, `--ignore-revs-file` if `.git-blame-ignore-revs` exists, and `git log -L`. `hint: "cosmetic"` when `git show -w` is empty; for renames, comparison with normalized identifiers. The final judgment stays with the agent.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: line origin and ranking`.

### Task 8: Bisect and attestations

**Files:** Create `src/bisect.ts`. Test: `test/bisect.test.ts`.

**Interfaces:**
- Consumes: `Snapshot`, `git`, `addEvidence`.
- Produces: `bisectStart(inv, snapshot, good, bad): Promise<BisectStep>`; `bisectAnswer(inv, snapshot, answer: "good"|"bad"|"skip"): Promise<BisectStep>` with `BisectStep { done: boolean; testSha?: string; worktree: string; culprit?: string; remainingEstimate: number }`; `bisectAuto(inv, snapshot, good, bad, command: string[], budgetMs: number): Promise<BisectStep & { stoppedByBudget: boolean }>`; `recordAttestation(inv, a: { statement: string; version: string; sha?: string; outcome?: "bad"|"good"; intermittent?: boolean; kind: "tested"|"asserted" }): Evidence`.

`asserted` creates a `claim` evidence; `tested` an `attestation` evidence, which requires `sha` and `outcome`, stored in `subject`. `intermittent` sets `inv.intermittent` to `true` or `false`; as long as the user has not answered, it is `null`. Each `bisectAnswer` creates an evidence with `subject`; the culprit found carries `outcome: "culprit"`, and only a finished bisect produces one.

- [ ] **Step 1: Failing tests**: `assisted_bisect_finds_culprit` on 8 commits, answering according to an oracle; `skip_is_supported`; `assisted_survives_reload`; `auto_bisect_finds_culprit` with a test script; `auto_exit_125_skips`; `auto_budget_stops_cleanly`: `stoppedByBudget`, no culprit, `coverage` says so; `user_repo_untouched` (Review Focus 3): modified file and active branch, `git status --porcelain` and `HEAD` identical before and after; `attestation_tested_vs_asserted`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in the snapshot's worktree. Culprit in assisted mode: `attestation` evidence. In automatic mode: `execution` evidence that keeps the command and the output.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: assisted and automatic bisect`.

### Task 9: Tickets, GitLab, Jira

**Files:** Create `src/links.ts`, `src/gitlab.ts`, `src/jira.ts`. Test: `test/links.test.ts`, `test/gitlab.test.ts`, `test/jira.test.ts`.

**Interfaces:**
- Produces: `type LinkSource = "mr_link"|"commit_mention"|"branch_name"|"text_match"`; `extractTickets(text: string, source: LinkSource, projects?: string[]): TicketLink[]`; `linkChange(inv, repoId, sha, deps?): Promise<{ mr?: MrInfo; tickets: TicketLink[]; misses: string[]; evidenceIds: string[] }>`; `class GitLabClient { constructor(host, token, fetchFn?); mrsForCommit(project, sha): Promise<MrInfo[]>; openMrs(project, search?): Promise<MrInfo[]> }` with `MrInfo { iid, title, description, sourceBranch, mergedAt?, mergeCommitSha?, squashCommitSha?, state, url }`; `class JiraClient { constructor(baseUrl, email, token, fetchFn?); getIssue(key): Promise<{ key, summary, status } | null> }`.

All links are ranked by reliability, in the order of `LinkSource`.

- [ ] **Step 1: Failing tests**

Extraction: `refs: PROJ-123` → `commit_mention`; branch name `feature/PROJ-1-login`; `CVE-2024-1234`, `SHA-256`, `UTF-8` excluded; `jiraProjects: ["PROJ"]` excludes `ABC-1`; two tickets in one commit → both; `refs: AB-1, AB-2` → both; merge commit `Merge branch 'feature/PROJ-9' into 'main'` → `branch_name`.

GitLab, with mocked `fetchFn`: `/repository/commits/:sha/merge_requests` parsed; URL-encoded project (`a%2Fb`); 401 → `misses`, no exception; 404 → no MR; pagination followed.

`linkChange`: without `GITLAB_TOKEN` → the commit's tickets anyway, `misses` says so; Jira 404 on a key → link kept, marked unvalidated; token never present in the result or in `misses`.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** GitLab token: `GITLAB_TOKEN`, otherwise `glab config get token --host <host>` (command to be verified). Jira: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; `GET /rest/api/3/issue/{key}?fields=summary,status`. Base regex: `\b[A-Z][A-Z0-9]+-\d+\b`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: commit, MR and ticket links`.

### Task 10: Fix search

**Files:** Create `src/fix.ts`. Test: `test/fix.test.ts`.

**Interfaces:**
- Consumes: `git`, `GitLabClient`, `linkChange`.
- Produces: `fetchRefs(inv, repoId): Promise<{ ok: boolean; output: string }>`; `checkFix(inv, repoId, input: { culprit?: string; file: string; faultySnippet: string; targets?: string[]; logText?: string }, deps?): Promise<{ targets: TargetFinding[]; coverage: string[]; evidenceIds: string[] }>` with `TargetFinding { target; kind: "tag"|"branch"|"open_mr"; containsCulprit?: boolean; faultyCodePresent: boolean; candidateFixes: { sha; subject; via: "history"|"patch_id" }[]; claimedBy: MrInfo[] }`.

Default targets: latest tag sorted by version, default branch, `origin/release*`, open MRs. The server returns the facts; the status is chosen in the verdict and checked by task 3.

- [ ] **Step 1: Failing tests**: `fix_on_main_absent_from_release`: two lines with different results; `cherry_picked_fix_detected` (Review Focus 5): `via: "patch_id"`; `squash_fix_found_in_history`; `open_mr_is_read_not_executed`: no checkout or fetch call on `refs/merge-requests/*`; `claim_without_code_change`: `claimedBy` filled, `faultyCodePresent: true`; `file_moved_then_fixed`; `no_forge_token_still_checks_local_targets`; `coverage_lists_every_target_examined_and_missing`; `fetchRefs` on unreachable remote → `ok: false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `git tag --sort=-v:refname`, `merge-base --is-ancestor`, `git show <target>:<file>`, `git log`, `git patch-id --stable`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: per-target fix search`.

### Task 11: Report and final verdict

**Files:** Create `src/report.ts`. Test: `test/report.test.ts`.

**Interfaces:**
- Consumes: `validateVerdict`, `closeSnapshots`.
- Produces: `submitVerdict(inv, repoId, v: Verdict): Promise<{ ok: true; markdownPath: string; jsonPath: string } | { ok: false; errors: string[] }>`; `recordFeedback(inv, reportPath, outcome: "useful"|"dead_end"|"fixed", note?: string): Promise<void>`.

- [ ] **Step 1: Failing tests**: `refused_verdict_writes_nothing_and_keeps_snapshots`; `accepted_verdict_closes_snapshots`; `header_shows_commit_mr_ticket_branch_date`; `header_shows_both_scores_with_breakdown`; `proposed_fix_section_present`; `probable_header_lists_candidates`; `attested_good_state_flagged_in_header` ("unverified claim"); `fix_table_has_one_row_per_target`; `sections_observe_deduit_inconnu_ecartes_couverture`; `report_invisible_to_git_status`: `.proofbench/` added to `.git/info/exclude`, `git status --porcelain` empty; `no_secret_in_report`; `feedback_appended`.
- [ ] **Step 2: Run** — FAIL.
Also: `refuses_good_state_not_ancestor` (`GOOD_STATE_NOT_ANCESTOR`); `refuses_bad_without_good_parent`: `bad` evidence without `culprit`, good state that is not the culprit's direct parent (`GOOD_STATE_NOT_PARENT`); `refuses_unknown_sha`: a candidate commit absent from the repository, checked with `git cat-file -e`, returns `SHA_UNKNOWN`; `attestation_statement_shown_in_header`.

- [ ] **Step 3: Implement.** Name: `.proofbench/reports/<date>-<id>.md` and `.json`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `dev: report and final verdict`.

### Task 12: MCP server and skill

**Files:** Create `src/server.ts`, `README.md`, `skills/regression-trace/SKILL.md`. Modify `mcp/README.md`, `skills/README.md`. Test: `test/server.test.ts`, `test/e2e.test.ts`.

**Interfaces:**
- Consumes: all the functions above.
- Produces: MCP tools `resolve_repo`, `locate_version`, `open_snapshot`, `locate_code`, `trace_origin`, `classify_change`, `record_classification`, `bisect_start`, `bisect_answer`, `bisect_auto`, `record_attestation`, `link_change`, `fetch_refs`, `check_fix`, `submit_verdict`, `record_feedback`.

The spec's `run_bisect` becomes three tools, and the fetch a dedicated tool, so that only `bisect_auto`, `fetch_refs`, `record_attestation` and `bisect_answer` trigger a sensitive authorization: the last two create evidence that is worth the user's word, and the agent must not be able to produce it without them. Annotations: `readOnlyHint` on the read tools, never on those four. Input schemas are strict at every level (`z.strictObject`), so that a `score` field is not silently stripped, and they run before `validateVerdict`.

- [ ] **Step 1: Failing tests.** `server.test.ts` with the SDK's in-memory transport: the list contains the 16 tools; invalid schema refused; `bisect_auto`, `fetch_refs`, `record_attestation` and `bisect_answer` without `readOnlyHint`; any tool other than `resolve_repo` without a valid `investigationId` → error; any result containing repository text carries `_meta.untrusted`.

`e2e.test.ts`, fabricated repository of 10 commits with reformatting, faulty change `refs: PROJ-42`, fix cherry-picked onto `release/1`, tags, mocked GitLab and Jira. The scenario follows the spec and expects: `PROVEN_REGRESSION`, the faulty commit, `PROJ-42`, `FULLY_FIXED` on `release/1` with attestation, `NOT_FIXED_ON_READING` on `main`.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement `server.ts`**: stdio transport, no business logic.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Write `SKILL.md`**

Description limited to triggers. Content: the spec's sequence, the two starting points (exact version, or logs), the three distinct questions, "`blame` is a hint", `AskUserQuestion` for any ambiguity, the assisted bisect steps, reading `needsInput`, and the instruction never to permanently authorize `bisect_auto` or `fetch_refs`. No copy of the server's rules.

- [ ] **Step 6: Test the skill under real conditions** in this order: a subagent without the skill on a fabricated repository, then one with it. Record the differences in `docs/`.
- [ ] **Step 7: Write the `README`**: build, adding to Claude Code with `claude mcp add`, environment variables, example `.proofbench/config.json`.
- [ ] **Step 8: Final verification**: `npm run build`, `npm test`, then `claude mcp list` shows the server connected.
- [ ] **Step 9: Commit** `dev: MCP server and regression-trace skill`.

---

## After the plan

The user measures the tool on 5 known regressions, with their real bugreports. Criterion: the right ticket in the top 3 candidates at least 4 times, and no false `PROVEN`. The real version formats will be adjusted at that stage. No other feature is added before this measurement.
