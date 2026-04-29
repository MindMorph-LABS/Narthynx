# Security Policy

Narthynx is an early-stage local-first agent runtime. Security defaults are part of the product, not an optional add-on.

## Current Phase

Phase 0 contains only CLI bootstrap behavior. It does not execute shell commands, read credentials, write mission files, call networks, or run external communications.

## Security Principles

- No irreversible action without explicit approval.
- No credential access by default.
- No shell execution in auto mode.
- No network by default in the MVP.
- Every future tool call must be logged.
- Every future high-risk action must require approval and checkpointing.

## Reporting Issues

Please report suspected vulnerabilities privately to the maintainers. Do not include live credentials, private keys, or sensitive production data in reports.
