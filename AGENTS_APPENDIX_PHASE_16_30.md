# AGENTS_APPENDIX_PHASE_16_30.md — Narthynx Frontier Build Rules

This appendix extends the root `AGENTS.md` after Phase 15. Codex must not start these phases until the MVP mission runtime works end to end.

## Frontier phases

- Phase 16: Always-On Daemon
- Phase 17: Personal Assistant / Companion Mode
- Phase 18: Persistent Evolving Memory OS
- Phase 19: Frontier Context Kernel
- Phase 20: Bounded Expert Subagents
- Phase 21: Frontier Tool System
- Phase 22: Event-to-Mission Engine
- Phase 23: Verification Lattice
- Phase 24: Agent Social Safety Layer
- Phase 25: Cost Sovereignty Engine
- Phase 26: Web Mission Cockpit
- Phase 27: Daily Tools and Personal Mission Templates
- Phase 28: OpenClaw Bridge
- Phase 29: Team / Multi-User Mission Runtime
- Phase 30: Narthynx v1.0 Full Agent OS Integration

## Non-negotiable rules

1. Preserve the mission-runtime identity.
2. Keep core local-first.
3. Never silently execute high-risk actions.
4. Never bypass the policy engine.
5. Never send sensitive context to cloud models without explicit policy approval.
6. Every tool call must be ledgered.
7. Every high-risk action must be checkpointed.
8. Every mission completion must pass verification or report partial/failure honestly.
9. Subagents must be bounded by role, budget, tools, and scope.
10. Companion Mode must not execute real actions directly; it must create missions.
11. Event-to-Mission must create mission drafts, not silent external actions.
12. Cost must be visible and controllable.
13. Memory must be inspectable, editable, and deletable.
14. Web Cockpit must use the same mission store, ledger, and policy engine as CLI.
15. Do not claim Narthynx never makes mistakes; make mistakes visible, reversible, and recoverable.

## Phase 16+ success definition

Narthynx becomes a full local-first Agent OS only when it supports:

```txt
always-on daemon
companion conversation
persistent governed memory
context kernel
bounded expert subagents
frontier tool system
event-to-mission
verification lattice
agent social safety
cost sovereignty
web cockpit
daily mission templates
OpenClaw bridge
team runtime
```

But all of that must remain grounded in the core primitive:

```txt
mission + graph + checkpoints + approvals + artifacts + replay
```
