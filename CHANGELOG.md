# Changelog

## 0.1.0

- Bootstrap Phase 0 TypeScript CLI foundation.
- Add local workspace initialization, doctor checks, durable mission store, state transitions, and mission listing/opening.
- Add append-only ledgers, deterministic plan graphs, typed tools, policy classification, approvals, checkpoints, and basic rewind.
- Add report generation, replay rendering, and raw timeline views.
- Add Phase 10 interactive shell with status lines, slash commands, current-mission context, and scripted tests.
- Add Phase 11 approval-gated `shell.run` plus read-only `git.diff` and `git.log` connectors with output artifacts.
- Add Phase 12 model provider abstraction with deterministic stub provider, optional OpenAI-compatible routing, model ledger events, and cost summaries.
- Add Phase 13 bounded mission executor with read-only steps, approval pause/resume, final reports, and replayable completion.
- Add Phase 14 open-source polish: public docs, examples, GitHub templates, release checklist, and package metadata.
- Add Phase 15 Mission Kit: templates, context diet (`context.md` / `context.json`), proof cards, and Phase 15.5 interactive terminal UX (NL-first shell, renderer abstraction, `/graph`, `/mode`, workspace notes, sensitive-path guard for `@`).
- Add local web Mission Cockpit (`narthynx cockpit`): Hono API, Vite/React dashboard (missions, graph, ledger, replay, report, approvals), Bearer token auth, default loopback bind, optional LAN mode; see `docs/cockpit.md`.
