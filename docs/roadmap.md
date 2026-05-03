# Roadmap

Narthynx is built in phases. Each phase must leave the repo runnable and testable, and later integrations must not jump ahead of the mission runtime.

## Frontier vs connector phase IDs

Roadmap **phase numbers** 16–18 below describe **connector** deliverables (browser, MCP, GitHub).

**Frontier** build phases (daemon, companion, memory, etc.) use the numbering in [`AGENTS_APPENDIX_PHASE_16_30.md`](../AGENTS_APPENDIX_PHASE_16_30.md). When both appear in docs, use explicit labels—for example **Frontier F16 (daemon)** vs **Connector C16 (browser)**—to avoid confusion.

| Label | Docs | What it is |
| ----- | ---- | ----------- |
| **Frontier F16** | [`docs/daemon.md`](daemon.md), appendix | Always-on localhost daemon (queue, events, schedules) |
| **Frontier F17** | [`docs/companion.md`](companion.md) | Companion Mode (chat, memory proposals, mission handoff, reminders) |
| **Connector C16** | Phase 16 below, [`docs/connectors.md`](connectors.md) | Browser (Playwright) connector |
| **Connector C17** | Phase 17 below | MCP connector |
| **Connector C18** | Phase 18 below | GitHub REST connector |

## Current Status

- Phase 0: Complete
- Phase 1: Complete
- Phase 2: Complete
- Phase 3: Complete
- Phase 4: Complete
- Phase 5: Complete
- Phase 6: Complete
- Phase 7: Complete
- Phase 8: Complete
- Phase 9: Complete
- Phase 10: Complete
- Phase 11: Complete
- Phase 12: Complete
- Phase 13: Complete
- Phase 14: Complete
- Phase 15: Complete (context diet engine: `context-diet.yaml`, model context pack, ledger `context.pack_built`, planner wiring when `cloud_model_sensitive_context` is `allow` or `ask`; optional LLM summarization of context remains future work)
- Phase 15b (Hybrid inference): Partial — `model-routing.yaml`, loopback vs cloud policy, primary/fallback routing, mission budgets, `narthynx.model.sensitive_context` approvals, ledger routing metadata; hosted remote mission workers remain out of scope
- Phase 15c (Collaboration audit): Partial — `.narthynx/identity.yaml` or env actor env vars; ledger `details.actor` on approvals and user context notes; replay shows attribution; roles/sync remain future work
- Phase 15d (Encrypted mission vault): Complete — per-mission `vault/` store (AES-256-GCM, scrypt+HKDF), `narthynx vault` CLI, `vault.read` tool + `vault` policy, ledger `vault.secret_read` (redacted); see [`docs/vault.md`](vault.md)
- Phase 16 (Browser connector): Partial (typed Playwright tools shipped; session reuse / CDP are future work)
- Phase 17 (MCP connector): Partial — stdio client, `mcp.*` tools, policy + approvals; remote HTTP/SSE and mission-scoped session reuse are future work
- Phase 18 (GitHub connector): Partial — REST `github.*` tools, `github.yaml`, policy + spillover artifacts; GitHub Apps and GraphQL are future work
- **Frontier F16 (daemon):** Implemented — local process + lockfile, localhost API (`docs/daemon.md`), JSONL queue/events, schedules, CLI + slash commands; optional trigger → queue follow-up jobs
- **Frontier F17 (companion):** Implemented — policy `companion_mode`, JSONL companion store, `companion_chat` router task with strict JSON, interactive + `narthynx chat`, `/briefing` / `/remind` / `/mission-from-chat`, governed memory proposals, daemon reminder tick (`docs/companion.md`)
- **Frontier F19 (context kernel):** Implemented — `src/context/*` compiler, ledger `context.packet_logged`, artifacts under `artifacts/context-packets/`, CLI `narthynx context diet|inspect`, slash `/context why|diet`; see [`docs/context-kernel.md`](context-kernel.md). Semantic relevance stays keyword-heuristic only; richer summarization is deferred.

## Phases

| Phase | Name | Status | Goal |
| --- | --- | --- | --- |
| 0 | Repo Bootstrap | Complete | Create a clean open-source TypeScript project foundation |
| 1 | Workspace Init | Complete | Create local `.narthynx/` workspace with config, policy, missions folder, and doctor checks |
| 2 | Mission Schema and Store | Complete | Create durable mission objects and persistence |
| 3 | Ledger | Complete | Add append-only event tracing |
| 4 | Plan Graph | Complete | Create visible mission plans |
| 5 | Tool System Foundation | Complete | Implement typed tools and tool execution wrapper |
| 6 | Policy, Risk, and Approval Gate | Complete | Prevent unsafe execution with approval queues |
| 7 | Filesystem Write and Checkpoints | Complete | Support approval-gated local writes and basic rewind |
| 8 | Report Generation | Complete | Generate mission reports as durable artifacts |
| 9 | Replay | Complete | Make missions replayable from the ledger |
| 10 | Interactive CLI/TUI | Complete | Create the mission-first interactive shell |
| 11 | Shell and Git Connectors | Complete | Add carefully gated shell and Git operations |
| 12 | Model Provider Abstraction | Complete | Prepare model routing without locking to one provider |
| 13 | Mission Executor Vertical Slice | Complete | Run the MVP flow end to end |
| 14 | Open-Source Polish | Complete | Prepare public repo quality, examples, docs, issue templates, and release checklist |
| 15 | Mission Kit | Complete | Add templates, context diet basics, proof cards, and Phase 15.5 interactive shell UX |
| 15b | Hybrid inference (local/cloud models) | Partial | Optional `model-routing.yaml`, per-task routes and fallback, loopback-aware policy, sensitive cloud consent approvals, mission budgets |
| 15c | Collaboration audit | Partial | Optional `identity.yaml`, ledger actor on approvals and context `user.note`, replay attribution |
| 15d | Encrypted mission vault | Complete | Per-mission vault dir, CLI, `vault.read` + policy `vault`, redacted ledger |
| 16 | Browser connector (Playwright) | Partial | Typed `browser.*` tools, policy allowlist, approval + ledger, ephemeral sessions; install browsers via `pnpm exec playwright install` |
| 17 | MCP connector (stdio) | Partial | Typed `mcp.*` tools, `.narthynx/mcp.yaml`, policy + approvals, tool-list cache, spillover artifacts; stdio only in v1 |
| 18 | GitHub connector (REST) | Partial | Typed `github.*` tools, `.narthynx/github.yaml`, PAT via env, repo allowlists, spillover `github_api_response` artifacts |
| 16+ | Post-MVP SOTA Extensions | Post-MVP only | Deeper email/calendar, GitHub App + GraphQL, advanced browser/MCP transports (session reuse, CDP, remote MCP), and other connectors after runtime hardening |
| F17 | Frontier Companion | Complete | Conversational surface + approval-gated memory + mission handoff + daemon reminders (`docs/companion.md`) |
| F19 | Frontier Context Kernel | Complete | Inspectable compiled context (`ContextPacket`), ledger + artifacts, diet/diff tooling; see [`docs/context-kernel.md`](context-kernel.md) |

## MVP Success Definition

The first public demo is successful when this exact flow works:

1. User runs `narthynx`.
2. User creates a mission from a natural-language goal.
3. Narthynx creates a visible plan.
4. Narthynx executes safe local actions.
5. Narthynx pauses for a risky action.
6. User approves or denies.
7. Narthynx creates a final report.
8. User replays the mission timeline.

Phase 13 implements this bounded flow. Phase 14 makes it understandable and repeatable for new contributors.

## Post-MVP Candidates

Do not start these before the MVP is complete and stable:

- local web cockpit
- visual mission graph
- advanced browser/MCP transports (session reuse, CDP, remote MCP)
- GitHub App installs and GraphQL (beyond REST v1)
- safe team collaboration

**Phase 15b (in-tree, partial):** optional `.narthynx/model-routing.yaml`, environment fallback when the file is absent, loopback-aware policy, sensitive cloud consent, mission budgets, and ledger routing metadata. This is **local-orchestrated** hybrid inference only — not hosted mission sync or remote tool execution workers.

**Event-to-mission triggers** (declarative rules, Event Memory, GitHub webhook on the Cockpit) are documented in [`docs/triggers.md`](triggers.md). They create missions only; they do not replace typed connectors or auto-execute the executor. The **browser** (Phase 16), **MCP** (Phase 17), and **GitHub REST** (Phase 18) connectors are documented in [`docs/connectors.md`](connectors.md).

Post-MVP work must preserve the same invariants: local-first operation, durable state, typed tools, approval-gated risk, transparent ledgers, reports, and replay.
