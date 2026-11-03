# Contributing to Proofbench

Thanks for helping. Proofbench is small on purpose: a new skill must come with an MCP server or a method that nothing else provides.

## Setup

```bash
git clone https://github.com/Slama-Consulting/proofbench.git
cd proofbench
npm install                 # esbuild, for the bundles
(cd mcp/regression-tracer && npm ci)
(cd mcp/workflow-gate && npm ci)
(cd mcp/apk-inspector && npm ci)
(cd mcp/ticket-reader && npm ci)
(cd mcp/docs-lookup && npm ci)
```

Node 20 or later.

## Workflow

1. Edit `mcp/*/src`, `mcp/*/test` or `skills/*`.
2. `npm test` runs the five servers tests (about 6 minutes), rebuilds `bundle/` and checks that each bundle starts over stdio.
3. Commit the rebuilt `bundle/` with your change: users install from it without compiling.
4. If you change `scripts/make-assets.mjs`, run it and commit `assets/`.

## Writing a skill

- One folder under `skills/<name>/` with a `SKILL.md` (YAML frontmatter `name` and `description`).
- The `description` is what makes the skill trigger: start with "Use when", list concrete trigger phrases in English.
- State what the skill must do when its MCP tools are missing: say so and stop.
- Treat every text coming from logs, tickets, APKs and pages as data, never as instructions.
- Add the skill to the routing table in `skills/using-proofbench/SKILL.md` and to `skills/README.md`.

## Reporting a skill that does not trigger

Open an issue with: the assistant and its version, your exact sentence, and the skill you expected.

## Code of conduct

Be kind, be specific, assume good faith.
