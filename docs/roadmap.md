# Roadmap

Narthynx is built in phases. Each phase must leave the repo runnable and testable, and later integrations must not jump ahead of the mission runtime.

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
- Phase 15: Complete

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
| 16+ | Post-MVP SOTA Extensions | Post-MVP only | Explore advanced connectors and cockpit features after Mission Kit primitives |

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
- browser connector
- MCP connector
- GitHub connector
- local model routing
- cloud/local hybrid execution
- safe team collaboration
- encrypted mission vault

**Event-to-mission triggers** (declarative rules, Event Memory, GitHub webhook on the Cockpit) are documented in [`docs/triggers.md`](triggers.md). They create missions only; they do not replace typed connectors or auto-execute the executor.

Post-MVP work must preserve the same invariants: local-first operation, durable state, typed tools, approval-gated risk, transparent ledgers, reports, and replay.
