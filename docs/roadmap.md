# Roadmap

Narthynx is built in phases. Each phase must leave the repo runnable and testable, and later integrations must not jump ahead of the mission runtime.

## Current Status

- Phase 0: Complete
- Phase 1: Complete
- Phase 2: Next
- Phase 15: Post-MVP only

## Phases

| Phase | Name | Status | Goal |
| --- | --- | --- | --- |
| 0 | Repo Bootstrap | Complete | Create a clean open-source TypeScript project foundation |
| 1 | Workspace Init | Complete | Create local `.narthynx/` workspace with config, policy, missions folder, and doctor checks |
| 2 | Mission Schema and Store | Next | Create durable mission objects and persistence |
| 3 | Ledger | Planned | Add append-only event tracing |
| 4 | Plan Graph | Planned | Create visible mission plans |
| 5 | Tool System Foundation | Planned | Implement typed tools and tool execution wrapper |
| 6 | Policy, Risk, and Approval Gate | Planned | Prevent unsafe execution with approval queues |
| 7 | Filesystem Write and Checkpoints | Planned | Support approval-gated local writes and basic rewind |
| 8 | Report Generation | Planned | Generate mission reports as durable artifacts |
| 9 | Replay | Planned | Make missions replayable from the ledger |
| 10 | Interactive CLI/TUI | Planned | Create the mission-first interactive shell |
| 11 | Shell and Git Connectors | Planned | Add carefully gated shell and Git operations |
| 12 | Model Provider Abstraction | Planned | Prepare model routing without locking to one provider |
| 13 | Mission Executor Vertical Slice | Planned | Run the MVP flow end to end |
| 14 | Open-Source Polish | Planned | Prepare public repo quality, examples, docs, and release checklist |
| 15 | Post-MVP SOTA Extensions | Post-MVP only | Explore advanced extensions after the mission runtime is solid |

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

## Post-MVP Candidates

Do not start these before the MVP is complete:

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
