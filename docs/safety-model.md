# Safety Model

Safety is core product behavior in Narthynx. The goal is useful autonomy that remains local-first, inspectable, approval-gated, and recoverable.

## Safety Defaults

Narthynx must not weaken these defaults:

- no irreversible action without explicit approval
- no credential access by default
- no shell execution in Auto Mode
- no network by default in the MVP
- no external communication without approval
- every tool call must be logged
- every approval must be recorded
- every high-risk action must have a checkpoint
- no secrets should be sent to cloud models without explicit policy permission
- `.env`, SSH keys, token files, and credential stores must not be read unless a future explicit vault workflow exists

## Risk Levels

| Risk | Meaning | Required behavior |
| --- | --- | --- |
| Low | Read-only or harmless local context gathering | Allow and log |
| Medium | Creates local artifacts or runs non-destructive commands | Ask in strict mode, allow in trusted mode |
| High | Modifies important files, runs shell, sends messages, or uses network | Require approval and checkpoint |
| Critical | Credentials, destructive data changes, production config, or irreversible external actions | Block by default or require explicit typed confirmation |

High-risk actions must never run silently.

## Policy Modes

```txt
safe       -> read-only, no shell, no write, no network
ask        -> ask before medium/high risk
trusted    -> allow low/medium in workspace, ask high
approval   -> ask before every non-trivial action
```

No policy mode may allow high-risk actions silently.

## Default Policy

The default policy is local-first and conservative:

```yaml
mode: ask
allow_network: false
shell: ask
filesystem:
  read:
    - "."
  write:
    - "."
  deny:
    - ".env"
    - ".env.*"
    - "**/*secret*"
    - "~/.ssh/**"
external_communication: block
credentials: block
cloud_model_sensitive_context: ask
```

## Approval Prompt Format

Approval prompts must be explicit and copyable:

```txt
Action requires approval: filesystem.write
Mission: launch-readiness-review
Risk: High - local file modification
Target: ./LAUNCH_CHECKLIST.md

Options:
[a] approve once
[e] edit proposal
[d] deny
[p] pause mission
```

All approval outcomes must be written to the mission ledger.

## Blocked By Default

The MVP blocks or approval-gates behavior that can leave the local workspace or cause irreversible effects:

- credential access
- network access
- raw shell execution; typed `shell.run` is approval-gated and uses `shell: false`
- external communication
- production configuration changes
- destructive filesystem changes
- reading known secret-like files
- sending sensitive local context to cloud models

Future features may add more typed workflows for some of these actions, but only with explicit policy, approval, ledger, and honest rollback/checkpoint behavior.

## Shell And Git Connectors

Phase 11 shell and Git connectors preserve the same safety contract:

- `shell.run` is typed, approval-gated, uses `shell: false`, blocks command chaining and shell metacharacters, rejects known destructive patterns, and bounds `cwd` to the workspace.
- `git.diff` and `git.log` are read-only. They should report repository failures honestly instead of fabricating clean output.
- Shell output is captured as mission artifacts and ledger events. Shell actions are not treated as reversible.

## Model Providers

Phase 12 adds model routing without weakening local-first defaults:

- `stub` is the default provider and never uses network or API keys.
- OpenAI-compatible providers are opt-in through environment variables only.
- Networked model calls require `allow_network: true`.
- Sensitive context is blocked or refused unless `cloud_model_sensitive_context: allow` is set.
- API keys are read from environment variables and must not be written to ledgers, reports, replay output, or mission files.
- Every successful model call records `model.called` and `cost.recorded` events so `/cost`, reports, and replay remain transparent.

## Executor Boundary

Phase 13 runs only the deterministic MVP graph slice. It may use read-only local tools, request approval for the report artifact step, resume after approval or denial, and complete with a deterministic report.

It must not run arbitrary shell commands, choose tools from model output, send external communication, call networks, or write arbitrary user files.

## Public Documentation Boundary

Phase 14 examples and public docs must preserve the safety model:

- no live secrets, tokens, private keys, or production data
- no destructive commands
- no fake screenshots or fabricated outputs
- no unsupported autonomy claims
- no instructions that bypass policy, approvals, ledgers, reports, or replay

## Phase 15 Mission Kit Safety

Mission templates, context diet, and proof cards are local-only. Context file attachment uses the same workspace path guard and policy deny patterns as safe filesystem reads, so `.env`, SSH keys, token-like files, and paths outside the workspace remain blocked.

Proof cards are local Markdown artifacts. They are not hosted share links and do not send mission state externally.
