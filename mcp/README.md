# mcp

Five self-contained MCP servers, written in TypeScript, shipped pre-built as single files in [`../bundle/`](../bundle/).

- [`regression-tracer/`](regression-tracer/README.md): investigates a regression, from the bugreport to a proven verdict. Serves the `regression-trace` skill.
- [`workflow-gate/`](workflow-gate/README.md): controls workflows, with a score computed from evidence. Serves the `security-audit`, `clean-up`, `build-feature` and `fix-bug` skills.
- [`apk-inspector/`](apk-inspector/README.md): static, read-only Android APK analysis: manifest, signing, release-readiness, binary XML, assets, strings, and a built-in Dalvik bytecode reader (methods, calls, cross-references, caller checks on exported entry points). 14 tools, plus an optional jadx bridge. Serves the `analyze-apk` skill. Guide: [`../docs/apk-analysis.md`](../docs/apk-analysis.md).
- [`ticket-reader/`](ticket-reader/README.md): reads Jira, GitHub, GitLab and Linear tickets. Serves the `read-ticket` skill.
- [`docs-lookup/`](docs-lookup/README.md): finds the libraries a project uses and fetches their documentation for the exact version. Serves the "docs first" rule of every skill.

None depends on another project. The TypeScript sources and tests live here.
