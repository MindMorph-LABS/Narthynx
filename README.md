# Narthynx

Narthynx is a local-first Mission Agent OS.

An AI agent that runs missions, not chats. Persistent missions. Approval-gated actions. Replayable execution.

> The next SOTA agent is not a better chatbot. It is a mission runtime.

## Why Narthynx Exists

Most agent tools still treat serious work as a stream of chat messages and hidden tool calls. Narthynx is built around a different primitive: the durable **Mission**.

A mission is an inspectable unit of work with a goal, success criteria, plan graph, action ledger, checkpoints, approvals, artifacts, reports, and replayable execution history. Narthynx cannot guarantee perfect autonomous success. It makes agent work visible, resumable, approval-gated, and recoverable so users stay in control.

## Current Status

Narthynx has completed the Phase 0–15 MVP track described in `Narthynx_Codex_AGENTS.md` and `docs/roadmap.md` (including Mission Kit and Phase 15.5 interactive UX).

Implemented:

- TypeScript CLI foundation, tests, build tooling, and project metadata.
- Local `.narthynx/` workspace initialization and doctor checks.
- Durable mission creation, listing, opening, persistence, and state transitions.
- Append-only mission ledger and raw timeline view.
- Deterministic mission plan graph.
- Typed tool runner for filesystem, Git, report, shell, and model-adjacent workflows.
- Policy, risk classification, approval queue, checkpoints, and basic rewind.
- Markdown mission reports, ledger replay, and model/cost summaries.
- Interactive mission shell with status lines, slash commands, natural-language goals, `/graph`, `/mode`, and Mission Kit shortcuts (see `docs/cli-ux.md`).
- Approval-gated `shell.run` plus read-only `git.diff` and `git.log`.
- Stub-first model provider abstraction with optional OpenAI-compatible routing.
- Bounded mission executor vertical slice with read-only steps, approval pause/resume, final reports, and replay.
- Open-source polish docs, examples, templates, and release checklist.
- Phase 15 Mission Kit: templates, context diet (`context.md` / `context.json`), and local proof cards.

Narthynx intentionally fails honestly for behavior outside the current runtime. It does not pretend later-phase integrations exist.

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
- pnpm 10+

## Install

```bash
git clone https://github.com/MindMorph-LABS/Narthyx.git
cd Narthyx
pnpm install
pnpm build
pnpm test
```

## Quickstart

Primary usage: open the **interactive mission shell** once and work from there (natural-language goals, slash commands, and shortcuts). One-shot `narthynx <subcommand>` remains for scripting and CI.

```bash
pnpm narthynx
```

You should see the Narthynx intro, a status line, and a prompt such as `narthynx ❯`. Type a mission goal in plain language (no `/` prefix) to create a mission, or use `/help`.

Example session:

```txt
NARTHYNX
Local-first Mission Agent OS
...
Type a goal, or use /help.
Narthynx  mode: Ask  mission: none  state: none  policy: ask  model: auto
narthynx ❯ Prepare my launch checklist from this repo
```

Initialize a local workspace (required before missions):

```bash
pnpm narthynx init
pnpm narthynx doctor
```

Optional: open the **local web Mission Cockpit** (dashboard, graph, ledger, replay, approvals) on `http://127.0.0.1:17890` after the workspace is healthy. Run `pnpm narthynx cockpit` and sign in with the printed Bearer token. See [`docs/cockpit.md`](docs/cockpit.md) for security and LAN binding notes.

Show the full CLI surface:

```bash
pnpm narthynx --help
pnpm narthynx --version
```

After `pnpm narthynx init`, your repo contains:

```txt
.narthynx/
  config.yaml
  policy.yaml
  missions/
```

Create a mission:

```bash
pnpm narthynx mission "Prepare my launch checklist from this repo"
pnpm narthynx templates
pnpm narthynx mission --template bug-investigation
pnpm narthynx missions
pnpm narthynx open <mission-id>
pnpm narthynx plan <mission-id>
```

Run the bounded MVP executor:

```bash
pnpm narthynx run <mission-id>
```

The executor performs deterministic read-only inspection, then pauses before the approval-gated report artifact step:

```txt
Mission m_... is waiting for approval.
Run: narthynx approve a_...
Then: narthynx resume m_...
```

Approve or deny the gated action, then resume:

```bash
pnpm narthynx approve <approval-id>
pnpm narthynx resume <mission-id>
```

Inspect the durable outputs:

```bash
pnpm narthynx report <mission-id>
pnpm narthynx proof <mission-id>
pnpm narthynx replay <mission-id>
pnpm narthynx timeline <mission-id>
pnpm narthynx cost <mission-id>
```

## Interactive Mode

Running `pnpm narthynx` with no arguments opens the **interactive mission shell** (readline-based). See `docs/cli-ux.md` for the full intro, prompts, Windows notes, and slash reference.

Example:

```txt
NARTHYNX
Local-first Mission Agent OS
Persistent missions. Approval-gated actions. Replayable execution.
...
narthynx ❯
```

The same flow works with slash commands:

```txt
/mission "Prepare my launch checklist from this repo"
/templates
/mission --template bug-investigation
/plan
/graph
/run
/mode plan
/context --note "Remember the release blocker"
/context --file notes.md --reason "safe launch notes"
/tool filesystem.list --input '{"path":"."}'
/timeline
/approve
/resume
/report
/proof
/replay
/cost
/help
```

The `! <command>` shortcut requests approval for `shell.run`; it does not execute commands silently. `@ <path>` attaches safe file context to the current mission, and `# <note>` appends a mission context note (or `workspace-notes.md` when no mission is selected).

## Command Reference

```txt
narthynx                         open interactive mode
narthynx init                    create .narthynx workspace files
narthynx doctor                  check workspace health
narthynx mission <goal>          create a durable mission
narthynx missions                list missions
narthynx open <mission-id>       show mission details
narthynx plan <mission-id>       show or regenerate the plan
narthynx plan <mission-id> --model
narthynx run <mission-id>        start or continue the bounded executor
narthynx pause <mission-id>      pause a running or waiting mission
narthynx resume <mission-id>     continue a paused or waiting mission
narthynx approve <approval-id>   approve a pending action
narthynx approve <approval-id> --deny
narthynx timeline <mission-id>   show raw ledger events
narthynx replay <mission-id>     show the narrative mission story
narthynx report <mission-id>     generate or print the Markdown report
narthynx cost <mission-id>       summarize model and cost events
narthynx tools                   list typed tools
narthynx tool <mission-id> <tool-name> --input <json>
narthynx rewind <mission-id> <checkpoint-id>
```

## Architecture

```txt
src/
  agent/     model providers, routing, model planning, cost summaries, executor
  cli/       CLI entrypoint, interactive shell, slash commands, rendering
  config/    workspace defaults, YAML loading, init, doctor
  missions/  schema, store, ledger, graph, approvals, checkpoints, reports, replay
  tools/     typed tool definitions, registry, policy classification, runner
tests/       Vitest coverage for implemented phases
```

The ledger is the source of truth for timeline, replay, reports, approvals, tool outcomes, model calls, and cost summaries. Runtime behavior should go through typed services rather than writing hidden state directly.

## Safety Model

Narthynx is designed around these defaults:

- no irreversible action without explicit approval
- no credential access by default
- no raw shell execution
- no network by default
- no external communication without approval
- every tool call is logged
- approval outcomes are recorded
- high-risk writes are checkpointed where supported
- secrets are not sent to cloud models without explicit policy permission

Phase 13 executes only the deterministic MVP graph slice: local read-only inspection, approval-gated report artifact write, deterministic final report generation, and replayable completion. It does not perform autonomous shell execution, model-selected tools, external communication, or arbitrary writes.

## Model Providers

Model planning is explicit and local-first by default:

```bash
pnpm narthynx plan <mission-id> --model
```

Without provider environment variables, `--model` uses the deterministic `stub` provider and records zero-cost `model.called` and `cost.recorded` ledger events.

To opt into an OpenAI-compatible provider, set:

```bash
NARTHYNX_MODEL_PROVIDER=openai-compatible
NARTHYNX_OPENAI_BASE_URL=https://your-provider.example/v1
NARTHYNX_OPENAI_API_KEY=...
NARTHYNX_OPENAI_MODEL=...
```

Cloud model calls require `allow_network: true` in `policy.yaml`. Sensitive context is blocked or refused unless policy explicitly allows it, and secrets are not persisted to mission files.

## Visual Assets

Phase 14 reserves space for public launch visuals without faking them:

- `docs/assets/demo-flow-placeholder.md` describes the intended terminal GIF.
- `docs/assets/report-placeholder.md` describes the intended report screenshot.
- `docs/assets/replay-placeholder.md` describes the intended replay screenshot.

Replace these placeholders only with real captures from the documented quickstart flow.

## Examples

See:

- `examples/launch-checklist/`
- `examples/bug-investigation/`
- `examples/replay-and-report/`

Each example is local-first, copyable, and avoids secrets, network calls, destructive shell commands, and unsupported autonomy claims.

Phase 15 adds local Mission Kit primitives only: reusable mission templates, `context.md`/`context.json` context diet records, and local Markdown proof cards. It does not add browser automation, MCP, GitHub, hosted sync, external communication, or a web cockpit.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm pack --dry-run
```

Before opening a PR, run the relevant tests and update docs when behavior changes.

## Roadmap

Phase 15 Mission Kit and Phase 15.5 interactive shell UX are shipped. The MVP track through Phase 14 plus Mission Kit is complete. See `CHANGELOG.md` and `docs/roadmap.md`.

Post-MVP exploration:

- local web cockpit
- visual mission graph
- event-to-mission triggers
- browser connector
- MCP connector
- GitHub connector
- deeper context diet / memory engine
- cloud/local hybrid execution
- safe team collaboration
- encrypted mission vault

See `docs/roadmap.md` for the phase table.

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

Do not include live credentials, private keys, tokens, or sensitive production data in issues, tests, logs, examples, ledgers, reports, or replay output.

## License

Apache-2.0. See `LICENSE`.
