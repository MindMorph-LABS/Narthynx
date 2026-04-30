# Security Policy

Narthynx is an early-stage local-first agent runtime. Security defaults are part of the product, not an optional add-on.

## Current Phase

Phase 10 is implemented. Narthynx can create durable local missions, append ledgers, run typed MVP tools, require approvals for local writes, create checkpoints, generate reports, rewind filesystem-write checkpoints, replay mission ledgers, and operate through an interactive slash-command shell.

It does not execute arbitrary shell commands, read credentials, call networks, or send external communications in the current MVP phases.

## Security Principles

- No irreversible action without explicit approval.
- No credential access by default.
- No shell execution in auto mode.
- No network by default in the MVP.
- Every tool call must be logged.
- Every high-risk local write must require approval and checkpointing.

## Reporting Issues

Please report suspected vulnerabilities privately to the maintainers. Do not include live credentials, private keys, or sensitive production data in reports.
