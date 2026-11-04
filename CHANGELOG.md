# Changelog

## Unreleased

- `apk-inspector`: a built-in Dalvik bytecode reader (no external tool) and four tools on top of it: `apk_methods`, `apk_calls`, `apk_xrefs` and `apk_entrypoint_checks` (caller-validation APIs reachable from the entry points of exported components, reported as observed facts and unknowns).
- `apk-inspector`: optional `apk_decompile` tool, off unless `APK_INSPECTOR_JADX` is set, that reads one class as Java through a locally installed jadx in a private temporary directory.
- `apk-inspector`: `apk_strings` takes `ignoreCase`, and a refused regex now says why (inline flags such as `(?i)` are not supported).
- `apk-inspector`: new `apk_xml` tool decodes any binary XML entry and summarises backup and data-extraction rules.
- `apk-inspector`: new `apk_asset_peek` tool shows the first bytes of an entry (kind, text or hex preview, secrets masked).
- `apk-inspector`: `apk_overview` returns a `releaseReadiness` block (blockers and reviews) so a debug or test build is recognised at once.

## 0.2.0

- Seven skills with an automatic router (`using-proofbench`): `regression-trace`, `fix-bug`, `build-feature`, `clean-up`, `security-audit`, `analyze-apk`, `read-ticket`.
- Pre-built single-file MCP servers in `bundle/`: no build step to install.
- `scripts/setup.mjs`: installer for Claude Code, GitHub Copilot, Codex, Cursor and Gemini CLI, idempotent and reversible.
- Claude Code plugin and marketplace manifest, `SessionStart` hook, Gemini CLI extension.
- Everything translated to English; workflow, step and verdict identifiers are now English.
- MIT license.

## 0.1.0

- First versions of the `regression-tracer` and `workflow-gate` MCP servers and their skills.
