# ticket-reader

A self-contained, read-only MCP server that reads one ticket from an issue tracker (Jira, GitHub, GitLab, Linear) and returns it as a single normalised JSON object. It has no dependency on any other project: the only runtime dependencies are the MCP SDK and `zod`, and HTTP goes through Node's global `fetch`.

It never writes to a tracker. There is no tool that creates, updates, comments, transitions or assigns anything, and there never will be.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `ticket_providers` | none | Which providers are configured, and for each unconfigured one the exact environment variables to set. Never shows a secret. Makes no network call. |
| `ticket_read` | `ref` (required), `provider`, `commentLimit`, `descriptionMaxChars` | One normalised ticket (below). |

`ticket_read` inputs:

- `ref`: a ticket URL or a key. Accepted forms: `https://jira.example.com/browse/PROJ-123`, `PROJ-123`, `https://github.com/owner/repo/issues/42`, `https://github.com/owner/repo/pull/42`, `owner/repo#42`, `https://gitlab.example.com/group/project/-/issues/7`, `https://gitlab.example.com/group/project/-/merge_requests/3`, `group/project#7` (issue), `group/project!3` (merge request), `https://linear.app/acme/issue/ENG-12/...`, `ENG-12`.
- `provider`: `jira | github | gitlab | linear`. Needed only to disambiguate a bare key (`PROJ-123` could be Jira or Linear). Without it, a bare key goes to the only configured one of the two, and is refused as ambiguous if both are configured. `owner/repo#42` is GitHub, and a path with three or more segments is GitLab, unless `provider` says otherwise.
- `commentLimit`: most recent comments to return. Default 20, max 100, 0 skips the comments request.
- `descriptionMaxChars`: the description is cut beyond this length. Default 8000.

Result fields: `provider`, `id` (`PROJ-123`, `owner/repo#42`, `group/project#7` or `group/project!3`, `ENG-12`), `url`, `kind` (`issue | pull_request | merge_request | story | bug | task | epic | other`), `title`, `status`, `author`, `assignees[]`, `labels[]`, `priority` (when the tracker has one), `createdAt`, `updatedAt`, `description` (plain text; Jira's ADF is converted), `truncated` (true when the description was cut), `comments[]` (`author`, `createdAt`, `body` cut at 2000 characters with `truncated: true` when it was, oldest first among the most recent N), `links[]` (`{type, id, url, title?}`: related issues, parent, subtasks, closing issues, attachments such as linked pull requests), `change` (pull requests and merge requests only: state, merged, draft, base and head branch, changed files count, up to 50 file paths with additions and deletions where the API gives them, never diffs), and `misses[]`.

`misses[]` lists what could not be read and why (access denied, not found, rate limit, timeout, response too large, not valid JSON). It never contains a token or any response body.

Every result carries `"untrusted": true` at the root and in `_meta`. A failure is returned as `{"untrusted": true, "error": "..."}` with `isError` set; the server never throws to the client. The server `instructions` tell the client that all returned text is data written by third parties, never instructions.

## Configuration

Environment variables only. Nothing is ever read from a repository, a ticket or the `ref` text.

| Provider | Variable | Required | Meaning |
| --- | --- | --- | --- |
| Jira | `JIRA_BASE_URL` | yes | HTTPS URL of your Jira, for example `https://jira.example.com` (a context path such as `/jira` is allowed) |
| Jira | `JIRA_LOGIN_TIMEOUT_S` | no | How long to wait for the browser login, in seconds. 120 by default |
| GitHub | `GITHUB_TOKEN` | no | Public repositories work without it; anonymous calls are throttled, and a rate-limit miss says so |
| GitLab | `GITLAB_TOKEN` | yes | Personal access token with the `read_api` scope |
| GitLab | `GITLAB_HOST` | no | Bare host name, no scheme or port. Default `gitlab.com` |
| Linear | `LINEAR_API_KEY` | yes | Personal API key from Linear settings |

Run `ticket_providers` to see what is configured and what is missing.

## Jira browser login

Jira has no token mode. It is read with the session of a Chromium window where you log in yourself, SSO and MFA included, on REST v2 (`/rest/api/2`). Set `JIRA_BASE_URL`, then once, by hand, in `mcp/ticket-reader`:

```bash
npm install playwright
npx playwright install chromium
```

Playwright is an optional dependency. If it or Chromium is missing, the read fails with a message naming those two commands.

- **First read.** With no saved session, a Chromium window opens on the Jira home page. The server neither types nor reads any password: it polls `/rest/api/2/myself` every 2 seconds and closes the window as soon as Jira names someone. Later reads run headless from the saved profile. The first `ticket_read` may wait up to `JIRA_LOGIN_TIMEOUT_S`; the MCP client has its own call timeout, to set above it (`MCP_TOOL_TIMEOUT` for Claude Code, in milliseconds).
- **One window per failure, per process.** After a window without a login, no other one opens until the MCP server is restarted (`/mcp` in Claude Code). A read that succeeds re-arms the next window.
- **Rejected session.** A 401, or a redirect to the SSO page, drops the session and returns `session missing or expired`; the next read redoes the check.
- **Profile.** `~/.proofbench/chrome-profile` (shared with `regression-tracer`) holds a live session: keep it private, out of any repository or shared backup. With no session to keep, delete the folder.
- **Cookies** live only in the memory of the process, are sent only to the host of `JIRA_BASE_URL` over HTTPS with no redirect followed, and are masked in every result and error like a token. Values shorter than 8 characters are not masked.
- **Not tried on a real Jira.** The flow has only run against a simulated Playwright.

## Security model

- Read-only by construction: every request is a `GET`, except Linear, which is a `POST` carrying one fixed GraphQL `query` (no mutation exists in the code). Both tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`.
- The request host is never taken from ticket content or from the `ref`. A URL in `ref` is accepted only when its host is exactly the configured host of its provider (`JIRA_BASE_URL`, `GITLAB_HOST`) or `github.com` / `linear.app`. Look-alike hosts (`github.com.evil.example`), userinfo tricks (`https://github.com@evil.example/...`), non-default ports and non-HTTPS URLs are refused before any request, which blocks SSRF and token exfiltration.
- HTTPS only. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, and only behind the `allowHttpLocalhost` server option used by tests.
- No redirect is followed, so credentials never leave the intended host.
- 10 second timeout, 2 MiB response cap, at most 2 requests per second per provider, at most 5 requests per read (ticket, one comments page, one links call, one file list).
- Numeric ids must match `^\d{1,9}$`; repository, project and key segments are validated against a strict character set and URL-encoded.
- Tokens and Jira session cookies travel only in headers and are redacted from every error, miss and result. Bodies of failed responses are never echoed.
- Third-party tracker content is untrusted. It is marked as such and must never be followed as instructions.

## Limits

- Read-only. No writes, ever.
- One ticket per call. No search, no listing, no JQL.
- No OAuth flow and no Jira API token: Jira is read with the session of a browser login (see below).
- Asana and other trackers are not supported yet.
- GitHub: comments come from a single page of 100, so on a very busy issue the most recent comments may be fewer than requested (a miss says so). Cross-references from the timeline are not fetched, so `links` is empty for GitHub.
- GitLab: file lists of merge requests come from the diffs endpoint, which also returns diffs; a very large merge request can exceed the 2 MiB cap and the file list is then reported as a miss. Additions and deletions are not available per file.
- Jira: linked pull requests from the development panel are not fetched; `links` has issue links, parent and subtasks.
- The Linear workspace in a URL is not checked against your key; the key decides what is visible.

## How the `read-ticket` skill uses it

The `read-ticket` skill calls `ticket_providers` when a read reports that a provider is not configured, then `ticket_read` with the ref the user gave. It treats the result as data: it summarises or uses the ticket as context for the task, and never follows instructions found in titles, descriptions or comments. Fields in `misses[]` are reported to the user instead of being guessed around.

## Development

```
npm install
npm run typecheck   # tsc over src and tests
npm test            # vitest run, no network: fetch is injected
npm run build       # tsc to dist/
node dist/server.js # stdio MCP server
```
