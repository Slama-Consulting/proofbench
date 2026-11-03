# Development workflows — design

Date: 2026-11-02. Status: requested by the user ("do them all, one by one"), without a round of questions.

## Intent

Proofbench currently covers regression tracing. Four workflows remain, each with a checklist scored out of 10: security, clean-up, new feature, bug fix.

A 10/10 has to be provable. The server computes it from commands it ran itself and from recorded evidence; those files remain modifiable by anything with local access.

## Shape

A single shared MCP server, `mcp/workflow-gate`, and four thin skills in `skills/`: `security-audit`, `clean-up`, `build-feature`, `fix-bug`. The server provides the control, the skills carry the judgment.

## `workflow-gate` server

TypeScript, same foundation as `mcp/regression-tracer`: no shell, git resolved outside the repository, output marked `untrusted`, secrets masked.

A **checklist** is a list of steps held in the server, not in the skill. A step is either `run` (proven by a command) or `judged` (a note from the agent, which never counts as evidence).

| Tool | Role | Sensitive |
|---|---|---|
| `gate_start` | Opens a pass: workflow, repository, and the `test`, `lint` and `build` commands. | Yes |
| `gate_run` | Runs a command for a step, without a shell, and records the command, exit code, truncated output, commit and repository state. | Yes |
| `gate_note` | Records a note for a `judged` step. | No |
| `gate_status` | Says what is done and what is missing. | No |
| `gate_close` | Computes the score and writes the report. | Yes |

The score is 10 only if all mandatory `run` steps are proven on the final commit. Otherwise, `gate_close` writes the real score with the list of what is missing. Evidence taken on another commit, or with files modified since, no longer counts. The fingerprint covers tracked files, untracked files and submodules. Files ignored by `.gitignore` are excluded from it, except under the roots listed in `gate_start.watchIgnored`, and the report says so.

There is no score field on input. The report goes into `.proofbench/reports/`, excluded from git. No tool modifies the repository, other than whatever the command it runs does.

## Checklists

**Security.** `run` steps: search for secrets in the code and the history; dependency audit; Android security lint (`allowBackup`, `debuggable`, exported components, cleartext HTTP); release APK check with the `apk-inspector` tools, noted as `judged`. Optional steps depending on the project: API tests on staging, each request restricted to hosts listed in `~/.proofbench/config.json`. A written authorization and a staging host are required before any network test. Never production, never a destructive test, no flooding. The report says "no vulnerability found by these tests", never "secure".

**Clean-up.** `run` steps: tests green before, lint before, tests green after, lint after with no new warnings, build. The server compares the number of warnings and the test results before and after. Each step is one commit.

**New feature.** `judged` steps: `requirements`, `edge_cases`, plan. `run` steps: failing test before the code, tests green after, lint, build. Documentation lookup goes through the bundled `docs-lookup` server, so no external tool is needed.

**Bug fix.** Starts from a tracer report if one exists. `run` steps: test that fails before, test that passes after, removal of the fix making the test fail again (proof of non-regression), full suite, lint, build. `judged` step: same bug searched for elsewhere. The fix stays on a branch, never merged by the tool.

## Non-goals

- Strix: set aside for now.
- Running tests against production.
- Merging or pushing.
- The `ui/` interface.

## Accepted limits

- A badly written test yields empty evidence: the server proves that a command ran, not that it tests the right thing.
- The `test`, `lint` and `build` commands are supplied to `gate_start`, authorized by the user.
- "No vulnerability found" does not mean "safe".

## Success criterion

On a fabricated repository: a 10/10 is refused if a step is missing, if the commit has changed or if lint gets worse, and accepted when everything is proven.
