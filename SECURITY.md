# Security Policy

Narthynx is an early-stage local-first agent runtime. Security defaults are part of the product, not an optional add-on.

## Current Phase

The Phase 0-14 MVP track is implemented. Narthynx can create durable local missions, append ledgers, persist plan graphs, run typed tools, require approvals for local writes and shell actions, create checkpoints, generate reports, replay mission histories, operate through an interactive slash-command shell, summarize model costs, and run the bounded Phase 13 executor flow.

Narthynx does not execute arbitrary raw shell strings, read credentials by default, call networks by default, send external communications, or perform model-selected autonomous tool execution in the current MVP.

## Security Principles

- No irreversible action without explicit approval.
- No credential access by default.
- No raw shell execution.
- No network by default.
- No external communication without approval.
- Every tool call must be logged.
- Every approval outcome must be recorded.
- High-risk local writes must require approval and checkpointing where supported.
- Secrets must not be written to mission files, ledgers, reports, replay output, examples, or tests.

## Current Safety Boundaries

- `shell.run` is typed, approval-gated, uses `shell: false`, blocks shell metacharacters and destructive patterns, and restricts `cwd` to the workspace root or descendants.
- `git.diff` and `git.log` are read-only connectors.
- Cloud model providers are opt-in through environment variables and require `allow_network: true`.
- Sensitive model context is blocked or refused unless policy explicitly allows it.
- The Phase 13 executor only runs the deterministic MVP graph slice: read-only inspection, approval pause/resume, deterministic report generation, and replayable completion.

## Reporting Issues

Please report suspected vulnerabilities privately to the maintainers. Do not include live credentials, private keys, tokens, sensitive production data, or exploit details in public issues.

For public issues, describe the affected command, policy setting, mission state, and expected safety behavior without sharing secrets.
