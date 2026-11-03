# skills

Eight skills in the open Agent Skills format (`SKILL.md`). The `using-proofbench` router picks the right one from the user's sentence.

| Skill | Role | MCP server required |
|---|---|---|
| [`using-proofbench/`](using-proofbench/SKILL.md) | Router: load before any development request. | none |
| [`regression-trace/`](regression-trace/SKILL.md) | Bug analysis and regression tracing. | [`regression-tracer`](../mcp/regression-tracer/README.md) |
| [`fix-bug/`](fix-bug/SKILL.md) | Proven fix, on a branch. | [`workflow-gate`](../mcp/workflow-gate/README.md) |
| [`build-feature/`](build-feature/SKILL.md) | New feature, from requirements to proofs. | [`workflow-gate`](../mcp/workflow-gate/README.md) |
| [`clean-up/`](clean-up/SKILL.md) | Cleanup without changing behaviour. | [`workflow-gate`](../mcp/workflow-gate/README.md) |
| [`security-audit/`](security-audit/SKILL.md) | Security check of an application. | [`workflow-gate`](../mcp/workflow-gate/README.md) |
| [`analyze-apk/`](analyze-apk/SKILL.md) | Android APK static analysis. | [`apk-inspector`](../mcp/apk-inspector/README.md) |
| [`read-ticket/`](read-ticket/SKILL.md) | Reading a Jira, GitHub, GitLab or Linear ticket. | [`ticket-reader`](../mcp/ticket-reader/README.md) |

Installation: see the [main README](../README.md).
