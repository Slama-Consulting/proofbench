# workflow-gate

MCP server shared by the `security-audit`, `clean-up`, `build-feature` and `fix-bug` workflows. It runs the commands itself, keeps the evidence and computes the score from the recorded evidence. The design is in `docs/design/specs/2026-11-02-workflows-design.md`.

In the repository, it only writes `.proofbench/reports/`, excluded from git by `.git/info/exclude`. The rest goes to `~/.proofbench/gates` (runs) and `~/.proofbench/gate-worktrees` (copies for `revert_fails`, deleted after use).

## Use it

The repository ships a pre-built single file, `bundle/workflow-gate.mjs`: no build needed. Install it for your assistant with `node scripts/setup.mjs <claude|copilot|codex|cursor|gemini>` from the repository root (see the main README), or by hand:

```bash
claude mcp add --scope user workflow-gate -- node "/path/to/proofbench/bundle/workflow-gate.mjs"
```

## Build from source

Node 20 or later.

```bash
cd mcp/workflow-gate
npm ci
npm run build
```

`npm test` runs the tests, `npm run typecheck` checks the types. From the repository root, `npm run bundle` rebuilds `bundle/`.

## Tools

| Tool | Role | Sensitive |
|---|---|---|
| `gate_start` | Opens a run: `workflow`, `repoPath`, `commands` (`test`, `lint`, `build`, `audit`, `failingTest`, as arrays), `lintMarker`, `watchIgnored`, `authorizedBy` (one sentence). | Yes |
| `gate_run` | Runs the step's command. No command as input: only those from `gate_start` run. `timeoutMs`: 30 minutes by default. | Yes |
| `gate_note` | Note for a `judged` step. `release_apk` requires `examinedFile` and `examinedSha256`, re-read at every computation. | No |
| `gate_status` | What is proven, what is missing. | No |
| `gate_close` | Computes the score and writes the report, Markdown and JSON. Can be rerun: the last report replaces the previous one. | Yes |
| `gate_http` | One request to staging. | Yes |
| `gate_scan_secrets` | Keys at HEAD, in the whole history, merges included, and in untracked files. Android shapes: `key=value`, Gradle signing, `.env*`, `key.properties`, `local.properties`, `.jks`, `.keystore`. Values masked. | No |
| `gate_scan_manifest` | `AndroidManifest.xml`: exit code 0 with no finding, 1 with findings, 2 if none is read. The step and the APK are only not applicable after a check of the disk: no `AndroidManifest.xml` under the repository, ignored files and submodules included, and no `com.android` in a `build.gradle` or `build.gradle.kts`. | No |

`failingTest` is optional: it is the command of the bug's one test, otherwise `test` is used.

## Score

`round(10 × mandatory run steps proven / mandatory run steps)`. Notes are not in the computation: they raise nothing, but if one is missing the score caps at 9. A 10 only exists with everything else. Optional steps do not count.

For `clean-up`, `lint_before` and `lint_after` accept any exit code: only the comparison counts, warnings and errors must not go up. A repository already in error therefore reaches 10 by improving. Three safeguards: a lint that was green before cannot end in failure, a failing lint must have counted something (a crash would count zero), and both counts must come from the same reader. `lintMarker` replaces the default reader: the lines that contain this substring, taken literally.

A proof counts if it is taken on the final commit with the same state fingerprint: status, diff, every untracked file, even hidden by `.git/info/exclude`, path and bytes separated by NUL, contents of nested repositories and submodules. Files ignored by `.gitignore` do not enter it, except under the roots given to `gate_start.watchIgnored`: an ignored build output may change without making a proof stale, and the report says so. An `assume-unchanged` or `skip-worktree` index entry, or a git filter whose name falls outside `[A-Za-z0-9._-]`, makes the read refuse. No git filter runs during this read. The retained state is the one from before the command. `before` steps must be on an ancestor, or on the same commit in another state, and precede the final proofs. A timeout or a launch failure has no exit code, so it never counts as "failing test".

Caps, listed by `gate_close`: 9 for any file that is not ordinary source changed since the first before-proof (tests, files named by commands, `scripts/`, `package.json`, `*.config.*`, dotfiles at any depth, `*.gradle*`, `*.toml`, lint XML, baselines, `watchIgnored` ignored paths), an unreadable test count, zero tests run, a lint with no readable count before or after, nothing to clean up, a `failingTest` with a different executable than `test` on `build-feature`; 8 for a deleted test or more ignored tests, `test.todo` included. On `build-feature` and `fix-bug`, an added test file, or a test file where lines are only added (`git diff --numstat`, 0 lines deleted), is listed with no cap; a removed or changed line caps at 9. A dropping test count invalidates the step. The report gives the real numbers of each step. Other runs of the repository in the last 24 hours are listed with their score.

`clean-up` requires a strict ancestor for its before-proofs. A before-proof is not redone on another state, nor after an after-proof.

## `revert_fails`

`gate_run` with `fixCommit` and `testFile`. A copy at the parent of the fix, with only the fix's test file, must fail. Then the same command must pass in the same copy at the fix commit: without that witness, a copy that cannot build would give a false proof.

The copy only contains tracked files. `copyFiles` adds the untracked files that are needed, such as `local.properties` or `google-services.json`: paths relative to the repository, no `..`, no followed link, never overwriting a file from the commit. `copyDirs` does the same for a folder such as `node_modules`: a real copy, redone for the witness, hence slow on a big folder. Without them, the witness fails and no proof is given. The test file at HEAD must be the fix's one, and only test files may have changed since.

## Network

`~/.proofbench/config.json`, never a file of the repository:

```json
{ "repos": { "D:/Projects/App": { "stagingHosts": ["staging.example.com"] } } }
```

It needs `authorizedBy` at `gate_start`, a host listed for that repository, HTTPS except localhost, and no `prod` in the name. GET and POST only, no redirect followed, one request per second, 200 per run. `expectStatus` sets the expected code; without it, a 5xx is a finding, like a lost connection, and every request counts. Headers that change the method are refused. The recorded response is truncated and masked: header values, URL parameter values and body fields of 8 characters or more. A body that is neither JSON nor a form is masked entirely. The URL path is not masked.

## Windows

Without a shell, `npm` (`npm.cmd`) cannot be launched: a `.bat` or `.cmd` is only accepted if it is a file of the repository, like `gradlew.bat`, and no argument may contain `& | < > ^ % ! "` or a line break.

`cmd`, `powershell`, `pwsh`, `bash` and `sh` are refused at the head of a command, on every platform. `node` has only two forms: `node --test [paths relative to the repository]`, or `node <repository script> [arguments]`, the script first. Any other argv is refused, no option exists. The script must exist from `gate_start`, except `failingTest` on `fix-bug`, which may name a future file of the repository: it is then checked at `gate_run`.

Commands are approved by the user at `gate_start`. These filters stop a mistake, not a hostile command: `node script.js` can do anything.

Two steps cannot have the same command, paths normalised, and an executable that cannot be found is refused from `gate_start`. For a Node project, call the tool directly: `["node", "node_modules/vitest/vitest.mjs", "run"]`.

## Limits

- A badly written test gives an empty proof: a 10 means the listed commands ran and the listed numbers held, not that the tests test the right thing.
- The score is computed from the recorded evidence. `~/.proofbench/gates` and `config.json` are plain files: anything with local access can modify them, and the score does not detect that modification.
- An unchanged command may test nothing: test counts, script fingerprints and caps make the gap visible, they do not make it impossible.
- An unreadable test count caps at 9. Gradle stays silent when everything passes: the server then reads the `build/test-results/**/TEST-*.xml` written by that run, and an up-to-date task writes none.
- A command that writes non-ignored files makes the proofs already taken stale.
- `gate_scan_manifest` does not read `networkSecurityConfig`, and skips `src/debug`, `src/test` and `src/androidTest` (listed in `skipped`).
- The secret search recognises known shapes; it does not prove the absence of secrets.
- "No flaw found by these tests" does not mean "secure".
