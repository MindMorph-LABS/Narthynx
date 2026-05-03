# Narthynx Companion (Frontier F17)

Frontier **Companion** is a conversational layer that **does not execute tools**. High-impact actions must become **missions**, then the normal executor, policy, and approval gates apply.

## Phase crosswalk

| Label | Docs | Notes |
| ----- | ---- | ----- |
| **Frontier F17** | This file | Companion chat, memory proposals, mission handoff, reminders |
| **Frontier F16** | [`daemon.md`](daemon.md) | Delivers time-based companion reminders on tick |
| **Connector C17** | Roadmap “Phase 17” | MCP connector — **not** the same as Frontier F17 |

## Modes (`policy.yaml`)

| Field | Values | Default | Meaning |
| ----- | ------ | ------- | ------- |
| `companion_mode` | `off` / `local_stub` / `model` | `local_stub` | `off` disables companion. `local_stub` uses the deterministic stub provider (CI-safe). `model` routes like other tasks via `.narthynx/model-routing.yaml` (respects `allow_network`). |
| `companion_cloud_context` | `block` / `ask` / `allow` | `block` | Posture when sensitive context accompanies companion calls (`companion_chat` router task); mirrors mission `cloud_model_sensitive_context` approvals when `ask`. |
| `companion_tools` | list of strings | `[]` | **Reserved.** Non-empty lists are rejected in v1 until governed read-only tools are wired. |

## Paths (`.narthynx/companion/`)

| Path | Purpose |
| ---- | ------- |
| `persona.yaml` | Voice + safety appendix (validated; defaults seeded on first load) |
| `meta.json` | Host mission pointer for ledger attribution |
| `sessions/<sessionId>/messages.jsonl` | Companion transcript (`CompanionMessage` JSON lines) |
| `suggestions.jsonl` | `MissionSuggestion` records |
| `memory/pending.jsonl` | Pending memory approvals |
| `memory/approved.jsonl` | Approved durable snippets surfaced to the model envelope |
| `reminders.jsonl` | Scheduled reminders consumed by **daemon ticks** |
| `artifacts/` | Optional briefing markdown |
| Companion host mission | Stored under missions — **`mission.yaml`** + ledger receive `model.called` for companion turns |

## CLI & interactive

- **Standalone loop:** `narthynx chat` (alias `narthynx companion`), optional `-m` one-shot, `-s` session id.
- **Integrated shell:** `/companion` toggles conversational surface (`narthynx cmp ❯`). `/companion mission` returns.
- **`/briefing`** — aggregates missions + approved memory (+ optional `--write` artifact path).
- **`/mission-from-chat`** — drafts from transcript (`draft`), converts latest companion suggestion (`accept`), or snapshots transcript as a mission (`materialize`).
- **`/remind +5 …`** or ISO8601 schedules a reminder persisted under `reminders.jsonl`. Delivery uses the **daemon foreground tick** (`notify` + `companion.reminder.delivered` event). If daemon is absent, reminders stay pending — CLI prints an explicit notice.
- **`# remember:`** while companion surface active → queued memory proposal (approve via `/memory approve <id>`).

## Guardrails

- Companion code paths **never** import `tools/runner` / call `shell.run`, writes, MCP, browser, vault, etc.
- Model output must be strict JSON `{ reply, suggestMission?, proposeMemory? }`. Extra keys are rejected (fail-closed to a safe plaintext explanation).
- System prompts disallow consciousness claims / emotional manipulation and steer high-risk domains toward professionals.

See also: [`daemon.md`](daemon.md) reminder delivery, [`cli-ux.md`](cli-ux.md) interactive shortcuts.
