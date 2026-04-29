# Narthynx

Narthynx is a local-first Mission Agent OS.

An AI agent that runs missions, not chats. Persistent missions. Approval-gated actions. Replayable execution.

> The next SOTA agent is not a better chatbot. It is a mission runtime.

## Why Narthynx Exists

Most agent tools still treat serious work as a stream of chat messages and hidden tool calls. Narthynx is built around a different primitive: the durable **Mission**.

A mission is an inspectable unit of work with a goal, success criteria, plan graph, action ledger, checkpoints, approvals, artifacts, reports, and replayable execution history. The product goal is useful autonomy that stays visible, resumable, approval-gated, and recoverable.

Narthynx cannot guarantee perfect autonomous success. It makes agent work visible, resumable, approval-gated, and recoverable so users stay in control.

## Current Status

Narthynx is in early MVP construction.

Implemented:

- Phase 0: TypeScript CLI bootstrap, tests, build tooling, and open-source project metadata.
- Phase 1: local `.narthynx/` workspace initialization and doctor checks.

Not implemented yet:

- Mission creation and persistence.
- Mission ledger and replay.
- Plan graph execution.
- Approval queue.
- Tool runner.
- Reports and artifacts.
- Interactive TUI.

The CLI intentionally fails honestly for commands that belong to later phases.

## What Narthynx Is

- A local-first mission runtime for agent work.
- A CLI-first system for durable, inspectable missions.
- A safety-oriented runtime where policy and approvals are core behavior.
- An open-source infrastructure project built in small, testable phases.

## What Narthynx Is Not

Narthynx is not:

- a generic chatbot
- an OpenClaw clone
- a coding-agent clone
- a browser-only automation tool
- a LangChain wrapper
- a skill marketplace
- an integration zoo
- an unsafe automation runner

## Requirements

- Node.js 20+
- pnpm

## Install

```bash
git clone https://github.com/MindMorph-LABS/Narthyx.git
cd Narthyx
pnpm install
pnpm build
pnpm test
```

## Quickstart

Show the CLI surface:

```bash
pnpm narthynx --help
pnpm narthynx --version
```

Initialize a local workspace:

```bash
pnpm narthynx init
```

This creates:

```txt
.narthynx/
  config.yaml
  policy.yaml
  missions/
```

Check workspace health:

```bash
pnpm narthynx doctor
```

In the current phase, mission runtime commands such as `mission`, `approve`, and `replay` are visible but intentionally not implemented.

## Workspace Files

`config.yaml` stores simple local workspace metadata:

```yaml
workspace_version: 1
created_by: narthynx
default_policy: policy.yaml
missions_dir: missions
```

`policy.yaml` starts with safe local-first defaults:

```yaml
mode: ask
allow_network: false
shell: ask
filesystem:
  read:
    - .
  write:
    - .
  deny:
    - .env
    - .env.*
    - "**/*secret*"
    - ~/.ssh/**
external_communication: block
credentials: block
cloud_model_sensitive_context: ask
```

Existing config and policy files are preserved by `narthynx init`.

## Safety Model

Narthynx is designed around these defaults:

- no irreversible action without explicit approval
- no credential access by default
- no shell execution without policy control
- no network by default in the MVP
- no external communication without approval
- every future tool call logged
- every future high-risk action checkpointed
- no secrets sent to cloud models without explicit policy permission

Phase 1 does not execute shell commands, perform network calls, read credentials, or write mission state. It only initializes and validates local workspace files.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Run the CLI from source:

```bash
pnpm narthynx --help
pnpm narthynx init
pnpm narthynx doctor
```

## Roadmap

The build follows the phased plan in `Narthynx_Codex_AGENTS.md`.

1. Phase 0: TypeScript CLI bootstrap.
2. Phase 1: Local `.narthynx/` workspace initialization.
3. Phase 2: Durable mission schema and store.
4. Phase 3: Append-only ledger.
5. Phase 4: Plan graph.
6. Phase 5: Typed tool foundation.
7. Phase 6: Policy, risk, and approval gate.
8. Phase 7: Safe filesystem writes and checkpoints.
9. Phase 8: Report generation.
10. Phase 9: Replay.
11. Phase 10: Interactive CLI/TUI.

The first public demo is successful when a user can create a mission, inspect its plan, execute safe local actions, pause for risky approval, approve or deny, generate a report, and replay the mission timeline.

## Project Structure

```txt
src/
  cli/       CLI entrypoint
  config/    workspace defaults, YAML loading, init, doctor
  agent/     future planner/executor/verifier modules
  missions/  future mission schema/store/ledger/graph modules
  safety/    future policy/risk/approval modules
  tools/     future typed tool implementations
tests/       Vitest coverage for implemented phases
```

## Contributing

See `CONTRIBUTING.md`.

Please keep contributions aligned with the mission-native product identity:

- preserve local-first behavior
- keep state human-readable and durable
- never fake completed actions
- do not weaken safety defaults
- add or update tests with each feature
- avoid post-MVP integrations until the mission runtime is solid

## Security

See `SECURITY.md`.

Do not include live credentials, private keys, tokens, or sensitive production data in issues, tests, logs, or examples.

## License

Apache-2.0. See `LICENSE`.
