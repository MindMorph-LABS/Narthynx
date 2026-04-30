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
