# Security Policy

Narthynx is an early-stage local-first agent runtime. Security defaults are part of the product, not an optional add-on.

## Current Phase

Phase 11 is implemented. Narthynx can create durable local missions, append ledgers, run typed MVP tools, require approvals for local writes and shell actions, create checkpoints, generate reports, rewind filesystem-write checkpoints, replay mission ledgers, operate through an interactive slash-command shell, and read Git diff/log state.

It does not execute arbitrary raw shell strings, read credentials, call networks, or send external communications in the current MVP phases. Local command execution is limited to typed approval-gated `shell.run` with `shell: false`, blocked destructive patterns, blocked shell metacharacters, and workspace-bounded working directories.

## Security Principles

- No irreversible action without explicit approval.
- No credential access by default.
- No shell execution in auto mode.
- No network by default in the MVP.
- Every tool call must be logged.
- Every high-risk local write must require approval and checkpointing.

## Reporting Issues

Please report suspected vulnerabilities privately to the maintainers. Do not include live credentials, private keys, or sensitive production data in reports.
