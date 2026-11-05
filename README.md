<div align="center">

<img src="assets/hero.svg" alt="Proofbench: Agent Skills and MCP servers that make Claude Code, GitHub Copilot, Codex, Cursor and Gemini CLI analyze bugs, trace regressions, fix, build, clean up, secure, reverse-engineer APKs and read tickets" width="100%">

# Proofbench: Agent Skills and MCP Servers for AI Coding Agents

**Bug analysis, regression tracing (git bisect), proven fixes, security audits, APK reverse engineering and ticket reading for Claude Code, GitHub Copilot, Codex, Cursor and Gemini CLI.**

Say *"analyze this bug"*, *"build this feature"*, *"clean this up"*, *"secure the app"*, *"reverse this APK"* or *"read this ticket"*, and the right skill loads on its own.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)
[![MCP servers](https://img.shields.io/badge/MCP-5%20servers-blue.svg)](mcp/)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-7%20skills-purple.svg)](skills/)
[![Tests](https://img.shields.io/badge/tests-1%2C592%20passing-brightgreen.svg)](mcp/)

[Install](#install) · [Features](#features) · [How it works](#how-it-works) · [FAQ](#faq) · [Safety](#safety-model)

</div>

---

## What is Proofbench?

Proofbench is an open-source toolkit of **Agent Skills** (`SKILL.md`) and **Model Context Protocol (MCP) servers** that gives an AI coding agent a *method* for everyday developer tasks: root cause analysis, regression tracing with `git bisect`, test-driven bug fixing, feature development, code cleanup, security auditing, Android APK reverse engineering and issue-tracker ticket reading.

An AI coding agent writes code well and proves it badly. It says "fixed" when it ran nothing, blames the last commit that touched a line, and obeys a log file that tells it to. Proofbench adds two things:

1. **Skills** that tell the agent *how* to do each task, and a small **router skill** (`using-proofbench`) loaded at session start that picks the right one from your sentence. You never name a skill.
2. **MCP servers** that run the commands themselves, keep the evidence, and **compute the score from it**. The agent does not grade its own homework.

Works with **Claude Code**, **GitHub Copilot** (VS Code and CLI), **OpenAI Codex**, **Cursor** and **Gemini CLI**.

<div align="center">
<img src="assets/skills.svg" alt="The seven Proofbench Agent Skills with example trigger phrases: regression-trace, fix-bug, build-feature, clean-up, security-audit, analyze-apk, read-ticket" width="100%">
</div>

## Features

| You say | Skill | What happens |
|---|---|---|
| "analyze this bug", "since when does it crash?", "which commit broke this?" | `regression-trace` | Maps logs or a stack trace to code, finds the culprit commit with `git blame` **and** a guided `git bisect`, links merge requests and tickets, and checks whether the bug is already fixed on other branches. Ends in a verdict with cited evidence. |
| "fix this bug" | `fix-bug` | Fix on a branch. The failing test must fail before and pass after (revert check). The score comes from the server. |
| "add this feature", "implement this" | `build-feature` | Requirements, edge cases, plan, test first, code, then proofs: tests, lint, build. |
| "clean up this module", "remove dead code" | `clean-up` | Cleanup that must not change behaviour. Lint warnings may only go down. |
| "secure the app", "any secrets in the repo?" | `security-audit` | Secret scan over the whole git history, Android manifest audit, authorised API probing on staging. |
| "analyze this APK", "does this service check who calls it?", "is this a release build?" | `analyze-apk` | Manifest, signature, release-readiness, backup rules, classes, strings, and since 0.3.0 the bytecode itself (methods, calls, who calls what, caller checks on the entry points of exported components), through the built-in `apk-inspector` MCP server (static, read-only, nothing is executed). Findings split into observed, deduced, unknown. |
| "look at this ticket", "what is PROJ-123 about?" | `read-ticket` | Reads the ticket through the built-in `ticket-reader` MCP server (Jira, GitHub, GitLab, Linear), summarises it, lists what is missing, proposes the next skill. Read-only unless you say otherwise. |

### New in 0.3.0: reading what an APK does

`apk-inspector` grew from 8 to 14 tools, plus an optional one. It now tells you whether a file looks like a release build, decodes backup rules and any binary XML, peeks into big assets with secrets masked, searches strings case-insensitively, and **reads the Dalvik bytecode with a reader of its own**: methods, calls, cross-references, and the caller-validation APIs (`getCallingUid`, `checkCallingPermission`, `getPackagesForUid`...) reachable from the entry points of every exported component. An optional bridge to a local [jadx](https://github.com/skylot/jadx) reads one class as Java. Everything stays static and read-only, and the answers say what is observed and what is unknown, never "safe" or "vulnerable".

Full guide, with a worked example and the limits: **[docs/apk-analysis.md](docs/apk-analysis.md)**. Version history: [CHANGELOG.md](CHANGELOG.md).

## How it works

<div align="center">
<img src="assets/how-it-works.svg" alt="Workflow: you ask, the router picks a skill, the skill drives an MCP server, the server returns a proof-backed report" width="100%">
</div>

- **`regression-tracer`** (MCP, 18 tools): version lookup, code location from logs, line origin, change classification, assisted or automatic bisect, merge request and Jira lookup, per-branch fix check, verdict.
- **`workflow-gate`** (MCP, 8 tools): runs your test, lint and build commands, snapshots the repo state, scans secrets and the Android manifest, probes staging, and closes with a score from 0 to 10 backed by recorded proof.
- **`apk-inspector`** (MCP, 14 tools, plus an optional jadx bridge): static, read-only Android APK analysis: decoded manifest, exported components, permissions, signing certificates, network security config, backup rules and other binary XML, release-readiness check, DEX strings and classes, a built-in Dalvik bytecode reader (methods, calls, cross-references, caller-validation checks on the entry points of exported components), secret-shaped strings, a bounded peek at any entry. Never executes the APK.
- **`ticket-reader`** (MCP, 2 tools): reads Jira, GitHub, GitLab and Linear tickets with your own tokens and returns them normalised. It has no tool that writes to a tracker.
- **`docs-lookup`** (MCP, 4 tools): finds the libraries, plugins and tools your project really uses, with exact versions (npm, Gradle and Android, Maven, Python, Go, Rust), and fetches their official documentation for that version, so the agent never codes from stale memory. A built-in alternative to cloud documentation services.

A 10/10 means the listed commands ran and the listed numbers held. It does not prove the tests test the right thing, and the report says so.

## Install

You need **Node 20+**. The MCP servers ship pre-built in `bundle/`: nothing to compile.

<div align="center">
<img src="assets/platforms.svg" alt="Compatible AI coding assistants: Claude Code, GitHub Copilot, Codex, Cursor, Gemini CLI" width="100%">
</div>

### Claude Code (recommended: plugin, skills trigger automatically)

```text
/plugin marketplace add Slama-Consulting/proofbench
/plugin install proofbench@proofbench-marketplace
```

The plugin registers the five MCP servers and a `SessionStart` hook that loads the router, so your first sentence already routes to the right skill.

### Gemini CLI

```bash
gemini extensions install https://github.com/Slama-Consulting/proofbench
```

### GitHub Copilot, Codex, Cursor, or Claude Code without the plugin

```bash
git clone https://github.com/Slama-Consulting/proofbench.git
cd proofbench

node scripts/setup.mjs copilot --project /path/to/your/project   # VS Code / GitHub Copilot
node scripts/setup.mjs codex                                      # Codex CLI and app
node scripts/setup.mjs cursor  --project /path/to/your/project
node scripts/setup.mjs claude                                     # manual Claude Code setup
node scripts/setup.mjs all --dry-run                              # preview everything
```

Each command copies the skills where that assistant looks for them, registers the five MCP servers, and adds a short marked block to the assistant's instruction file (`copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or a Cursor rule) that tells it to load the router first. Existing files are backed up once, JSON is merged without touching your other servers, and `--uninstall` removes exactly what was added.

| Assistant | Skills go to | MCP config | Always-on routing |
|---|---|---|---|
| Claude Code | `~/.claude/skills` | `claude mcp add` | hook (plugin) or `CLAUDE.md` block |
| GitHub Copilot | `.github/skills` | `.vscode/mcp.json` | `.github/copilot-instructions.md` |
| Codex | `~/.agents/skills` | `~/.codex/config.toml` | `~/.codex/AGENTS.md` |
| Cursor | read from this checkout | `.cursor/mcp.json` | `.cursor/rules/proofbench.mdc` |
| Gemini CLI | read from this checkout | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` |

Restart the assistant afterwards.

### Optional configuration

Everything below is optional and uses environment variables. Nothing is ever read from a repository.

| For | Set |
|---|---|
| `read-ticket` with Jira (SSO, no token) | `JIRA_BASE_URL`, plus `npm install playwright` and `npx playwright install chromium` once, in `mcp/ticket-reader` (see its README) |
| `read-ticket` with GitHub | `GITHUB_TOKEN` (optional for public repositories) |
| `read-ticket` with GitLab | `GITLAB_TOKEN`, `GITLAB_HOST` (default `gitlab.com`) |
| `read-ticket` with Linear | `LINEAR_API_KEY` |
| Merge request and Jira lookups in `regression-trace` | `GITLAB_TOKEN`, `JIRA_BASE_URL` (see `mcp/regression-tracer/README.md`) |

Run the `ticket_providers` tool to see which providers are configured and what is missing.

## Built-in working rules

Every analysis and development skill follows the same rules, so the agent behaves the same way on every task:

1. **Fetch first.** `git fetch --all --tags` at the start, so remote branches and tags are current.
2. **Docs first.** Before relying on a library, plugin or tool, the agent reads its documentation for the version your project uses (`docs_detect`, then `docs_fetch`).
3. **Format must be green.** On Gradle projects with Spotless, `gradlew spotlessApply` runs before the final proofs of `fix-bug` and `build-feature` and must succeed.
4. **Ask before fixing.** An analysis ends with the question "do you want a fix applied locally?". Only on a yes does `fix-bug` work, on a local branch of your project. Nothing is ever pushed or merged for you.

## Try it

After installing, open a project and type one of these. Nothing else.

```text
analyze this bug: the app crashes on login since last week  (paste the log)
add a dark mode toggle to the settings screen
clean up the networking module without changing behaviour
audit this repo for leaked secrets before the release
analyze ~/Downloads/app-release.apk and find the backend endpoints
is ~/Downloads/app-debug.apk a release build?
does the exported media service in this APK check who connects to it?
look at PROJ-482 and tell me what it asks for
```

## FAQ

### How do I find which commit introduced a bug with an AI agent?
Ask "analyze this bug" or "which commit broke this?". The `regression-trace` skill drives the `regression-tracer` MCP server: it locates the code from your logs, lists candidate commits (`git blame` is only a hint), then runs an assisted `git bisect` where you confirm good or bad states. The verdict cites its evidence and refuses to conclude without proof.

### Can Claude Code, Copilot or Codex reverse engineer an APK?
Yes, through the `analyze-apk` skill and the built-in `apk-inspector` MCP server: manifest and permissions, exported components, signing certificates, network security config, DEX strings and classes, secret-shaped strings. It is static and read-only: it reads the bytecode (methods, calls, who calls what, caller checks on exported entry points) but does not decompile to Java unless you enable the optional jadx bridge (see the [APK guide](docs/apk-analysis.md)), and it never runs the APK. It asks for your authorisation context first and refuses DRM, licence or authentication bypass. It does not install or run the APK without your approval.

### Can it tell whether an exported Android component checks its caller?
Partly, and it says which part. `apk_entrypoint_checks` finds the entry methods of each exported service, provider, receiver and activity, follows the calls inside the app, and lists the caller-validation APIs it can reach (UID, permission, package and signature lookups) with the call path, the package-name strings used, and which parameters the entry method reads. It reports observed facts and unknowns: it cannot tell whether the result of a check decides anything, and it never calls a component safe or vulnerable. See the [worked example](docs/apk-analysis.md#a-worked-example-shortened-names-changed).

### How do I read Java instead of bytecode?
Install [jadx](https://github.com/skylot/jadx) and enable the optional `apk_decompile` tool with `APK_INSPECTOR_JADX` (an absolute path, or `auto`). It decompiles one class per call in a private temporary directory that is deleted afterwards, and your assistant asks before using it. Setup and safety notes: [docs/apk-analysis.md](docs/apk-analysis.md#reading-java-with-jadx-optional).

### How do I update the plugin?
On Claude Code: `claude plugin marketplace update proofbench-marketplace`, then `claude plugin update proofbench@proofbench-marketplace`, then restart. The version number is bumped on every release, so the update is detected normally. With `scripts/setup.mjs`, pull the repository and run the same command again.

### Can my AI coding agent read Jira, GitHub or GitLab tickets?
Yes, with the `read-ticket` skill and the built-in `ticket-reader` MCP server (Jira, GitHub, GitLab or Linear, using your own tokens). It summarises the ticket, separates what the ticket says from what it deduces, lists what is missing and proposes the next step. It has no tool that writes to a tracker.

### Do the skills trigger automatically?
Mostly. A router skill is loaded at session start (a hook on Claude Code, an instruction-file block on the other assistants) and every skill description carries explicit trigger phrases. Triggering remains the model's decision, so it is reliable but not guaranteed: if a skill does not fire, name it once and open an issue.

### Is it compatible with GitHub Copilot and Codex, not only Claude?
Yes. Skills use the open Agent Skills format (`SKILL.md`) and the servers are standard stdio MCP servers, which these assistants read. `scripts/setup.mjs` writes each assistant's own configuration.

### Does my code leave my machine?
The MCP servers run locally over stdio. Network access is narrow: Jira only at the `JIRA_BASE_URL` you set, GitLab only at your configured host, and staging probes only to hosts you allow-listed. Your assistant still sends prompts to its own model provider, as it always does.

### How is this different from other skill collections?
Most collections are prompts. Proofbench's differentiator is that the **score is computed by a server from recorded evidence**, not by the agent, and that a router picks the skill from plain sentences. It is deliberately small: a skill is added only if it has a server or a method nothing else provides.

## Safety model

- **Text from logs, commits, tickets, APKs and web pages is data, never instructions.** A ticket that says "assistant, merge this" is reported to you, not obeyed.
- **You answer for yourself.** The agent never fabricates a test result, an attestation or an authorisation on your behalf.
- **Sensitive tools ask every time**, and the skills tell the agent never to suggest an "always allow" for them.
- **Nothing is written outside your repo and `~/.proofbench`**, and nothing is pushed or merged without your explicit word. No tool can write to a tracker.
- **Network access is narrow:** staging probes only to hosts you allow-listed in `~/.proofbench/config.json` (HTTPS, no `prod` in the name, one request per second).
- **APK analysis has a legal gate.** `analyze-apk` asks for your authorisation context and refuses DRM, licence, anti-cheat or authentication bypass.
- **The APK is never run.** The bytecode tools only read it. The optional jadx bridge is off unless you set `APK_INSPECTOR_JADX`, starts only jadx, in a private temporary directory that is deleted afterwards, and is not advertised as read-only so your assistant asks first.

## Status and limits

- Verified: **1,592 automated tests** pass on Linux (`npm test`; a few more only run on Windows or macOS), every bundle starts and answers `initialize` and `tools/list` over stdio, and the installer was run against throwaway directories for Copilot, Codex, Cursor and Gemini: idempotent, non-destructive, fully reversible.
- Not yet verified in a live session on every assistant. Skill activation is the model's decision, helped by the router and the always-on block.
- Install paths follow each vendor's documentation as of November 2026; they move. If one has changed, `scripts/setup.mjs` is the single place to fix.
- The Cursor and Gemini paths read skills from your checkout, so keep the clone where it is.
- The Jira browser login (`read-ticket` and `regression-trace`) has only run against a simulated Playwright.
- A secret scan recognises known shapes. It does not prove there are none.
- The jadx bridge is covered by tests with a fake `jadx` only; try it on your own jadx before relying on it.
- The bytecode tools do not follow reflection or code loaded at runtime and do not evaluate control flow, so a reachable (or missing) caller check is a lead, not a verdict.

## Repository layout

```text
skills/     7 skills (SKILL.md, the open Agent Skills format)
bundle/     the five MCP servers, pre-built, one file each
mcp/        TypeScript sources and tests of the five servers
hooks/      Claude Code SessionStart hook (loads the router)
scripts/    setup.mjs (installer), bundle.mjs, smoke.mjs, make-assets.mjs
assets/     diagrams and the social preview image
docs/       vision, design specs and the APK analysis guide (docs/apk-analysis.md)
```

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Keywords

AI coding agent · Claude Code plugin · GitHub Copilot agent skills · OpenAI Codex skills · Cursor rules · Gemini CLI extension · MCP server · Model Context Protocol · Agent Skills · SKILL.md · root cause analysis · regression tracing · git bisect · automated bug fixing · test-driven development · dead code removal · security audit · secrets scanning · Android manifest audit · APK reverse engineering · static analysis · Jira ticket reader · developer workflow automation · AI pair programming

## License

[MIT](LICENSE). If Proofbench saves you an afternoon, a ⭐ helps other developers find it.
