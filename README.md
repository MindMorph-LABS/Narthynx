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
- Phase 2: durable mission creation, listing, opening, persistence, and state transitions.
- Phase 3: append-only mission ledger.
- Phase 4: deterministic mission plan graph.
- Phase 5: typed tool foundation for local reads, Git status, and report writes.
- Phase 6: policy, risk classification, and approval queue.
- Phase 7: approval-gated filesystem writes with checkpoints and basic rewind.
- Phase 8: deterministic Markdown mission reports as durable artifacts.
- Phase 9: replay rendering from the append-only ledger.
- Phase 10: dependency-free interactive shell with status lines and slash commands.
- Phase 11: approval-gated `shell.run` plus read-only `git.diff` and `git.log` connectors.
- Phase 12: model provider abstraction with deterministic stub mode, optional OpenAI-compatible routing, model ledger events, and cost summaries.

Not implemented yet:

- Mission graph execution.

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

Open interactive mode:

```bash
pnpm narthynx
```

Interactive mode starts a mission-first shell:

```txt
Narthynx  mode: Ask  mission: none  state: none  risk: none  model: stub
nx>
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

Create a mission and inspect its durable state:

```bash
pnpm narthynx mission "Prepare my launch checklist from this repo"
pnpm narthynx missions
pnpm narthynx open <mission-id>
pnpm narthynx plan <mission-id>
pnpm narthynx plan <mission-id> --model
pnpm narthynx timeline <mission-id>
```

Run safe diagnostic tools through the typed tool runner:

```bash
pnpm narthynx tools
pnpm narthynx tool <mission-id> filesystem.list --input "{\"path\":\".\"}"
```

Generate the mission report and replay the mission story:

```bash
pnpm narthynx report <mission-id>
pnpm narthynx replay <mission-id>
pnpm narthynx cost <mission-id>
```

Approval-gated writes are available through typed tools and must be explicitly approved before execution.

Inside interactive mode, use slash commands for the same durable runtime:

```txt
/mission "Prepare my launch checklist from this repo"
/plan
/tool filesystem.list --input '{"path":"."}'
/timeline
/report
/replay
/cost
/help
```

The `! <command>` shortcut requests approval for `shell.run`; it does not execute commands silently. Context attachment and mission memory shortcuts remain future-facing and print honest messages.

Read-only Git connectors are available through typed tools:

```bash
pnpm narthynx tool <mission-id> git.diff --input "{}"
pnpm narthynx tool <mission-id> git.log --input "{\"maxCount\":5}"
```

Model planning is explicit and local-first by default:

```bash
pnpm narthynx plan <mission-id> --model
```

Without provider environment variables, `--model` uses the deterministic `stub` provider and records zero-cost `model.called` and `cost.recorded` ledger events. To opt into an OpenAI-compatible provider, set:

```bash
NARTHYNX_MODEL_PROVIDER=openai-compatible
NARTHYNX_OPENAI_BASE_URL=https://your-provider.example/v1
NARTHYNX_OPENAI_API_KEY=...
NARTHYNX_OPENAI_MODEL=...
```

Cloud model calls require `allow_network: true` in `policy.yaml`. Sensitive context is blocked or refused unless policy explicitly allows it, and secrets are not persisted to mission files.

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

Current MVP phases do not read credentials, send external communications, or execute arbitrary shell commands. Local writes are routed through typed tools, approval gates, ledger events, and checkpoints.

Phase 11 includes local command execution only through approval-gated `shell.run` with `shell: false`, blocked metacharacters, blocked destructive patterns, workspace-bounded `cwd`, ledger events, and output artifacts.

Phase 12 keeps `stub` as the default model provider. Optional cloud model calls are disabled unless explicitly configured and allowed by policy.

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
12. Phase 11: Shell and Git connectors.
13. Phase 12: Model provider abstraction.
14. Phase 13: Mission executor vertical slice.

The first public demo is successful when a user can create a mission, inspect its plan, execute safe local actions, pause for risky approval, approve or deny, generate a report, and replay the mission timeline.

## Project Structure

```txt
src/
  agent/     model provider abstraction, router, model planning, cost summaries
  cli/       CLI entrypoint, interactive shell, slash commands, terminal rendering
  config/    workspace defaults, YAML loading, init, doctor
  missions/  mission schema, store, ledger, graph, approvals, checkpoints, reports, replay
  tools/     typed tool definitions, registry, policy classification, runner
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
