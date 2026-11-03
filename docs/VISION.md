# Vision

## Promise (one sentence)
An AI coding agent that, from an ordinary sentence ("analyze this bug", "clean up", "secure it", "analyze this APK", "look at this ticket"), loads the right method on its own and runs it with proof it cannot fabricate.

## Target
Developers who work with an AI coding agent (Claude Code, GitHub Copilot, Codex, Cursor, Gemini CLI). First ground: Android development, hence the manifest, APK and Gradle support. No other profile is targeted until this one is served.

## The three daily tasks to ease first
1. Analyze a bug and find the culprit commit (`regression-trace`).
2. Fix and build with proof: a test that fails then passes, lint, build (`fix-bug`, `build-feature`, `clean-up`).
3. Understand what you are handed: a ticket (`read-ticket`) or an APK (`analyze-apk`).

## Differentiator
The score does not come from the agent. The MCP servers run the commands, keep the evidence and compute the grade. Skills trigger on their own: the user never names them.

## Decision: no graphical interface
Proofbench has no UI. The deliverable is installation on any assistant, with skills that trigger automatically. The interfaces are those of the assistants.

## Known risks
- The "skills + MCP" category is saturated: the reason to choose Proofbench is proof (a score computed outside the agent) and automatic routing, not the number of skills.
- Triggering a skill remains a model decision. The router and the always-on block make it reliable, not guaranteed: measure it on real sentences, assistant by assistant.
- A target that is too broad means breadth without depth: add a skill only if it has an MCP server or a method that no other repository provides.
