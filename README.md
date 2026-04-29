# Narthynx

Narthynx is a local-first Mission Agent OS.

An AI agent that runs missions, not chats. Persistent missions. Approval-gated actions. Replayable execution.

## What Narthynx Is

Narthynx turns serious human goals into durable missions with explicit goals, success criteria, plan graphs, action ledgers, checkpoints, approvals, artifacts, reports, and replayable execution history.

The project is currently in Phase 0: repository and CLI bootstrap.

## What Narthynx Is Not

Narthynx is not a generic chatbot, browser-only automation tool, coding-agent clone, LangChain wrapper, skill marketplace, integration zoo, or unsafe automation runner.

## Install

Requirements:

- Node.js 20+
- pnpm

```bash
pnpm install
pnpm build
pnpm test
```

## Phase 0 Quickstart

```bash
pnpm narthynx --help
pnpm narthynx --version
pnpm narthynx init
```

In Phase 0, `--help` and `--version` work. Runtime commands such as `init`, `mission`, `approve`, and `replay` are visible but intentionally fail with an honest Phase 0 placeholder message.

## Safety Thesis

Narthynx is designed around local-first operation, transparent actions, approval before risk, durable state, and replayable execution. The MVP must not perform shell execution, external communication, network access, credential access, or local writes without the appropriate future policy and approval gates.

Narthynx cannot guarantee perfect autonomous success. It makes agent work visible, resumable, approval-gated, and recoverable so users stay in control.

## Roadmap

The build follows the phased plan in `Narthynx_Codex_AGENTS.md`:

1. Phase 0: TypeScript CLI bootstrap.
2. Phase 1: Local `.narthynx/` workspace initialization.
3. Phase 2: Durable mission schema and store.
4. Phase 3+: Ledger, plan graph, typed tools, approval gates, reports, replay, and interactive CLI.

## Contributing

See `CONTRIBUTING.md`.
