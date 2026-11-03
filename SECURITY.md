# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository.

Include what you found, how to reproduce it, and which component is affected (a skill, `regression-tracer`, `workflow-gate` or the installer `scripts/setup.mjs`).

## Scope

Of particular interest: prompt injection paths (text from logs, tickets, APKs or commits that makes an agent act), command execution outside the approved commands, writes outside the repository and `~/.proofbench`, leaks of tokens or cookies, and installer changes that damage a user configuration.

## Known limits

The files under `~/.proofbench` are plain files and are not signed: see "Known limits" in `mcp/regression-tracer/README.md` and `mcp/workflow-gate/README.md`.
