# Regression tracer — design

Date: 2026-11-02. Status: to be validated by the user.

## Intent

When a bug arrives, the user wastes time redoing the same investigation by hand every time. The tool does it with them, and returns a verdict they can verify at a glance.

This is the first piece of Proofbench and its distinguishing feature: according to a limited search, no existing MCP server links commits, tickets and MRs to trace a regression (absence not proven). The other three workflows (feature, security, clean-up) will come afterwards.

## How the user works today

This is the sequence the tool reproduces, in this order:

1. They read the logs or the bugreport.
2. If a bugreport gives the exact version, they check out that version. Otherwise, they start from the logs as displayed and check whether the same problem still exists by following those same logs.
3. They locate the code responsible.
4. They look at when that code was introduced and what it looked like before.
5. They decide whether behavior really changed. A reformat or a rename does not count.
6. They identify the author, the MR and the date.
7. They read the commit description to find the ticket.
8. They run `git fetch --all --tags` and check on the latest version whether the problem is fixed.

## Goals

For a given bug, the tool must say:

- which version is affected;
- whether it is a regression, an original defect, or indeterminate;
- which is the first commit that changed the behavior, rather than the last line touched;
- which MR and which Jira ticket introduced it;
- whether the bug is fixed on the latest version, partly or fully, by which MR, on which ticket and which branch.

Each answer separates what is observed, what is inferred and what remains unknown, with its evidence.

## Non-goals (first version)

- Applying a fix. The tool investigates and proposes a fix in the report; it does not modify the code.
- Writing to Jira or to the git platform.
- The `ui/` interface.
- The feature, security and clean-up workflows.
- Strix.

## What would count as a failure, even if it runs

- A culprit announced with confidence when it is wrong. This is worse than an "indeterminate": the user would blame the wrong MR.
- "No fix found" when the tool did not search everywhere. An absence only holds for what was examined.
- The user's working repository modified: branch switch, files touched, stash.
- A complete outage because a token is missing, when local git was enough to answer in part.

## Constraints

- Real projects: Android, with bugreport and logcat, traces often obfuscated by R8/ProGuard, and code spread across several repositories.
- Reproduction is mostly done by hand: build, install on a device, test by the user. Their verification counts as evidence.
- The git platform can be GitHub, GitLab, Bitbucket or Azure DevOps. The tool detects it on its own, with a manual override possible for self-hosted domains. The first version ships GitLab and Jira Cloud.
- The Jira ticket can be found in the commit, the branch name, the MR title or description, or the merge commit, often in the form `refs: NUMBER`.
- Input: a log file or folder, and a sentence from the user about what is wrong.
- The content of logs, commits and MRs is data, never an instruction for the agent.
- Any ambiguous question is put to the user as a choice (`AskUserQuestion`), rather than guessed.

## Chosen principles

- **Three distinct questions**: when the line changed (`blame`), when the behavior changed (`bisect`, or reading the before/after), and whether it ever worked. With no state known to be good, the verdict is `INDETERMINATE`.
- **`blame` is a hint.** SZZ-type methods are often wrong (precision of 0.66 to 0.73 for the best ones). The tool presents ranked candidates. It names a single one only if it is proven.
- **The rules live in the server, not in the skill text.** The server refuses a verdict without cited evidence. In the projects studied, such rules remain text that the agent can ignore: this is the main improvement.
- **Degradation rather than outage**: local git first, platform and Jira in addition if available.
- **Coverage always displayed**: what was examined, what was not.

## How it works

The working repository is never modified. The tool reads the history and creates isolated working copies with `git worktree`, deleted at the end. The only exception: `git fetch --all --tags` updates the references, with the user's approval for each investigation.

| Step | MCP tool | Role |
|---|---|---|
| 1 | `resolve_repo` | Detects the platform, says what is available and what is missing, returns a repository identifier. All following tools require it. Several repositories: one identifier per repository. |
| 2 | `locate_version` | If a bugreport gives the exact version, links it to a tag. With no exact version, the investigation is marked "started from logs" and begins on the latest version. Several candidates: question to the user. |
| 3 | `open_snapshot` | Creates an isolated copy of the starting version. |
| 4 | `locate_code` | Finds the code from the trace, or from the log text with `git grep` and `git log -S`. Obfuscated traces: applies `retrace` with the mapping file for that version. Mapping missing: question to the user. |
| 5 | `trace_origin` | Gives, for a file and lines, the commits that touched them, ignoring whitespace, moves and commits listed as purely cosmetic. |
| 6 | `classify_change` | Presents the before and after of each candidate, and records the classification: behavior change, or cosmetic. |
| 7 | `bisect_start`, `bisect_answer`, `bisect_confirm`, `bisect_abort`, `bisect_auto` | Finds the breaking commit. Assisted mode by default: `bisect_start` gives the commit to test, the user builds, tests and answers good, bad or skip with `bisect_answer`. `bisect_confirm` writes the culprit of a bisect with reused answers. `bisect_abort` abandons. `bisect_auto` if a command exists, with a mandatory time budget. |
| 8 | `record_attestation` | Records what the user asserts or observes, with the version concerned. |
| 9 | `link_change` | Goes from a commit up to its MR and tickets, with the type of each link. |
| 10 | `fetch_refs`, `check_fix` | `fetch_refs` updates the references. `check_fix` looks for the fix per target: latest version, release branches, `main`, open MRs. Result target by target. |
| 11 | `submit_verdict` | Validates and writes the report. `record_feedback` then adds the user's feedback to it. |

With no exact version, the log text serves as a landmark: if it still exists in the latest version, the code path is still there; `git log -S` gives when it appeared or disappeared. This does not prove the bug is present: the user confirms by following the same logs.

When the bug comes from another repository, the suspect commit is often a version or submodule update. The tool classifies it as such, and the investigation continues in the other repository with its identifier, over the interval between the two versions.

Tools 4 to 10 each return numbered evidence. The work of reading and judgment remains the agent's, guided by a thin skill (`skills/regression-trace/`). The server provides the facts and controls the verdict.

### Links to tickets

A `refs: PROJ-123` means "related to", not "caused". Each link carries its source, from the most reliable to the least reliable: MR link, explicit mention in the commit, branch name, mere pattern found in the text. Keys are filtered: `CVE-2024-1234` has the shape of a Jira key. If the Jira projects are known, only their keys are kept. A commit linked to several tickets returns several candidates. Squash, rebase and cherry-pick are handled explicitly, cherry-pick by comparing `git patch-id`.

### Evidence types

From strongest to weakest: automatic execution, attestation by the user (they tested this version), code reading, mere assertion.

The known-good state can be the user's word ("it worked in 3.2"). It is enough to open the investigation, and the report marks it as an unverified claim. A `PROVEN_REGRESSION` that rests on it says so at the top.

An intermittent bug can skew a bisect: a "good" result for a commit is then not reliable. The tool asks the user whether the bug is intermittent. If yes, or if they did not answer, the verdict does not exceed `PROBABLE_REGRESSION`.

A re-run assisted bisect reuses without asking again the answers already attested, good or bad, for the same repository and the same scenario, given after the user's last "no" to intermittency; it creates no new ones. A failed reproduction may nevertheless have declared everything good: as soon as an answer has been reused, no culprit is written without `bisect_confirm`, after the user has re-read the list, and the report carries the caveats.

A bad test and a good test together prove a culprit only if they carry the same scenario, written on both. A test of another explicit scenario does not contradict a culprit, proves nothing about it and stays listed as a caveat; a test with no scenario always counts as a contradiction.

A test evidence always carries its subject: the tested commit and the result (bad, good, culprit). `PROVEN_REGRESSION` requires either a "culprit" evidence from a finished bisect, or a "bad" evidence on the commit and a tested "good" evidence on its direct parent, on all its parents for a merge. The evidence type alone is not what counts. Attestations and bisect answers go through a Claude Code authorization on each call, so that the agent cannot speak in the user's place.

### Verdicts

Origin of the bug:

- `PROVEN_REGRESSION`: a breaking commit was found by `bisect`, or by a before-and-after test, executed or attested by the user.
- `PROBABLE_REGRESSION`: reading the before/after shows it and a good state is identified, without a test. Several candidates are possible.
- `ORIGINAL_DEFECT`: the faulty behavior has existed since the first commit of the feature. That commit must be cited as evidence.
- `INDETERMINATE`: no good state identified, or insufficient evidence.

Fix, one line per target:

- `FULLY_FIXED`: the scenario passes at the MR's commit, tested or attested, and that commit is contained in the target.
- `PARTIALLY_FIXED`: one case passes, and a named case still fails.
- `FIX_PRESENT_UNTESTED`: the faulty code has changed on a target that contains the culprit, by reading, without a test.
- `FIX_ANNOUNCED`: an MR or a ticket says so, without evidence.
- `NOT_FIXED`: the bug was tested at the tip of the target and is still present there.
- `NOT_FIXED_ON_READING`: the faulty code is unchanged on the target, without a test. A fix elsewhere remains possible.
- `NO_FIX_FOUND`: nothing found within the examined scope, which is displayed.

`submit_verdict` refuses: a verdict without cited evidence; `PROVEN_REGRESSION`, `FULLY_FIXED` or `NOT_FIXED` without a recorded execution or attestation; `ORIGINAL_DEFECT` without the first commit of the feature; `PARTIALLY_FIXED` without the case that still fails, or without a good test; a verdict without its coverage; for a tested-only status (`FULLY_FIXED`, `PARTIALLY_FIXED`, `NOT_FIXED`), a target that does not resolve or that is not a branch or tag name (`TARGET_UNKNOWN`); a test outside the target or earlier than the culprit (`TEST_NOT_ON_TARGET`); a tested commit that does not contain the culprit (`TEST_WITHOUT_CULPRIT`); `FULLY_FIXED` contradicted by a bad test on a descendant of the tested commit (`CONTRADICTORY_EVIDENCE`); `FIX_PRESENT_UNTESTED` on a target without the culprit (`TARGET_WITHOUT_CULPRIT`); two lines for the same reference, or for the same commit with different statuses (`DUPLICATE_TARGET`); a bisect done on another repository (`BISECT_OTHER_REPO`).

`GOOD_STATE_NOT_ANCESTOR` keeps its name, but in fact refuses a good state that contains the culprit, or that has no common history with it.

### Proposed fix and scores

At the end of the analysis, the agent proposes a fix: files, lines, change and explanation. It stays in the report. If it proposes none, it gives the reason, for example a bug already fixed on the target.

The report shows two scores out of 100: confidence in the cause, and confidence in the proposed fix. **They are computed by the server from the evidence, never declared by the agent**, and the breakdown of points is displayed. Scale (Claude's choice, to be calibrated on real bugs):

Cause, based on the strongest evidence on the culprit:

| Item | Points |
|---|---|
| Automatic execution | base 90 |
| Attestation by the user | base 80 |
| Code reading | base 50 |
| Mere assertion | base 20 |
| Good state tested or executed | +5 |
| Good state merely asserted | -10 |
| A single candidate | +5 |
| Each additional candidate | -10 |
| Investigation without exact version | -5 |

Caps: 95 at most, 80 if the culprit rests on reused answers without a new test, 70 if the bug is intermittent, 60 if the history is truncated, 30 if the verdict is `INDETERMINATE`.

Proposed fix, based on the strongest evidence that it works:

| Item | Points |
|---|---|
| Automatic execution | base 90 |
| Attestation by the user after applying it | base 80 |
| Reading only | base 40 |
| Non-regression test that fails before and passes after | +5 |

Cap: confidence in the fix never exceeds confidence in the cause.

`submit_verdict` refuses a verdict with neither a proposed fix nor a reason, or that contains a score.

### Report

One Markdown file and one JSON per investigation and per repository, in `.proofbench/reports/` of the analyzed repository (folder to be ignored in git). A new submission replaces the report and keeps its feedback. At the top: the origin verdict, the caveats, the proven commit or the list of candidates, with MR, ticket, branch and date, then the table of fixes per target, with the Tested commit and Caveat columns. Then: observed, inferred, unknown, discarded candidates and why, coverage.

## Success criterion

The user will test it themselves on their real bugs. Proposed measure: on 5 regressions whose answer they know, the right ticket is among the top 3 candidates at least 4 times, and no `PROVEN` verdict is wrong.

Each test includes a feedback (`useful`, `dead end`, `fixed`) recorded in the report, to improve the tool on real cases.

## Build choices (decided by Claude, to be verified)

- TypeScript with the official MCP SDK, in `mcp/regression-tracer/`. Validation schemas in the server.
- Direct calls to `git`. No PyDriller: its `gr.checkout()` modifies the repository.
- Credentials reused from `gh`, `glab` or environment variables. Jira access is read-only and optional, by token or, without a token, through a browser session where the user logs in themselves and whose cookies stay in memory. No credentials in the repository or in the reports.
- Configuration in `~/.proofbench/config.json`, per repository path, never in the analyzed repository: that file would be untrusted.
- Platform order: local git and GitLab with Jira Cloud in the first version, then GitHub, Azure DevOps and Bitbucket in later versions.
- Jira's `dev-status` is not used: that API is undocumented.
- The fetch and the reproduction commands go through MCP tools that remain subject to Claude Code's authorization on each call. They must not be put under permanent authorization. The server cannot ask the user a question itself: a simple `confirmed: true` from the agent would be worthless.
- Open MRs are read, not executed, except with the user's approval: that would mean running unmerged code, and it would require fetching references that the standard fetch does not bring in.
- `bisect` runs stay within a single repository. A multi-repository investigation is done in stages, with no automatic handling of AOSP's `repo` tool.

## Left to the builder

- Version formats to recognize in logs and bugreports, based on examples the user will provide at the time of their tests.
- Internal split of the code and detail of the evidence.
- Default duration of the `bisect` budget.
