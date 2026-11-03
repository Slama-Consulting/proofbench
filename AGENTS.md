# Proofbench

For any development request (bug analysis, regression, fix, new feature, cleanup, security, APK, ticket), first read `skills/using-proofbench/SKILL.md` and follow it. It names the skill to load from `skills/<name>/SKILL.md`.

The MCP servers are in `bundle/` (single files, no build required). Their TypeScript sources are in `mcp/`. `npm test` runs the tests, rebuilds the bundles and checks that they start.
