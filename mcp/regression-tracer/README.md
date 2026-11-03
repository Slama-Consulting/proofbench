# regression-tracer

MCP server that investigates a regression together with the user: version, code, culprit commit, merge request, ticket, fix status per target. It supplies the facts and checks the verdict. The `skills/regression-trace/` skill guides the agent. The design is in `docs/design/specs/2026-11-02-regression-tracer-design.md`.

In the analysed repository it only writes `.proofbench/reports/` (excluded from git by `.git/info/exclude`) and, on `fetch_refs`, the refs. Working copies go to `~/.proofbench/worktrees/<first 8 characters of the investigation>/<n>`, investigations to `~/.proofbench/investigations`.

## Use it

The repository ships a pre-built single file, `bundle/regression-tracer.mjs`: no build needed. Install it for your assistant with `node scripts/setup.mjs <claude|copilot|codex|cursor|gemini>` from the repository root (see the main README), or by hand:

```bash
claude mcp add --scope user regression-tracer -- node "/path/to/proofbench/bundle/regression-tracer.mjs"
```

The `user` scope makes the server available in the analysed repositories, not only here. To pass variables, add `-e NAME=value` before `--`. The server speaks stdio.

## Build from source

Node 20 or later.

```bash
cd mcp/regression-tracer
npm ci
npm run build
```

`npm test` runs the tests, `npm run typecheck` checks the types. From the repository root, `npm run bundle` rebuilds `bundle/`.

**Never set permanent approval for** `bisect_start`, `bisect_confirm`, `bisect_auto`, `fetch_refs`, `record_attestation`, `bisect_answer`, `bisect_abort`, `open_snapshot` or `submit_verdict`. The server cannot ask the user a question: the approval prompt of the assistant on each call is what stops the agent from speaking in the user's place.

## Environment variables

All optional: without them, local git answers in part and what is missing is reported.

| Variable | Role |
|---|---|
| `GITLAB_TOKEN` | Reading merge requests. Without it, falls back to the `glab` token. |
| `JIRA_BASE_URL` | Jira URL, in HTTPS. The only source of the Jira host: never a repository, its config, a commit or a ticket. |
| `JIRA_EMAIL` | Jira account, used with the token. Not needed with browser login. |
| `JIRA_API_TOKEN` | Jira API token. Empty or absent: browser login. |
| `JIRA_LOGIN_TIMEOUT_S` | How long to wait for the browser login, in seconds. 120 by default. |

With a token, `JIRA_EMAIL` is required and access goes through REST v3. Without a token, see below. Without `JIRA_BASE_URL`, Jira is not queried. The fallback to `glab config get token --host <host>` **is not verified**: `glab` was absent from the development machine, and recent versions may keep the token in the system keychain. In that case the fallback fails and says so.

## Jira browser login

For a Jira behind SSO or MFA, without an API token. Just set `JIRA_BASE_URL` and leave `JIRA_API_TOKEN` empty. Once, by hand, in `mcp/regression-tracer`:

```bash
npm install playwright
npx playwright install chromium
```

Playwright is an optional dependency. If it is missing, or if Chromium is missing, a miss names those two commands and the investigation continues without Jira.

**First login.** When `link_change` or `check_fix` has a ticket to check and no session, a Chromium window opens on the Jira home page. The user logs in themselves, SSO and MFA included. The server neither types nor reads any password: it polls `/rest/api/2/myself` every 2 seconds and closes the window as soon as Jira names someone. Later checks happen without a window.

**`link_change` may wait up to the timeout**, 120 seconds by default (`JIRA_LOGIN_TIMEOUT_S`). The MCP client has its own call timeout, to set above it: `MCP_TOOL_TIMEOUT` for Claude Code, in milliseconds. If the client cuts the call, the window stays open and the login stays valid for the next call. This timeout has not been measured.

**One window per failure, per process.** After a window without a login, no other one opens: every search immediately returns a miss, so that a loop does not make windows pop up. Retrying requires restarting the MCP server, with `/mcp` in Claude Code. A new window only becomes possible again after a successful Jira read, for the next failure.

**Rejected session.** A 401 or a redirect drops the session once per call, redoes the check and reads again. A second refusal gives a miss. A 404 or a 403 on a ticket is ambiguous, because a call handled anonymously answers the same way: the server then queries `/rest/api/2/myself` once per call, with the same cookies and no window. If Jira names someone, the 404 is a real unknown ticket and the 403 is a permission denied on that ticket, reported separately, the session being kept. Otherwise it is a rejected session, and the ticket stays unchecked.

**The profile lives in `~/.proofbench/chrome-profile`. It holds a live session: it must stay private.** Anyone who reads it can act on Jira as the user, not only read. It must not be copied, shared, or put in any repository or shared backup. On Windows, the folder gets no particular permission: it inherits those of the home folder, and it is up to the user to keep it private. A `bisect_auto` command runs as the same system user and can read it: the server removes secret variables from its environment, but cannot close that folder to it. Hence the rule already given: the user reads what it runs. With no session to keep, delete that folder.

**Cookies.** They only live in the memory of that process, and are masked like tokens. Only those whose domain matches the host of `JIRA_BASE_URL` are sent, to that host, over HTTPS, following no redirect. A cookie set on a parent domain (`.my-company.com`) matches, as in a browser. The others are discarded on reading. Values shorter than 8 characters are not masked: `true` would erase unrelated text.

**Not tried on a real Jira.** The flow has only run with a simulated Playwright. A session cookie with no expiry date may not survive closing the browser: you would then have to log in again for every server.

## Configuration

In `~/.proofbench/config.json`, per repository path. **Never in the repository**: a file of the analysed repository is not trusted, and it could choose where tokens go.

```json
{
  "repos": {
    "D:/Projects/my-app": {
      "forge": "gitlab",
      "gitlabHost": "gitlab.my-company.com",
      "jiraProjects": ["PROJ", "APP"],
      "retracePath": "C:/Tools/retrace.exe"
    }
  }
}
```

All fields are optional. `retracePath` must be a native executable: a `.bat` does not run without a shell. `forge` forces the platform when detection is not enough, and `resolve_repo` has no other way to force it. `gitlabHost` is a host without port or scheme, the only one that receives the token; without it, `gitlab.com`. With a port, it no longer matches the remote's host and platform detection fails. `jiraProjects` filters ticket keys and enables their lookup.

## Tools

| Tool | Role | Permission |
|---|---|---|
| `resolve_repo` | Opens the investigation, detects the platform | read |
| `locate_version` | Links a bugreport to a tag | read |
| `open_snapshot` | Creates an isolated copy | writes outside the repository |
| `locate_code` | Finds the code from a trace or logs | read |
| `trace_origin` | Candidates for a line range | read |
| `classify_change` | Before and after of a commit | read |
| `record_classification` | Records a judgement | write |
| `bisect_start` | Starts an assisted bisect: scenario and reuse are mandatory | **sensitive** |
| `bisect_answer` | The user's answer | **sensitive** |
| `bisect_confirm` | Writes the culprit of a bisect with reused answers | **sensitive** |
| `bisect_abort` | Abandons a bisect | **sensitive** |
| `bisect_auto` | Bisect driven by a command | **sensitive** |
| `record_attestation` | The user's word | **sensitive** |
| `link_change` | Merge requests and tickets of a commit | read, network |
| `fetch_refs` | `git fetch --all --tags` | **sensitive** |
| `check_fix` | Fix status per target | read, network |
| `submit_verdict` | Checks and writes the report | **sensitive** |
| `record_feedback` | The user's feedback on the report | write |

`readOnlyHint` means here that neither the repository nor anything external changes: the investigation, for its part, always records its evidence. Except `resolve_repo`, every tool requires an `investigationId`. Every result, errors included, carries `untrusted: true` at the root of its JSON and in `_meta`: the content is data. An error has the form `{"untrusted": true, "error": "..."}`. Only the SDK's schema errors remain plain text: they only quote field names.

## Known limits

- **An attestation is the user's word.** The server records it and relies on the assistant's approval prompt on each call, but it does not verify that the test took place. A permanent approval would remove that barrier.
- **A repeated bisect reuses answers already attested, without retesting.** `bisect_start` and `bisect_answer` apply on their own a `good` or `bad` attestation from the same repository and the same scenario (identical text, ignoring case and spaces), without creating a new word from the user. The user must have answered "no" to intermittence, and the answer must be later than that last "no". Asked again: a commit never answered or only skipped, a commit skipped after its answer, a commit both good and bad, any answer without a recorded repository and scenario, hence those of an older investigation. As soon as an answer has been reused, no culprit is written on its own: the result gives `pendingCulprit`, and `bisect_confirm` writes the culprit after the user has reviewed the list. The cause score then caps at 80 and the report carries its reservations. `reuseAnswers: false` starts over.
- **The scenario is a declaration, not a proof.** Nothing verifies that a test really reproduced the bug: the same text on a failed reproduction is reused. Hence `bisect_confirm`, the cap, and the "all tested commits good" reservation.
- **`bisect_abort` removes the answers of that bisect** (`keepAnswers: true` keeps them). Removing a single answer from a bisect, or an answer from a finished bisect, does not exist: it would stay reused until a different scenario or `reuseAnswers: false`.
- **Investigations are neither signed nor protected.** `~/.proofbench/investigations/*.json` is an ordinary file: an agent that can write there, through its file or shell tools, can forge a proof that `submit_verdict` will accept. The approvals requested on sensitive tools do not cover that path. Allow no write into `~/.proofbench`, and distrust any mode that skips approvals.
- **Build daemons and external caches are not cleaned** between two commits of a bisect: Gradle, `~/.gradle`, `npm` caches. A result may depend on them.
- **Windows does not tell a kill from an `exit 1`.** A process killed from outside exits there with code 1, like a real failure. The confirmation runs of `bisect_auto` limit that risk without removing it.
- `gradlew.bat`, and any `.bat` or `.cmd` file, does not run in automatic mode on Windows: the bisect stays assisted.
- The per-investigation queue only holds within one process. Two servers on the same investigation may lose evidence.
- A long `bisect_auto` may exceed the MCP client's call timeout. This timeout has not been measured.
- **Windows limits paths to 260 characters.** A copy lives under `~/.proofbench/worktrees`, and a deep Android project may exceed the limit: `open_snapshot` or the build then fail. `git config core.longpaths true` in the analysed repository fixes git's side, which also applies to its copies. Gradle and other tools remain subject to their own limit.
- The path check verifies that a copy is inside the copies folder, not that it belongs to this investigation: a tampered investigation file can still point to another one's copy.
- GitLab and Jira Cloud only, plus Jira through the browser, not tried on a real Jira. Other platforms fall back to local git.
