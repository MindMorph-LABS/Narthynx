# AGENTS.md — Narthynx

## Purpose of this file

This file is the operating instruction document for Codex or any AI coding agent working inside the Narthynx repository.

Codex must use this file as the highest-priority project guide after system/developer instructions. Preserve the product thesis, architecture, safety model, build phases, and acceptance criteria while implementing the project end to end.

---

# 0. Product Identity

## Name

**Narthynx**

## Category

**Local-first Mission Agent OS**

## Core thesis

> The next SOTA agent is not a better chatbot. It is a mission runtime.

Narthynx turns messy human goals into persistent, inspectable, resumable, approval-gated missions.

## Main positioning

Narthynx is an open-source local-first agent runtime where every serious task becomes a durable **Mission** with a goal, success criteria, plan graph, action ledger, checkpoints, approvals, artifacts, reports, and replayable execution history.

## Do not change this identity

Narthynx is **not**:

- a generic chatbot
- an OpenClaw clone
- a skill marketplace
- a coding-agent clone
- a browser-only automation tool
- a LangChain wrapper
- a random tool-calling demo
- an integration zoo
- an unsafe automation runner

Narthynx must remain a **mission-native agent OS**.

---

# 1. Product Standard

Build Narthynx as if it will become a serious open-source infrastructure project.

Every implementation decision should optimize for:

1. **Local-first operation**
2. **Durable mission state**
3. **Transparent actions**
4. **Human approval before risk**
5. **Replayable execution**
6. **Good terminal UX**
7. **Typed tools and schemas**
8. **Open-source maintainability**
9. **Testability**
10. **Extensibility without overengineering**

Never hide failures. Never fake completion. Never pretend actions happened if they did not.

---

# 2. Core Primitive: Mission

Every serious task must create or update a **Mission** object.

A Mission is a durable unit of work, not a chat message.

## Required Mission fields

Every Mission must support at least:

```ts
type MissionState =
  | "created"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "verifying"
  | "failed"
  | "recovering"
  | "completed"
  | "cancelled";

type RiskLevel = "low" | "medium" | "high" | "critical";

interface Mission {
  id: string;
  title: string;
  goal: string;
  successCriteria: string[];
  context: MissionContext;
  planGraph: PlanGraph;
  state: MissionState;
  riskProfile: RiskProfile;
  checkpoints: Checkpoint[];
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  ledger: LedgerEvent[];
  createdAt: string;
  updatedAt: string;
}
```

## Mission lifecycle

Implement this direction:

```txt
created -> planning -> running -> verifying -> completed
running -> waiting_for_approval -> running
running -> failed -> recovering -> running
running -> paused -> running
any -> cancelled
```

All transitions must be persisted.

If the process crashes, Narthynx must be able to resume from the last persisted safe state.

---

# 3. Required Local Workspace

Use a readable local workspace.

Default workspace:

```txt
.narthynx/
  config.yaml
  policy.yaml
  narthynx.db
  missions/
    <mission-id>/
      mission.yaml
      graph.json
      ledger.jsonl
      context.md
      approvals.json
      artifacts/
        report.md
        outputs/
        diffs/
        screenshots/
      checkpoints/
        checkpoint_001.json
```

## Rules

- Keep important state inspectable by humans.
- Use SQLite for queryable state when implemented.
- Also write human-readable artifacts to mission folders.
- Use append-only ledger JSONL for traceability.
- Do not store secrets in mission files.

---

# 4. CLI/TUI Product Experience

Narthynx should feel like a polished Claude Code-style CLI, but mission-first.

The terminal experience should be fast, keyboard-native, clean, and alive.

## Required modes

Implement or design toward:

```txt
Plan Mode       -> propose mission graph before acting
Observe Mode    -> read/inspect only
Auto Mode       -> execute low-risk actions only
Approval Mode   -> pause for every non-trivial action
Safe Mode       -> no shell/network/external writes
```

## Required slash commands

Interactive mode must support these eventually:

```txt
/mission      create or switch mission
/missions     list missions
/plan         show/edit current plan
/graph        show mission graph/tree
/timeline     show action ledger
/approve      show approval queue
/pause        pause current mission
/resume       resume mission
/rewind       restore checkpoint
/cost         show token/cost summary
/policy       inspect/change policy mode
/tools        list tools/connectors
/doctor       health checks
/help         command reference
```

## Shell-like shortcuts

Design toward:

```txt
! <command>     run local shell command through typed shell tool and attach output
@ <path>        add file/folder to mission context
# <note>        add note to workspace or mission memory
```

Do not implement unsafe raw shell execution. `!` must route through the typed shell tool and approval policy.

---

# 5. Required CLI Commands

Minimum external CLI commands:

```bash
narthynx
narthynx init
narthynx mission "Prepare my launch checklist from this repo"
narthynx missions
narthynx open <mission-id>
narthynx approve <approval-id>
narthynx pause <mission-id>
narthynx resume <mission-id>
narthynx replay <mission-id>
narthynx doctor
```

Post-MVP:

```bash
narthynx graph <mission-id>
narthynx timeline <mission-id>
narthynx report <mission-id>
narthynx policy
narthynx tools
narthynx cost <mission-id>
```

---

# 6. Architecture

Use TypeScript for the first implementation unless the repository already chose another language.

Recommended stack:

```txt
Runtime: Node.js 20+
Language: TypeScript
CLI: commander or cac
TUI: ink or blessed/react-blessed, or a clean Rich-like terminal output layer
DB: SQLite
Config: YAML
Validation: zod
Tests: vitest
Lint/format: eslint + prettier
Package manager: pnpm preferred
```

## Recommended repo structure

```txt
narthynx/
  README.md
  LICENSE
  CONTRIBUTING.md
  SECURITY.md
  CODE_OF_CONDUCT.md
  package.json
  tsconfig.json
  docs/
    mission-spec.md
    safety-model.md
    cli-ux.md
    connectors.md
    roadmap.md
  src/
    cli/
      index.ts
      interactive.ts
      slash-commands.ts
      renderer.ts
    daemon/
      server.ts
      event-bus.ts
      scheduler.ts
    agent/
      intent-compiler.ts
      planner.ts
      executor.ts
      verifier.ts
      recovery.ts
      model-router.ts
    missions/
      schema.ts
      store.ts
      graph.ts
      state-machine.ts
      checkpoints.ts
      ledger.ts
      artifacts.ts
    tools/
      types.ts
      filesystem.ts
      shell.ts
      git.ts
      report-writer.ts
      browser-stub.ts
      mcp-stub.ts
    safety/
      risk-classifier.ts
      approval-gate.ts
      policy.ts
      sandbox.ts
      secrets.ts
    memory/
      workspace-memory.ts
      mission-memory.ts
      context-diet.ts
    reports/
      markdown.ts
      json.ts
      proof-card.ts
    config/
      load.ts
      defaults.ts
    utils/
      ids.ts
      fs.ts
      logger.ts
  examples/
    launch-checklist/
    folder-organizer/
    bug-investigation/
  tests/
```

If a simpler structure exists, do not rewrite everything. Evolve it toward this architecture.

---

# 7. Mission Graph Runtime

The mission graph is the SOTA core.

Do not implement Narthynx as a plain loop of messages and tool calls.

## Required node types

```ts
type MissionNodeType =
  | "research"
  | "action"
  | "approval"
  | "verification"
  | "recovery"
  | "handoff"
  | "artifact";
```

## Node meanings

| Node type | Purpose |
|---|---|
| `research` | gather information from files, logs, docs, or connectors |
| `action` | perform a typed tool operation |
| `approval` | pause until human accepts/rejects an action |
| `verification` | check whether success criteria are met |
| `recovery` | fallback step after failure |
| `handoff` | ask the user to manually perform a step |
| `artifact` | create a durable output |

## Durability rule

Every graph transition must be recorded **before and after** execution.

On crash, resume from the last safe persisted step.

---

# 8. Action, Tool, and Connector System

All capabilities must be typed tools.

A tool is not prompt magic.

Each tool action must define:

```ts
interface ToolAction<Input, Output> {
  name: string;
  description: string;
  inputSchema: ZodSchema<Input>;
  outputSchema: ZodSchema<Output>;
  riskLevel: RiskLevel;
  sideEffect: "none" | "local_read" | "local_write" | "shell" | "network" | "external_comm" | "credential";
  requiresApproval: boolean;
  reversible: boolean;
  run(input: Input, context: ToolContext): Promise<Output>;
}
```

## MVP tools

Implement first:

```txt
filesystem.list
filesystem.read
filesystem.write    approval-gated
shell.run           approval-gated
git.status
git.diff
git.log
report.write
```

## Post-MVP tools

```txt
browser connector
email/calendar connectors
MCP connector
GitHub connector
local web cockpit connector
```

Do not build post-MVP connectors before the mission runtime works.

---

# 9. Safety Model

Safety is not optional.

Narthynx exists to make useful autonomy controllable.

## Safety defaults

Never violate these defaults:

- no irreversible action without explicit approval
- no credential access by default
- no shell execution in Auto Mode
- no network by default in MVP
- no external communication without approval
- every tool call must be logged
- every approval must be recorded
- every high-risk action must have a checkpoint
- no secrets should be sent to cloud models without explicit policy permission
- do not read `.env`, SSH keys, token files, or credential stores unless a future explicit vault workflow exists

## Risk levels

| Risk | Meaning | Required behavior |
|---|---|---|
| Low | read-only or harmless local context gathering | allow and log |
| Medium | creates local artifacts or runs non-destructive commands | ask in strict mode, allow in trusted mode |
| High | modifies important files, runs shell, sends messages, uses network | require approval + checkpoint |
| Critical | credentials, destructive data changes, production config, irreversible external actions | block by default or require explicit typed confirmation |

## Approval prompt

Approval prompts must be clear:

```txt
Action requires approval: filesystem.write
Mission: launch-readiness-review
Risk: High — local file modification
Target: ./LAUNCH_CHECKLIST.md

Options:
[a] approve once
[e] edit proposal
[d] deny
[p] pause mission
```

All approval outcomes must be written to the ledger.

---

# 10. Policy System

The policy system controls behavior.

Default policy file:

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

Policy modes:

```txt
safe       -> read-only, no shell, no write, no network
ask        -> ask before medium/high risk
trusted    -> allow low/medium in workspace, ask high
approval   -> ask before every non-trivial action
```

Do not implement a policy mode that allows high-risk actions silently.

---

# 11. Ledger and Replay

Every mission must have an append-only ledger.

## Ledger event types

```ts
type LedgerEventType =
  | "mission.created"
  | "mission.state_changed"
  | "plan.created"
  | "plan.updated"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "tool.requested"
  | "tool.approved"
  | "tool.denied"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "checkpoint.created"
  | "artifact.created"
  | "model.called"
  | "cost.recorded"
  | "user.note"
  | "error";
```

## Replay command

`narthynx replay <mission-id>` must show:

```txt
1. Mission created
2. Plan generated
3. Files inspected
4. Report draft proposed
5. Approval requested
6. User approved
7. File written
8. Mission completed
```

Do not ship without replay in the MVP.

---

# 12. Checkpoints and Rewind

High-risk actions require checkpoints.

MVP checkpoint can be simple:

- save mission state before action
- save file snapshots for modified files
- save approval request and action payload
- save graph position

`/rewind` and `narthynx resume` should restore the mission to an earlier safe state where feasible.

If full file rollback is not implemented yet, be honest in the UI:

```txt
Checkpoint restored for mission state. File rollback is not implemented for this action.
```

Never pretend rollback happened if it did not.

---

# 13. Model Router

Use a provider abstraction.

Do not hardcode one provider across the whole system.

## Model tasks

Route different task types:

| Task | Suggested route |
|---|---|
| intent classification | cheap/local model or deterministic parser |
| planning | strong reasoning model |
| file summarization | cheap/mid model |
| tool argument drafting | model + schema validation |
| risk classification | deterministic + model fallback |
| final report | user-selected or default model |

## Cost tracking

Every model call must record:

- provider
- model
- purpose
- input tokens if available
- output tokens if available
- estimated cost if available
- latency
- whether sensitive context was included

`/cost` must summarize per mission eventually.

For MVP, implement a stub model provider so local development works without API keys.

---

# 14. Context and Memory

Do not dump everything into context.

Implement a context discipline.

## Memory layers

```txt
Workspace Memory  -> project-specific notes and facts
Mission Memory    -> state and extracted context for one mission
Event Memory      -> external events and outcomes later
Learning Notes    -> recurring failure patterns later
```

## Context Diet

Design toward:

- summarize stale branches
- avoid repeatedly sending same files
- show why a file/log was added to context
- estimate context size per mission
- track context saved by compression later

MVP can implement:

- `context.md` per mission
- append file summaries
- simple token/character counts

---

# 15. Reports and Artifacts

Every completed mission should generate a Markdown report.

Default report path:

```txt
.narthynx/missions/<mission-id>/artifacts/report.md
```

Report must include:

- mission title
- goal
- success criteria
- final status
- plan summary
- actions performed
- approvals requested and outcomes
- files/artifacts created
- risks encountered
- failures/recoveries
- limitations
- next recommended actions

Do not mark mission complete without an artifact report unless the user cancelled or explicitly disabled reports.

---

# 16. Claude Code-Inspired UX Guidelines

Narthynx must feel premium in terminal.

## UX principles

- clear status bar
- concise live updates
- slash commands always available
- readable approval prompts
- visible mission state
- no noisy logs unless verbose/debug mode
- graceful interruption with Ctrl+C
- never lose mission state on interruption
- color is okay, but do not depend on color alone
- all important output must be copyable text

## Example status line

```txt
Narthynx  mode: Ask  mission: launch-readiness-review  state: running  risk: medium  model: auto
```

## Example plan UI

```txt
Plan for mission m_001: launch-readiness-review

1. Inspect project structure                         pending
2. Read README, package scripts, deployment notes    pending
3. Identify missing launch assets                    pending
4. Draft launch checklist                            pending
5. Ask approval before writing files                 approval
```

---

# 17. Phased Build Plan

Codex must implement Narthynx in phases. Do not jump to later phases before earlier phases are working.

Each phase should leave the repo in a runnable, testable state.

---

## Phase 0 — Repo Bootstrap

### Goal

Create a clean open-source TypeScript project foundation.

### Build

- `package.json`
- `tsconfig.json`
- `src/` structure
- CLI entrypoint
- test setup
- lint/format config
- README placeholder
- MIT or Apache-2.0 license
- basic `narthynx --help`

### Acceptance

```bash
pnpm install
pnpm build
pnpm test
pnpm narthynx --help
```

All must pass.

---

## Phase 1 — Workspace Init

### Goal

Create local `.narthynx/` workspace.

### Build

- `narthynx init`
- config loader
- default `config.yaml`
- default `policy.yaml`
- mission directory creation
- health check skeleton

### Acceptance

`narthynx init` creates:

```txt
.narthynx/
  config.yaml
  policy.yaml
  missions/
```

`narthynx doctor` reports workspace status.

---

## Phase 2 — Mission Schema and Store

### Goal

Create durable mission objects.

### Build

- mission ID generator
- mission schema with zod
- mission state machine
- mission file store
- `narthynx mission "goal"`
- `narthynx missions`
- `narthynx open <id>`

### Acceptance

User can create a mission and list/open it after process restart.

Tests must cover:

- mission creation
- state transition validation
- persistence
- invalid state rejection

---

## Phase 3 — Ledger

### Goal

Add append-only event tracing.

### Build

- `ledger.jsonl`
- ledger writer
- ledger reader
- event types
- mission creation event
- state transition events
- `narthynx timeline <id>` or `narthynx open <id>` timeline section

### Acceptance

Every mission has a ledger.

Restarting the process does not lose ledger history.

Tests must cover append and read behavior.

---

## Phase 4 — Plan Graph

### Goal

Create visible mission plans.

### Build

- `graph.json`
- plan graph schema
- simple deterministic planner for MVP
- `narthynx plan <id>`
- plan nodes: research/action/approval/artifact
- graph persistence

### MVP planner behavior

For a generic mission, produce a safe plan:

```txt
1. Understand goal
2. Inspect workspace
3. Gather relevant context
4. Propose artifact/action
5. Request approval before writing
6. Generate final report
```

### Acceptance

Mission creation generates or can generate a plan graph.

Plan graph is human-readable and persisted.

---

## Phase 5 — Tool System Foundation

### Goal

Implement typed tools.

### Build

- tool interface
- tool registry
- tool execution wrapper
- risk metadata
- output validation
- tool ledger events

### MVP tools

- `filesystem.list`
- `filesystem.read`
- `git.status`
- `report.write`

### Acceptance

Tool calls are typed, validated, and logged.

No tool should bypass the tool runner.

---

## Phase 6 — Policy, Risk, and Approval Gate

### Goal

Prevent unsafe execution.

### Build

- policy loader
- risk classifier
- approval request schema
- approval queue
- approval ledger events
- `narthynx approve <approval-id>`
- `/approve` later for TUI

### Acceptance

Medium/high-risk action creates approval request instead of executing.

Denied actions are logged and not executed.

Approved actions can continue execution.

---

## Phase 7 — Filesystem Write and Checkpoints

### Goal

Support safe local writes.

### Build

- `filesystem.write`
- checkpoint creation before write
- approval gate before write
- artifact/file snapshot for rollback where feasible
- `narthynx rewind <mission-id> <checkpoint-id>` basic support

### Acceptance

Writing a file requires approval in default policy.

Mission ledger records:

- tool requested
- approval requested
- approved/denied
- checkpoint created
- file written

---

## Phase 8 — Report Generation

### Goal

Every mission can produce a final report.

### Build

- Markdown report generator
- report artifact registration
- `narthynx report <id>`
- automatic report at completion

### Acceptance

Report includes goal, plan, actions, approvals, artifacts, risks, failures, and limitations.

---

## Phase 9 — Replay

### Goal

Make missions replayable.

### Build

- `narthynx replay <id>`
- timeline renderer
- state/action/approval/artifact replay

### Acceptance

Replay shows the mission story from ledger.

No hidden action should be missing from replay.

---

## Phase 10 — Interactive CLI/TUI

### Goal

Create Claude Code-inspired interactive shell.

### Build

- `narthynx` launches interactive mode
- status bar
- prompt loop
- slash command parser
- `/mission`
- `/missions`
- `/plan`
- `/timeline`
- `/approve`
- `/policy`
- `/doctor`
- `/help`

### Acceptance

User can run the MVP flow inside interactive mode:

1. create mission
2. view plan
3. inspect timeline
4. approve action
5. generate report
6. replay mission

---

## Phase 11 — Shell and Git Connectors

### Goal

Add carefully-gated command execution.

### Build

- `shell.run`
- `git.diff`
- `git.log`
- command allow/deny patterns
- approval requirement for shell
- command output capture
- output truncation and artifact logging

### Safety

Shell execution must never run silently in Auto Mode.

Dangerous commands must be blocked or require typed confirmation.

Examples to block by default:

```txt
rm -rf
del /s
format
shutdown
curl | sh
Invoke-WebRequest ... | iex
sudo
chmod -R 777
```

### Acceptance

Shell commands are approval-gated, logged, and captured.

---

## Phase 12 — Model Provider Abstraction

### Goal

Prepare real agent intelligence without locking to one model.

### Build

- model provider interface
- stub provider
- OpenAI-compatible provider optional
- model call ledger events
- cost tracker skeleton
- `/cost`

### Acceptance

Narthynx can run deterministic/stub mission flows without API keys.

If provider env vars exist, planner can use model for better plan generation.

---

## Phase 13 — Mission Executor Vertical Slice

### Goal

Make the mission run end to end.

### Build

- simple executor for plan graph
- execute read-only steps
- pause on approval steps
- resume after approval
- complete mission
- generate report

### Acceptance

Viral MVP flow works:

1. User starts Narthynx CLI.
2. User creates a mission from a natural-language goal.
3. Narthynx creates a visible plan.
4. Narthynx executes safe local actions.
5. Narthynx pauses for a risky action.
6. User approves or denies.
7. Narthynx creates a final report.
8. User replays the mission timeline.

---

## Phase 14 — Open-Source Polish

### Goal

Prepare public repo quality.

### Build

- README with screenshots/GIF placeholders
- CONTRIBUTING.md
- SECURITY.md
- CODE_OF_CONDUCT.md
- examples
- docs:
  - `docs/mission-spec.md`
  - `docs/safety-model.md`
  - `docs/cli-ux.md`
  - `docs/connectors.md`
- GitHub issue templates
- release checklist

### Acceptance

A new contributor can install, run, create a mission, and understand the architecture.

---

## Phase 15 — Post-MVP SOTA Extensions

Do not start these before MVP is complete.

### Candidate extensions

- local web cockpit
- visual mission graph
- event-to-mission triggers
- browser connector
- MCP connector
- GitHub connector
- mission templates
- proof cards
- context diet engine
- local model routing
- cloud/local hybrid execution
- safe team collaboration
- encrypted mission vault

---

# 18. SOTA Feature Requirements

These features define the future of Narthynx. Keep architecture ready for them, but build incrementally.

## Mission Graph Runtime

Persistent graph of steps, branches, approvals, recoveries, and artifacts.

## Reversible Autonomy

Classify every action by reversibility and gate risk.

## Mission Replay

Replay step-by-step what happened.

## Context Diet

Measure and reduce wasted context.

## Operator Handoff

Ask user to take over CAPTCHAs, logins, payments, ambiguous UI, or high-risk steps.

## Event-to-Mission Engine

Turn emails, deploy failures, GitHub issues, calendar conflicts, and customer complaints into missions later.

## Policy Sandbox

Run tools inside bounded local workspaces with permissions and approval gates.

## Mission Templates

Reusable mission blueprints, not generic skills.

Examples:

```txt
launch-readiness-review
bug-investigation
invoice-follow-up-draft
research-brief
folder-organizer
deployment-failure-triage
```

## Failure Memory

Store why a mission failed and how it recovered.

## Proof Cards

Generate shareable mission summaries with actions, outcomes, risks, and artifacts.

---

# 19. Testing Requirements

Use tests seriously.

## Required tests by module

| Module | Required tests |
|---|---|
| mission schema | valid/invalid objects |
| state machine | allowed/blocked transitions |
| store | create/read/update/restart durability |
| ledger | append/read/order |
| graph | node creation/transitions |
| policy | default deny/ask behavior |
| approval | create/approve/deny |
| tools | schema validation + risk metadata |
| report | generated markdown contains required sections |
| replay | ledger renders correctly |

Do not ship a phase without relevant tests.

---

# 20. Error Handling Rules

Never hide failures.

Every error should have:

- what failed
- why it likely failed
- what was attempted
- whether state was saved
- what the user can do next

Bad:

```txt
Something went wrong.
```

Good:

```txt
Mission m_001 paused because filesystem.write requires approval under policy mode "ask".
Run: narthynx approve a_123
```

---

# 21. Security Requirements

## Must-have

- Do not read credentials by default.
- Do not execute shell commands without approval.
- Do not write files without approval in default mode.
- Do not perform network calls in MVP.
- Do not send sensitive local files to model providers unless policy allows it.
- Redact secrets in logs where possible.
- Warn if `.env`, SSH keys, tokens, or credential-like files appear in requested context.

## Secret detection patterns

Implement basic detection for:

```txt
.env
.env.*
id_rsa
id_ed25519
*.pem
*.key
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
GITHUB_TOKEN
DATABASE_URL
```

---

# 22. Documentation Requirements

Every major feature must have a doc.

Minimum docs:

```txt
docs/mission-spec.md
docs/safety-model.md
docs/cli-ux.md
docs/connectors.md
docs/roadmap.md
```

README must include:

- what Narthynx is
- what it is not
- install
- quickstart
- example mission
- safety model
- roadmap
- contribution guide link

---

# 23. Open-Source Quality Bar

Narthynx should look like a serious open-source project.

Required files:

```txt
README.md
LICENSE
CONTRIBUTING.md
SECURITY.md
CODE_OF_CONDUCT.md
CHANGELOG.md
AGENTS.md
```

## License

Prefer Apache-2.0 if patent/IP protection matters, otherwise MIT.

## Public messaging

Use these lines:

```txt
Narthynx is a local-first Mission Agent OS.
An AI agent that runs missions, not chats.
Persistent missions. Approval-gated actions. Replayable execution.
```

Do not overclaim perfect autonomy.

Use honest limitation:

```txt
Narthynx cannot guarantee perfect autonomous success. It makes agent work visible, resumable, approval-gated, and recoverable so users stay in control.
```

---

# 24. MVP Success Definition

The first public demo is successful if this exact flow works:

1. User runs `narthynx`.
2. User creates a mission from a natural-language goal.
3. Narthynx creates a visible plan.
4. Narthynx executes safe local actions.
5. Narthynx pauses for a risky action.
6. User approves or denies.
7. Narthynx creates a final report.
8. User replays the mission timeline.

If this works, Narthynx has proven its core primitive.

---

# 25. Anti-Goals

Do not build these before the MVP:

- WhatsApp integration
- Telegram integration
- Gmail integration
- calendar integration
- full browser automation
- hosted cloud sync
- team collaboration
- skill marketplace
- marketplace/store
- complex vector database RAG
- 20 model providers
- production deploy automation
- autonomous external communication

These can come later only after the mission runtime is solid.

---

# 26. Codex Operating Rules

When working on this repo:

1. Read this file first.
2. Make a short implementation plan before large changes.
3. Implement in small vertical slices.
4. Keep the project runnable after each phase.
5. Add or update tests with each feature.
6. Preserve local-first behavior.
7. Preserve mission-runtime identity.
8. Do not silently weaken safety defaults.
9. Do not introduce cloud/network dependencies into MVP.
10. Prefer explicit schemas over loose objects.
11. Prefer append-only ledger records over hidden state.
12. Prefer readable artifacts over opaque database-only state.
13. Do not remove documentation unless replacing it with better docs.
14. Never mark a feature complete if acceptance criteria are not met.

---

# 27. Immediate Next Task for Codex

If the repo is empty, start with **Phase 0** and **Phase 1**.

If the repo already has a skeleton, inspect it, then continue from the earliest incomplete phase.

Do not skip mission schemas, workspace initialization, ledger, or safety model. These are the core.

---

# 28. Final Reminder

Narthynx should feel like the beginning of a new agent category.

Not:

```txt
chat + tools
```

But:

```txt
mission + graph + checkpoints + approvals + artifacts + replay
```

That is the product.
