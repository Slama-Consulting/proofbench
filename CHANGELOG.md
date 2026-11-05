# Changelog

## 0.4.0 - 2026-11-05

- `ticket-reader`: Jira is now read with a browser login (a Chromium window where you log in yourself, SSO and MFA included), on REST v2, like `regression-tracer`. The token modes are removed: `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_PAT` are no longer read, and `JIRA_BASE_URL` alone configures Jira. New optional `JIRA_LOGIN_TIMEOUT_S`; `playwright` is an optional dependency.
- `regression-tracer`: the Jira API token path is removed; Jira lookups always use the browser login.

## 0.3.1 - 2026-11-04

- `apk-inspector`: `apk_calls` returns `callConstants`, the integers and strings certainly held by the arguments of each call (for example `PendingIntent` flags, the permission given to `registerReceiver`, `Intent` actions), and `apk_xrefs` shows them in its hits (`[arg3=0x4000000]`). The tracker is conservative: it forgets a value at every write, branch, switch case and exception handler, and gives up on a method it cannot follow.
- `apk-inspector`: `apk_entrypoint_checks` reports `readPermission` and `writePermission` of each component, not only `permission`.
- Docs: new guide `docs/apk-analysis.md`, and README, `mcp/` and `skills/` indexes updated for the new tools.
- `analyze-apk` and the router now list the code-level questions (release build, caller checks, who calls a method) among their trigger phrases.

## 0.3.0 - 2026-11-04

- `apk-inspector`: a built-in Dalvik bytecode reader (no external tool) and four tools on top of it: `apk_methods`, `apk_calls`, `apk_xrefs` and `apk_entrypoint_checks` (caller-validation APIs reachable from the entry points of exported components, reported as observed facts and unknowns).
- `apk-inspector`: optional `apk_decompile` tool, off unless `APK_INSPECTOR_JADX` is set, that reads one class as Java through a locally installed jadx in a private temporary directory.
- `apk-inspector`: `apk_strings` takes `ignoreCase`, and a refused regex now says why (inline flags such as `(?i)` are not supported).
- `apk-inspector`: new `apk_xml` tool decodes any binary XML entry and summarises backup and data-extraction rules.
- `apk-inspector`: new `apk_asset_peek` tool shows the first bytes of an entry (kind, text or hex preview, secrets masked).
- `apk-inspector`: `apk_overview` returns a `releaseReadiness` block (blockers and reviews) so a debug or test build is recognised at once.
- Two tests that only make sense on Windows (or on a case-insensitive filesystem) no longer run elsewhere.

## 0.2.0

- Seven skills with an automatic router (`using-proofbench`): `regression-trace`, `fix-bug`, `build-feature`, `clean-up`, `security-audit`, `analyze-apk`, `read-ticket`.
- Pre-built single-file MCP servers in `bundle/`: no build step to install.
- `scripts/setup.mjs`: installer for Claude Code, GitHub Copilot, Codex, Cursor and Gemini CLI, idempotent and reversible.
- Claude Code plugin and marketplace manifest, `SessionStart` hook, Gemini CLI extension.
- Everything translated to English; workflow, step and verdict identifiers are now English.
- MIT license.

## 0.1.0

- First versions of the `regression-tracer` and `workflow-gate` MCP servers and their skills.
