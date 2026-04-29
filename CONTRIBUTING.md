# Contributing to Narthynx

Narthynx is built in small, testable phases. Contributions should preserve the mission-native product identity and keep the project runnable after every change.

## Local Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Contribution Rules

- Preserve local-first behavior.
- Do not hide failures or fake completed actions.
- Do not weaken safety defaults.
- Add or update tests with each feature.
- Prefer explicit schemas and durable, human-readable state.
- Keep runtime behavior aligned with `Narthynx_Codex_AGENTS.md`.

## Phase Discipline

Do not jump to post-MVP integrations before the mission runtime works. The current roadmap prioritizes workspace init, mission schema, ledger, plan graph, typed tools, approvals, reports, replay, and then interactive UX.
